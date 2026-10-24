"""The current run's tools, with the same ownership contract as agent-langgraph.

Computer/UI tools finish the run for the surface to execute and resume. Only tools
marked by OpenBot's server execute here, through its signed callback. The request
context is deliberately outside graph state: assertions must never enter a
checkpoint, model message, or AG-UI state snapshot.
"""

import asyncio
import os
from contextlib import aclosing
from contextvars import ContextVar
from dataclasses import dataclass, field

import httpx
from ag_ui.core import Context, EventType, RunAgentInput, RunErrorEvent, Tool
from langchain_core.messages import SystemMessage, ToolMessage
from langgraph.graph import END

from .model_override import UnreadableSelectionError
from .parallel_tools import ParallelToolAgent
from .prompt_budget import left_out_note, narrow


@dataclass(frozen=True)
class RunTools:
    tools: tuple[Tool, ...] = ()
    context: tuple[Context, ...] = ()
    deployment: frozenset[str] = frozenset()
    assertion: str = field(default="", repr=False)
    connection: dict = field(default_factory=dict, compare=False, repr=False)


_current: ContextVar[RunTools | None] = ContextVar("openbot_run_tools", default=None)


def current_tools() -> RunTools:
    return _current.get() or RunTools()


class UnofferedToolError(ValueError):
    pass


def lift_leading_system_turns(
    messages: list,
) -> tuple[list, tuple[Context, ...]]:
    """Take the system turns at the head of a run out of its messages, as context.

    THE INTEGRATION THROWS THE FIRST SYSTEM MESSAGE AWAY. `ag_ui_langgraph` drops `messages[0]`
    when it is a system message (`langgraph_default_merge_state`), on the assumption that the graph
    brings its own prompt. OpenBot's server sends the coworker's standing role there: who it is, its
    title, its instructions, its team and the rule about naming where an answer came from. Left in
    the messages, every coworker on this harness was told nothing about itself, said it had no title
    and no colleagues, and answered as a generic assistant, whatever model it ran on.

    Context is the one channel the integration does not touch and the answer node already reads
    (`model_messages`), and it stays outside graph state, so a role edited between two runs is the
    role the next run carries instead of a copy a checkpoint remembered.
    """
    lifted: list[Context] = []
    index = 0
    while index < len(messages) and getattr(messages[index], "role", None) == "system":
        content = getattr(messages[index], "content", "")
        if isinstance(content, str) and content.strip():
            lifted.append(Context(description="", value=content))
        index += 1
    return messages[index:], tuple(lifted)


class ToolAwareAgent(ParallelToolAgent):
    async def run(self, input: RunAgentInput):
        props = input.forwarded_props if isinstance(input.forwarded_props, dict) else {}
        names = props.get("openbotDeploymentTools", [])
        assertion = props.get("openbotRun", "")
        messages, standing = lift_leading_system_turns(list(input.messages or []))
        context = RunTools(
            tools=tuple(input.tools or []),
            # The standing role first: it is who the coworker is, and what the surface adds is about
            # the screen it is on.
            context=(*standing, *tuple(input.context or [])),
            deployment=frozenset(name for name in names if isinstance(name, str))
            if isinstance(names, list)
            else frozenset(),
            assertion=assertion if isinstance(assertion, str) else "",
        )
        # The maintained endpoint clones this subclass per request. ContextVar
        # also isolates graph tasks across concurrent requests and resets on
        # cancellation. Current input.tools is authoritative; checkpoint/state
        # tools must not resurrect an offer removed by the caller.
        token = _current.set(context)
        try:
            clean_props = {
                key: value
                for key, value in props.items()
                if key
                not in {
                    "openbotRun",
                    "openbotDeploymentTools",
                    "openbot_run",
                    "openbot_deployment_tools",
                }
            }
            async with aclosing(
                super().run(
                    input.model_copy(
                        update={"forwarded_props": clean_props, "messages": messages}
                    )
                )
            ) as stream:
                async for event in stream:
                    if event.type == EventType.RUN_ERROR and context.connection.get(
                        "authentication_failed"
                    ):
                        event = event.model_copy(
                            update={"code": "OPENBOT_MODEL_AUTH_REQUIRED"}
                        )
                    yield event
        except UnofferedToolError:
            yield RunErrorEvent(
                type=EventType.RUN_ERROR,
                message="The model requested a tool that was not offered for this run.",
            )
        except UnreadableSelectionError as error:
            yield RunErrorEvent(type=EventType.RUN_ERROR, message=str(error))
        except Exception:
            if not context.connection.get("authentication_failed"):
                raise
            yield RunErrorEvent(
                type=EventType.RUN_ERROR,
                message="Sign in to your model provider again.",
                code="OPENBOT_MODEL_AUTH_REQUIRED",
            )
        finally:
            _current.reset(token)


