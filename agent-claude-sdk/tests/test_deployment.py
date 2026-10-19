"""What the deployment gives this Bot: its role and team in the system prompt, and its own tools.

Real adapter, controlled SDK process boundary (see conftest.py), and a controlled deployment for the
tool call-back. No provider requests, no credentials.
"""

import asyncio
import json
import sys
from pathlib import Path

import claude_agent_sdk
import httpx
import pytest
from ag_ui.core import RunAgentInput

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src import deployment
from src.adapter import OpenBotClaudeAgentAdapter

STANDING = (
    "You are Maya, Lead.\n\nYour team: your colleagues are Sam (Accounts). "
    "You are the lead of this team. You have tools for your team: team_list and team_ask."
)

TEAM_LIST = {
    "name": "team_list",
    "description": "List your colleagues",
    "parameters": {"type": "object", "properties": {}},
}
NAVIGATE = {
    "name": "computer_navigate",
    "description": "Navigate",
    "parameters": {"type": "object", "properties": {}},
}


def run_input(
    *,
    thread="thread-a",
    run="run-1",
    messages=None,
    tools=(TEAM_LIST, NAVIGATE),
    deployment_tools=("team_list",),
    statement="signed-run-1",
):
    return RunAgentInput.model_validate(
        {
            "threadId": thread,
            "runId": run,
            "state": {},
            "messages": messages
            or [
                {"id": "standing-role:maya", "role": "system", "content": STANDING},
                {"id": "user-1", "role": "user", "content": "0"},
            ],
            "tools": list(tools),
            "context": [],
            "forwardedProps": {
                "openbotDeploymentTools": list(deployment_tools),
                "openbotRun": statement,
            },
        }
    )


async def events(adapter, input_data):
    async with asyncio.timeout(2):
        return [event async for event in adapter.run(input_data)]


@pytest.fixture
def built(monkeypatch):
    """The tools each session was built with, by tool name, as the MCP server would hold them."""
    sessions = []
    real = claude_agent_sdk.create_sdk_mcp_server

    def capture(name, version, tools):
        sessions.append({tool.name: tool for tool in tools})
        return real(name, version, tools=tools)

    monkeypatch.setattr(claude_agent_sdk, "create_sdk_mcp_server", capture)
    return sessions


@pytest.fixture
def deployment_answers(monkeypatch):
    """The deployment's /api/agent-tools/call, answering and keeping what it was asked."""
    asked = []
    answer = {"json": {"text": "- Sam (Accounts), id: sam", "isError": False}, "status": 200}

    def respond(request):
        asked.append(
            {
                "url": str(request.url),
                "token": request.headers.get("x-openbot-agent-token"),
                "body": json.loads(request.content),
            }
        )
        return httpx.Response(answer["status"], json=answer["json"])

    real = httpx.AsyncClient
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kwargs: real(transport=httpx.MockTransport(respond), **kwargs),
    )
    monkeypatch.setenv("AGENT_TOOL_TOKEN", "harness-token")
    monkeypatch.setenv("OPENBOT_TOOL_URL", "http://deployment.test/api/agent-tools/call")
    return type("Deployment", (), {"asked": asked, "answer": answer})


def test_the_role_and_the_team_reach_claude(sdk):
    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(name="test")
        try:
            await events(adapter, run_input())
        finally:
            await adapter.shutdown()

    asyncio.run(scenario())
    prompt = sdk[0].options.system_prompt
    assert "You are Maya, Lead." in prompt
    assert "You are the lead of this team" in prompt


def test_a_role_is_added_to_a_session_prompt_that_already_had_one():
    assert deployment.with_instructions("Be brief.", run_input()).endswith("Be brief.")
    assert deployment.with_instructions("Be brief.", run_input()).startswith("You are Maya")
    preset = {"type": "preset", "preset": "claude_code", "append": "Be brief."}
    assert deployment.with_instructions(preset, run_input())["append"].startswith("Be brief.")
    assert "Maya" in deployment.with_instructions(preset, run_input())["append"]


def test_a_run_with_no_instructions_leaves_the_prompt_alone():
    bare = run_input(messages=[{"id": "u", "role": "user", "content": "hi"}])
    assert deployment.with_instructions(None, bare) is None
    assert deployment.with_instructions("Be brief.", bare) == "Be brief."


