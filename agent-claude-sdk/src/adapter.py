"""Keep client tools inside their original Claude SDK query.

ag-ui-claude-sdk 0.1.5 returns a placeholder from its MCP tool, then sends
the client's real result as a new user prompt. A synchronous PostToolUse hook
replaces that placeholder before Claude sees it. AG-UI requests consume
segments of the same running SDK query, resolving hooks by tool-use ID.
"""

import asyncio
from contextlib import suppress
from contextvars import ContextVar
from dataclasses import dataclass, field

import ag_ui_claude_sdk.adapter as upstream
from ag_ui.core import EventType, RunErrorEvent, RunFinishedEvent, RunStartedEvent
from ag_ui_claude_sdk import ClaudeAgentAdapter
from ag_ui_claude_sdk.utils import convert_agui_tool_to_claude_sdk as client_tool
from claude_agent_sdk import AssistantMessage, HookMatcher, tool as sdk_tool
from claude_agent_sdk.types import StreamEvent

from .deployment import (
    call_deployment_tool,
    client_tool_names,
    deployment_tool_names,
    instructions,
    run_statement,
    with_instructions,
)


class ModelAuthenticationError(Exception):
    pass


@dataclass
class _ClientBoundary:
    tool_ids: set[str]


@dataclass
class _Turn:
    tool_names: set[str]
    queue: asyncio.Queue = field(default_factory=asyncio.Queue)
    results: dict[str, asyncio.Future] = field(default_factory=dict)
    offered: set[str] = field(default_factory=set)
    ended: set[str] = field(default_factory=set)
    announced: set[str] = field(default_factory=set)
    delivered: set[str] = field(default_factory=set)
    task: asyncio.Task | None = None
    cancelled: bool = False
    authentication_failed: bool = False

    def result(self, tool_id):
        if tool_id not in self.results:
            self.results[tool_id] = asyncio.get_running_loop().create_future()
        return self.results[tool_id]


@dataclass
class _Building:
    """Whose tools are being built, so a tool of the deployment's can find its way back to it."""

    adapter: "OpenBotClaudeAgentAdapter"
    thread_id: str
    deployment: frozenset[str]


_building: ContextVar[_Building | None] = ContextVar("openbot_building", default=None)


def _convert_tool(tool_def):
    """The upstream conversion makes every offered tool a stub for the browser to run.

    A tool the deployment runs is made real instead: calling it asks the deployment, with the signed
    statement of the run that is happening NOW. The statement is read when the tool is called and not
    when it is built, because a session lives across many runs and each carries a fresh one.
    """
    name = (
        tool_def.get("name")
        if isinstance(tool_def, dict)
        else getattr(tool_def, "name", "")
    )
    building = _building.get()
    if building is None or name not in building.deployment:
        return client_tool(tool_def)
    description = (
        tool_def.get("description", "")
        if isinstance(tool_def, dict)
        else getattr(tool_def, "description", "")
    )
    parameters = (
        tool_def.get("parameters")
        if isinstance(tool_def, dict)
        else getattr(tool_def, "parameters", None)
    )

    @sdk_tool(name, description or "", parameters or {})
    async def deployment_tool(args):
        text, failed = await call_deployment_tool(
            name,
            args if isinstance(args, dict) else {},
            building.adapter.statement_for(building.thread_id),
        )
        return {"content": [{"type": "text", "text": text}], "is_error": failed}

    return deployment_tool


# `ag-ui-claude-sdk` 0.1.5 looks the conversion up by name in its own module, so this is the one place
# that can change it. The version is pinned in requirements.txt, and a test builds a tool through it.
upstream.convert_agui_tool_to_claude_sdk = _convert_tool