def model_messages(messages, left_out=()):
    """Pass AG-UI application context to the model without checkpointing it.

    The maintained integration carries context separately from messages. Our
    graph uses MessagesState, so its answer node must explicitly include the
    current catalog/guidelines instead of silently discarding them.

    ONE SYSTEM MESSAGE, THE COWORKER'S OWN ROLE FIRST. This used to be one message per entry, so a
    model was sent the role, what the coworker holds and the screen's catalogs as separate system
    turns. Some OpenAI-compatible providers read only the first of several, and a small model gives
    most weight to whatever comes first; a free-plan model answered as the provider's own assistant,
    with the role it had been sent somewhere behind a catalog. The standing role is first in
    `current_tools().context` (`ToolAwareAgent.run`), so joining in order keeps it first.
    """
    parts = [
        f"{entry.description}\n{entry.value}" if entry.description else entry.value
        for entry in current_tools().context
    ]
    if left_out:
        parts.append(left_out_note(left_out))
    return [
        *([SystemMessage(content="\n\n".join(parts))] if parts else []),
        *messages,
    ]


def lean_tools(messages):
    """The tools to offer on this turn and the names left out; see `prompt_budget`."""
    run = current_tools()
    return narrow(run.tools, run.deployment, messages)


def with_single_types(schema):
    """A JSON Schema with every list of types reduced to its first type that is not "null".

    Gemma 4's chat template formats tool parameters with a Jinja `map` filter that the bundled
    llama.cpp does not implement, so one `"type": ["string", "null"]` anywhere made every request to
    the model on this computer fail with HTTP 500. Same rule as `shared/tool-schema.ts`.
    """
    if isinstance(schema, list):
        return [with_single_types(item) for item in schema]
    if not isinstance(schema, dict):
        return schema
    out = {}
    for key, value in schema.items():
        if key == "type" and isinstance(value, list):
            named = [item for item in value if isinstance(item, str)]
            out[key] = next((item for item in named if item != "null"), named[0] if named else "string")
        else:
            out[key] = with_single_types(value)
    return out


def bind_tools(model, tools=None):
    tools = current_tools().tools if tools is None else tools
    if not tools:
        return model
    # The desktop writes the window only for the model it runs on this computer.
    local = bool((os.environ.get("BOT_CONTEXT_TOKENS") or "").strip())
    return model.bind_tools(
        [
            {
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": with_single_types(tool.parameters)
                    if local
                    else tool.parameters,
                },
            }
            for tool in tools
        ]
    )


def next_step(state):
    calls = state["messages"][-1].tool_calls
    if not calls:
        return END
    context = current_tools()
    offered = {tool.name for tool in context.tools}
    if any(call["name"] not in offered for call in calls):
        raise UnofferedToolError(
            "The model requested a tool that was not offered for this run."
        )
    # Mixed turns yield too: never invent results for a UI component or execute
    # a governed action while the surface still owns an unanswered call.
    if any(call["name"] not in context.deployment for call in calls):
        return END
    return "tools"


def _refusal_reason(response):
    """The deployment's own reason for a callback it would not run, or nothing.

    `/api/agent-tools/call` refuses with the reason under `error`, and the model can only tell the
    person why, or correct a malformed call, if it is told. Read here rather than inside the
    callback's error handler, so a body that is not JSON costs the reason and not the refusal.
    """
    try:
        body = response.json()
    except ValueError:
        return ""
    error = body.get("error") if isinstance(body, dict) else None
    return f" {error.strip()}" if isinstance(error, str) and error.strip() else ""


async def _call_tool(call, context):
    async def result():
        token = (os.environ.get("AGENT_TOOL_TOKEN") or "").strip()
        if not token:
            return (
                "Refused. This Bot has no credential for calling tools through its deployment.",
                True,
            )
        if not context.assertion:
            return (
                "Refused. This run carried no signed statement of which Bot and person it is for.",
                True,
            )
        url = (
            os.environ.get("OPENBOT_TOOL_URL")
            or "http://127.0.0.1:3001/api/agent-tools/call"
        )
        try:
            # Redirects must never carry this deployment's credential elsewhere.
            async with httpx.AsyncClient(timeout=30, follow_redirects=False) as client:
                response = await client.post(
                    url,
                    headers={"x-openbot-agent-token": token},
                    json={
                        "name": call["name"],
                        "args": call["args"],
                        "run": context.assertion,
                    },
                )
            if not response.is_success:
                return (
                    f"Refused. Tool callback returned HTTP {response.status_code}."
                    f"{_refusal_reason(response)}",
                    True,
                )
            body = response.json()
            if not isinstance(body, dict) or not isinstance(body.get("text"), str):
                return "The tool callback returned no readable result.", True
            return body["text"], False
        except (httpx.HTTPError, ValueError):
            # Exception strings can contain URLs. Report the boundary, never its
            # credential-bearing request or response. CancelledError propagates.
            return "The tool callback could not be completed.", True

    text, failed = await result()
    return ToolMessage(
        content=text,
        tool_call_id=call["id"],
        name=call["name"],
        status="error" if failed else "success",
    )


async def execute_tools(state):
    context = current_tools()
    # Recheck ownership at the execution boundary as well as the graph edge.
    if next_step(state) != "tools":
        raise ValueError(
            "This turn must return to the surface before tools can execute."
        )
    results = await asyncio.gather(
        *[_call_tool(call, context) for call in state["messages"][-1].tool_calls]
    )
    return {"messages": results}