def test_deployment_tools_are_not_the_browsers_to_run():
    names = deployment.client_tool_names(run_input())
    assert names == {"computer_navigate"}
    assert deployment.deployment_tool_names(run_input()) == {"team_list"}


def test_a_deployment_tool_asks_the_deployment_and_a_browser_tool_does_not(
    sdk, built, deployment_answers
):
    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(name="test")
        try:
            await events(adapter, run_input())
            return await built[0]["team_list"].handler({})
        finally:
            await adapter.shutdown()

    result = asyncio.run(scenario())
    assert result == {
        "content": [{"type": "text", "text": "- Sam (Accounts), id: sam"}],
        "is_error": False,
    }
    assert deployment_answers.asked == [
        {
            "url": "http://deployment.test/api/agent-tools/call",
            "token": "harness-token",
            "body": {"name": "team_list", "args": {}, "run": "signed-run-1"},
        }
    ]
    # The browser's tool is still the stub: nothing was asked of the deployment for it.
    stub = asyncio.run(built[0]["computer_navigate"].handler({}))
    assert stub["content"][0]["text"] == "Tool call forwarded to client"


def test_the_statement_is_the_one_of_the_run_in_progress(sdk, built, deployment_answers):
    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(name="test")
        try:
            await events(adapter, run_input(run="run-1", statement="signed-run-1"))
            await events(
                adapter,
                run_input(
                    run="run-2",
                    statement="signed-run-2",
                    messages=[
                        {"id": "standing-role:maya", "role": "system", "content": STANDING},
                        {"id": "user-1", "role": "user", "content": "0"},
                        {"id": "user-2", "role": "user", "content": "0"},
                    ],
                ),
            )
            # One session, built on the first run, called during the second.
            return await built[0]["team_list"].handler({})
        finally:
            await adapter.shutdown()

    asyncio.run(scenario())
    assert len(built) == 1
    assert deployment_answers.asked[-1]["body"]["run"] == "signed-run-2"


def test_a_refusal_is_the_deployments_own_reason(deployment_answers):
    deployment_answers.answer.update(status=403, json={"error": "That run has expired."})
    text, failed = asyncio.run(deployment.call_deployment_tool("team_list", {}, "signed"))
    assert failed
    assert text == "Refused. Tool callback returned HTTP 403. That run has expired."


def test_a_tool_call_without_a_credential_or_a_statement_is_refused(monkeypatch):
    monkeypatch.delenv("AGENT_TOOL_TOKEN", raising=False)
    text, failed = asyncio.run(deployment.call_deployment_tool("team_list", {}, "signed"))
    assert failed and "no credential" in text
    monkeypatch.setenv("AGENT_TOOL_TOKEN", "harness-token")
    text, failed = asyncio.run(deployment.call_deployment_tool("team_list", {}, ""))
    assert failed and "no signed statement" in text


def test_a_deployment_that_cannot_be_reached_is_said_without_its_address(monkeypatch):
    def unreachable(request):
        raise httpx.ConnectError("could not connect to http://deployment.test/secret-path")

    real = httpx.AsyncClient
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kwargs: real(transport=httpx.MockTransport(unreachable), **kwargs),
    )
    monkeypatch.setenv("AGENT_TOOL_TOKEN", "harness-token")
    text, failed = asyncio.run(deployment.call_deployment_tool("team_list", {}, "signed"))
    assert failed
    assert text == "The tool callback could not be completed."


def test_an_instruction_that_changes_mid_conversation_is_sent_once(sdk):
    changed = STANDING + " You also keep in mind: Sam is on leave."

    def second(content):
        return run_input(
            run="run-2",
            messages=[
                {"id": "standing-role:maya", "role": "system", "content": content},
                {"id": "user-1", "role": "user", "content": "0"},
                {"id": "user-2", "role": "user", "content": "0"},
            ],
        )

    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(name="test")
        try:
            await events(adapter, run_input())
            await events(adapter, second(changed))
            await events(adapter, second(changed))
        finally:
            await adapter.shutdown()

    asyncio.run(scenario())
    prompts = [query[0] for query in sdk[0].queries]
    assert prompts[0] == "0"
    assert prompts[1].startswith("Your instructions have changed.")
    assert "Sam is on leave." in prompts[1]
    assert prompts[1].endswith("\n\n---\n\n0")
    assert prompts[2] == "0", "an instruction already heard is not repeated"