class OpenBotClaudeAgentAdapter(ClaudeAgentAdapter):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._turns: dict[str, _Turn] = {}
        self._segment_locks: dict[str, asyncio.Lock] = {}
        # The signed statement of each thread's current run, for the deployment's tools to hand back.
        self._statements: dict[str, str] = {}
        # What each thread's session has already been told, so a changed instruction is sent once.
        self._told: dict[str, set[tuple[str, str]]] = {}

    def statement_for(self, thread_id):
        return self._statements.get(thread_id, "")

    def build_options(self, input_data=None, thread_id=None):
        token = _building.set(
            _Building(
                adapter=self,
                thread_id=thread_id,
                deployment=deployment_tool_names(input_data),
            )
            if input_data
            else None
        )
        try:
            options = super().build_options(input_data, thread_id)
        finally:
            _building.reset(token)
        if input_data:
            # The role, the team and what it keeps in mind: see deployment.py for why they are not sent.
            options.system_prompt = with_instructions(options.system_prompt, input_data)
            self._told[thread_id] = {
                (entry[0], entry[1]) for entry in instructions(input_data)
            }
        tool_names = client_tool_names(input_data)

        async def client_result(input_data, tool_use_id, context):
            turn = self._turns.get(thread_id)
            name = input_data.get("tool_name", "")
            if name.removeprefix("mcp__ag_ui__") not in tool_names:
                return {}
            if turn is None or turn.cancelled:
                raise asyncio.CancelledError("The client tool query was cancelled")
            if not tool_use_id:
                raise RuntimeError("Claude did not identify the pending client tool")
            # The hook can arrive before the event consumer has seen TOOL_CALL_START.
            # Both paths use the SDK ID; names/arguments cannot disambiguate parallel calls.
            content = await turn.result(tool_use_id)
            return {
                "hookSpecificOutput": {
                    "hookEventName": "PostToolUse",
                    # At PostToolUse the CLI has removed the MCP response
                    # envelope. Replacement is tool_result.content itself.
                    "updatedMCPToolOutput": [{"type": "text", "text": content}],
                }
            }

        options.hooks = {
            **(options.hooks or {}),
            "PostToolUse": [
                *(options.hooks or {}).get("PostToolUse", []),
                HookMatcher(
                    matcher="mcp__ag_ui__.*",
                    hooks=[client_result],
                    timeout=(self._query_timeout_seconds or 300) + 10,
                ),
            ],
        }
        return options

    async def _run_query(self, input_data):
        async for event in super().run(input_data):
            yield event

    async def _stream_claude_sdk(
        self, message_stream, thread_id, run_id, input_data, frontend_tool_names
    ):
        # Preserve upstream text, reasoning, state, tool and snapshot translation,
        # but do not abandon the SDK stream when a client tool is emitted.
        async def messages():
            streaming = False
            async for message in message_stream:
                if (
                    isinstance(message, AssistantMessage)
                    and message.error == "authentication_failed"
                ):
                    turn = self._turns.get(thread_id)
                    if turn:
                        turn.authentication_failed = True
                    raise ModelAuthenticationError(
                        "Anthropic refused the API key. Check it and try again."
                    )
                if (
                    isinstance(message, StreamEvent)
                    and message.event.get("type") == "message_start"
                ):
                    streaming = True
                yield message
                complete = isinstance(message, AssistantMessage) and not streaming
                if (
                    isinstance(message, StreamEvent)
                    and message.event.get("type") == "message_stop"
                ):
                    streaming = False
                    complete = True
                if complete:
                    turn = self._turns[thread_id]
                    ready = turn.ended - turn.announced
                    if ready:
                        turn.announced.update(ready)
                        await turn.queue.put(_ClientBoundary(ready))

        async for event in super()._stream_claude_sdk(
            messages(), thread_id, run_id, input_data, set()
        ):
            yield event

    async def _pump(self, input_data, turn):
        try:
            async for event in self._run_query(input_data):
                if event.type == EventType.RUN_ERROR and turn.authentication_failed:
                    event = event.model_copy(
                        update={"code": "OPENBOT_MODEL_AUTH_REQUIRED"}
                    )
                if (
                    event.type == EventType.TOOL_CALL_START
                    and event.tool_call_name in turn.tool_names
                ):
                    turn.offered.add(event.tool_call_id)
                    turn.result(event.tool_call_id)
                if (
                    event.type == EventType.TOOL_CALL_END
                    and event.tool_call_id in turn.offered
                ):
                    turn.ended.add(event.tool_call_id)
                await turn.queue.put(event)
        except Exception as error:
            await turn.queue.put(
                RunErrorEvent(
                    message=str(error),
                    code="OPENBOT_MODEL_AUTH_REQUIRED"
                    if isinstance(error, ModelAuthenticationError)
                    else None,
                )
            )
        finally:
            # Cancellation/timeout must never substitute a made-up successful result.
            # Upstream reports a query timeout without stopping its SDK worker.
            # Stop the CLI before cancelling hooks, which otherwise leave that
            # separate process waiting for a callback response that will never arrive.
            stop_worker = not turn.cancelled and any(
                not result.done() for result in turn.results.values()
            )
            if stop_worker:
                turn.cancelled = True
                await super().interrupt(input_data.thread_id)
            for result in turn.results.values():
                if not result.done():
                    result.cancel()
            if stop_worker:
                with suppress(asyncio.CancelledError):
                    await super().clear_session(input_data.thread_id)
            await turn.queue.put(None)

    async def run(self, input_data):
        thread_id, run_id = input_data.thread_id, input_data.run_id
        lock = self._segment_locks.setdefault(thread_id, asyncio.Lock())
        async with lock:
            self._statements[thread_id] = run_statement(input_data)
            input_data = self._with_new_instructions(input_data)
            turn = self._turns.get(thread_id)
            if turn is not None and turn.task.done():
                self._turns.pop(thread_id)
                turn = None

            yield RunStartedEvent(thread_id=thread_id, run_id=run_id)
            if turn is not None:
                incoming = {
                    message.tool_call_id: message.content
                    for message in input_data.messages
                    if message.role == "tool"
                    and message.tool_call_id in turn.delivered
                    and not turn.result(message.tool_call_id).done()
                }
                if not incoming:
                    yield RunErrorEvent(
                        message="This Claude query is waiting for its client tool result; no matching tool-use ID was supplied."
                    )
                    return
                for tool_id, content in incoming.items():
                    turn.result(tool_id).set_result(content)
                # Parallel client tools may return in separate HTTP requests.
                if any(not turn.result(tool_id).done() for tool_id in turn.delivered):
                    yield RunFinishedEvent(thread_id=thread_id, run_id=run_id)
                    return
            else:
                if input_data.messages and input_data.messages[-1].role == "tool":
                    yield RunErrorEvent(
                        message="The Claude query for this tool result is no longer running. Start a new message."
                    )
                    return
                turn = _Turn(tool_names=client_tool_names(input_data))
                self._turns[thread_id] = turn
                turn.task = asyncio.create_task(self._pump(input_data, turn))

            released = False
            try:
                while True:
                    event = await turn.queue.get()
                    if event is None:
                        raise RuntimeError(
                            "Claude query ended without a terminal event"
                        )
                    if isinstance(event, _ClientBoundary):
                        turn.delivered.update(event.tool_ids)
                        released = True
                        yield RunFinishedEvent(thread_id=thread_id, run_id=run_id)
                        return
                    if event.type == EventType.RUN_STARTED:
                        continue
                    # The SDK query keeps its original run ID internally; each HTTP
                    # continuation is nevertheless a new AG-UI run to its consumer.
                    update = {"run_id": run_id, "thread_id": thread_id}
                    yield event.model_copy(update=update)
                    if event.type in (EventType.RUN_FINISHED, EventType.RUN_ERROR):
                        released = True
                        await turn.task
                        self._turns.pop(thread_id, None)
                        return
            finally:
                if not released:
                    await self.interrupt(thread_id)

    def _with_new_instructions(self, input_data):
        """Put an instruction the session has not heard in front of this run's message.

        The session's system prompt is fixed when it starts, but the deployment's instructions are not:
        somebody picks a skill, or a memory is kept, and a new system turn arrives in the middle of the
        conversation. Claude is told only the last message of a run, so one that is not repeated there is
        never heard. It rides in front of the person's message, once, the first time it appears.
        """
        told = self._told.get(input_data.thread_id)
        messages = input_data.messages or []
        if told is None or not messages or messages[-1].role != "user":
            return input_data
        last = messages[-1]
        if not isinstance(last.content, str):
            return input_data
        fresh = [entry for entry in instructions(input_data) if entry[:2] not in told]
        if not fresh:
            return input_data
        told.update(entry[:2] for entry in fresh)
        said = "\n\n".join(entry[2] for entry in fresh)
        content = (
            "Your instructions have changed. From now on, also follow this:\n\n"
            f"{said}\n\n---\n\n{last.content}"
        )
        return input_data.model_copy(
            update={"messages": [*messages[:-1], last.model_copy(update={"content": content})]}
        )

    async def interrupt(self, thread_id=None):
        threads = [thread_id] if thread_id else list(self._turns)
        for current in threads:
            turn = self._turns.get(current)
            if turn is None:
                continue
            turn.cancelled = True
            await super().interrupt(current)
            for result in turn.results.values():
                if not result.done():
                    result.cancel()
            turn.task.cancel()
            with suppress(asyncio.CancelledError):
                await turn.task
            with suppress(asyncio.CancelledError):
                await super().clear_session(current)
            self._turns.pop(current, None)

    async def shutdown(self):
        await self.interrupt()
        await super().shutdown()
        self._segment_locks.clear()
        self._statements.clear()
        self._told.clear()
