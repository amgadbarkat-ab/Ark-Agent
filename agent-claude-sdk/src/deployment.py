"""What the deployment gives a framework Bot that `ag-ui-claude-sdk` does not carry.

Two things, both of which the default LangGraph Bot has and this one did not.

THE STANDING ROLE. The deployment sends who the Bot is, who its colleagues are, what it keeps in mind
and what it is connected to as system messages at the front of every run. The adapter reads only the
LAST message of a run, as the prompt, and leaves the Claude session to hold the rest, so those system
messages never reached Claude: it answered as a general assistant that had never heard of its role,
and told the person it could not talk to other digital employees because nothing said it could.

THE DEPLOYMENT'S TOOLS. A tool such as `team_ask` or `memory_save` runs on the deployment, where the
grant, the policy and the audit row are. The deployment lists those names under
`forwarded_props.openbotDeploymentTools`; every other tool in `input.tools` is the browser's to run.
The adapter treated them all as the browser's, so a call to `team_ask` was handed to a window that has
never heard of it. The names are read here and the call is made back to the deployment, signed with
the statement of this run, exactly as the LangGraph Bot does it.
"""

import hashlib
import os

import httpx

TOOL_URL = "http://127.0.0.1:3001/api/agent-tools/call"

# The model needs no more of a refusal than its first sentence, and an unbounded body is not its to read.
_REASON_LIMIT = 300


def _props(input_data) -> dict:
    props = getattr(input_data, "forwarded_props", None)
    return props if isinstance(props, dict) else {}


def deployment_tool_names(input_data) -> frozenset[str]:
    """The tools this deployment runs, as opposed to the surface."""
    names = _props(input_data).get("openbotDeploymentTools", [])
    if not isinstance(names, list):
        return frozenset()
    return frozenset(name for name in names if isinstance(name, str))


def client_tool_names(input_data) -> set[str]:
    """The tools the browser runs: everything offered that the deployment did not claim."""
    if input_data is None:
        return set()
    deployment = deployment_tool_names(input_data)
    return {tool.name for tool in input_data.tools or [] if tool.name not in deployment}


def run_statement(input_data) -> str:
    """The deployment's signed statement of whose run this is, handed back with every tool call."""
    statement = _props(input_data).get("openbotRun", "")
    return statement if isinstance(statement, str) else ""


def instructions(input_data) -> list[tuple[str, str, str]]:
    """Every system message of the run as (id, fingerprint, text), in the order it was given."""
    found = []
    for message in input_data.messages or []:
        if getattr(message, "role", None) not in ("system", "developer"):
            continue
        text = message.content if isinstance(message.content, str) else ""
        if not text.strip():
            continue
        fingerprint = hashlib.sha256(text.encode("utf-8")).hexdigest()
        found.append((getattr(message, "id", "") or "", fingerprint, text))
    return found


def with_instructions(system_prompt, input_data):
    """The session's system prompt, with the deployment's instructions in front of whatever it had."""
    text = "\n\n".join(entry[2] for entry in instructions(input_data))
    if not text:
        return system_prompt
    if isinstance(system_prompt, str) and system_prompt.strip():
        return f"{text}\n\n{system_prompt}"
    if system_prompt is None or isinstance(system_prompt, str):
        return text
    # A preset or a file: the session was configured by somebody else on purpose, so the role goes on
    # the end of it rather than replacing it.
    if isinstance(system_prompt, dict) and system_prompt.get("type") == "preset":
        appended = system_prompt.get("append") or ""
        return {**system_prompt, "append": f"{appended}\n\n{text}".strip()}
    return system_prompt


def _reason(response) -> str:
    """The deployment's own reason for a call it would not run, so the model can tell the person why."""
    try:
        body = response.json()
    except ValueError:
        return ""
    error = body.get("error") if isinstance(body, dict) else None
    if isinstance(error, str) and error.strip():
        return f" {error.strip()[:_REASON_LIMIT]}"
    return ""


async def call_deployment_tool(name: str, args: dict, statement: str) -> tuple[str, bool]:
    """Run one of the deployment's tools through it. Returns (text, failed); never raises."""
    token = (os.environ.get("AGENT_TOOL_TOKEN") or "").strip()
    if not token:
        return (
            "Refused. This digital employee has no credential for calling tools through its deployment.",
            True,
        )
    if not statement:
        return (
            "Refused. This run carried no signed statement of which digital employee and person it is for.",
            True,
        )
    url = os.environ.get("OPENBOT_TOOL_URL") or TOOL_URL
    try:
        # Redirects must never carry this deployment's credential elsewhere.
        async with httpx.AsyncClient(timeout=30, follow_redirects=False) as client:
            response = await client.post(
                url,
                headers={"x-openbot-agent-token": token},
                json={"name": name, "args": args, "run": statement},
            )
        if not response.is_success:
            return (
                f"Refused. Tool callback returned HTTP {response.status_code}.{_reason(response)}",
                True,
            )
        body = response.json()
        if not isinstance(body, dict) or not isinstance(body.get("text"), str):
            return "The tool callback returned no readable result.", True
        return body["text"], bool(body.get("isError"))
    except (httpx.HTTPError, ValueError):
        # Exception strings can contain URLs. Report the boundary, never its credential-bearing request.
        return "The tool callback could not be completed.", True
