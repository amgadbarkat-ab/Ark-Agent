"""A coworker's standing role reaches the model through the whole AG-UI path.

`ag_ui_langgraph` drops the first system message of a run. OpenBot's server sends the coworker's
standing role there, so for as long as nothing here stopped it, every coworker on this harness was
told nothing about itself: no name, no title, no instructions, no team. The tests that already
covered system turns call the answer node directly, below the integration that drops the message, so
none of them could see it. These go through the endpoint and read what the model was sent.
"""

import json
import threading
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer

import httpx
import pytest

ROLE = "You are Ada, Chief of Operations. You lead this team and can ask a colleague with team_ask."


def _anthropic_stream() -> bytes:
    events = [
        (
            "message_start",
            {
                "type": "message_start",
                "message": {
                    "id": "msg-openbot-ci",
                    "type": "message",
                    "role": "assistant",
                    "model": "claude-sonnet-4-5",
                    "content": [],
                    "stop_reason": None,
                    "stop_sequence": None,
                    "usage": {"input_tokens": 1, "output_tokens": 1},
                },
            },
        ),
        (
            "content_block_start",
            {
                "type": "content_block_start",
                "index": 0,
                "content_block": {"type": "text", "text": ""},
            },
        ),
        (
            "content_block_delta",
            {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "text_delta", "text": "I am Ada."},
            },
        ),
        ("content_block_stop", {"type": "content_block_stop", "index": 0}),
        (
            "message_delta",
            {
                "type": "message_delta",
                "delta": {"stop_reason": "end_turn", "stop_sequence": None},
                "usage": {"output_tokens": 1},
            },
        ),
        ("message_stop", {"type": "message_stop"}),
    ]
    return "".join(
        f"event: {name}\ndata: {json.dumps(data)}\n\n" for name, data in events
    ).encode()


def _openai_stream() -> bytes:
    def chunk(delta, finish=None):
        return {
            "id": "chatcmpl-openbot-ci",
            "object": "chat.completion.chunk",
            "created": 0,
            "model": "gpt-4o-mini",
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
        }

    lines = [
        chunk({"role": "assistant", "content": "I am Ada."}),
        chunk({}, "stop"),
    ]
    return (
        "".join(f"data: {json.dumps(line)}\n\n" for line in lines) + "data: [DONE]\n\n"
    ).encode()


@pytest.fixture
def model_server():
    """A model endpoint that records what it is sent and answers in one line."""
    captured: list[dict] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get("content-length", 0))
            captured.append(json.loads(self.rfile.read(length) or b"{}"))
            body = (
                _anthropic_stream()
                if self.path.endswith("/messages")
                else _openai_stream()
            )
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_port}", captured
    server.shutdown()


def _run_input(messages, **extra):
    # A thread of its own: the harness remembers a thread in memory, so a run that shared an id with
    # an earlier test would be sent that test's conversation as well.
    return {
        "threadId": f"thread-openbot-ci-{uuid.uuid4().hex}",
        "runId": f"run-openbot-ci-{uuid.uuid4().hex}",
        "state": {},
        "messages": messages,
        "tools": [
            {
                "name": "team_ask",
                "description": "Ask a colleague to do a piece of work.",
                "parameters": {
                    "type": "object",
                    "properties": {"colleague": {"type": "string"}},
                },
            }
        ],
        "context": [],
        "forwardedProps": {"openbotDeploymentTools": ["team_ask"], "openbotRun": "x"},
        **extra,
    }


async def _post(payload):
    from src import main

    transport = httpx.ASGITransport(app=main.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://harness") as client:
        response = await client.post(
            "/",
            json=payload,
            headers={main.TOKEN_HEADER: "ci-token", "accept": "text/event-stream"},
        )
    assert response.status_code == 200
    assert "RUN_ERROR" not in response.text


def _system_text(body: dict) -> str:
    system = body.get("system")
    if isinstance(system, list):
        return "\n".join(block["text"] for block in system)
    if isinstance(system, str):
        return system
    return "\n".join(
        message["content"]
        for message in body.get("messages", [])
        if message.get("role") == "system"
    )


MESSAGES = [
    {"id": "standing-role:ada", "role": "system", "content": ROLE},
    {"id": "user-1", "role": "user", "content": "Who are you, and what is your title?"},
]


@pytest.mark.asyncio
async def test_anthropic_is_told_who_the_coworker_is(monkeypatch, model_server):
    base_url, captured = model_server
    monkeypatch.setenv("MANAGED_AGENT_TOKEN", "ci-token")
    monkeypatch.setenv("BOT_PROVIDER", "anthropic")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-openbot-ci")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", base_url)

    await _post(_run_input(MESSAGES))

    assert len(captured) == 1
    assert ROLE in _system_text(captured[0])
    assert [message["role"] for message in captured[0]["messages"]] == ["user"]
    assert [tool["name"] for tool in captured[0]["tools"]] == ["team_ask"]


@pytest.mark.asyncio
async def test_an_openai_compatible_model_is_told_who_the_coworker_is(
    monkeypatch, model_server
):
    # The model on this computer is one of these, so the same loss left it with no role either.
    base_url, captured = model_server
    monkeypatch.setenv("MANAGED_AGENT_TOKEN", "ci-token")
    monkeypatch.setenv("BOT_PROVIDER", "openai")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-openbot-ci")
    monkeypatch.setenv("OPENAI_BASE_URL", f"{base_url}/v1")

    await _post(_run_input(MESSAGES))

    assert len(captured) == 1
    assert ROLE in _system_text(captured[0])


@pytest.mark.asyncio
async def test_every_leading_system_turn_survives_not_only_the_first(
    monkeypatch, model_server
):
    # The server sends the standing role and then what the coworker holds, both as system turns.
    base_url, captured = model_server
    monkeypatch.setenv("MANAGED_AGENT_TOKEN", "ci-token")
    monkeypatch.setenv("BOT_PROVIDER", "anthropic")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-openbot-ci")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", base_url)
    holdings = "You hold: Google Drive (read)."

    await _post(
        _run_input(
            [
                MESSAGES[0],
                {"id": "holdings:ada", "role": "system", "content": holdings},
                MESSAGES[1],
            ]
        )
    )

    system = _system_text(captured[0])
    assert ROLE in system
    assert holdings in system
    assert system.index(ROLE) < system.index(holdings)


@pytest.mark.asyncio
async def test_anthropic_is_asked_to_cache_the_prompt_it_will_see_again(
    monkeypatch, model_server
):
    # Every step of a run sends the same role, guidance and tools; a marked prefix is read back at a
    # fraction of the price instead of being billed in full each time.
    base_url, captured = model_server
    monkeypatch.setenv("MANAGED_AGENT_TOKEN", "ci-token")
    monkeypatch.setenv("BOT_PROVIDER", "anthropic")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-openbot-ci")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", base_url)

    await _post(_run_input(MESSAGES))

    system = captured[0]["system"]
    assert system[-1]["cache_control"] == {"type": "ephemeral"}
    assert all("cache_control" not in block for block in system[:-1])


@pytest.mark.asyncio
async def test_a_small_window_is_offered_only_the_tools_a_greeting_needs(
    monkeypatch, model_server
):
    base_url, captured = model_server
    monkeypatch.setenv("MANAGED_AGENT_TOKEN", "ci-token")
    monkeypatch.setenv("BOT_PROVIDER", "openai")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-openbot-ci")
    monkeypatch.setenv("OPENAI_BASE_URL", f"{base_url}/v1")
    monkeypatch.setenv("BOT_CONTEXT_TOKENS", "1500")

    def tool(name: str):
        return {
            "name": name,
            "description": "d" * 500,
            "parameters": {"type": "object", "properties": {}},
        }

    payload = _run_input(
        [
            MESSAGES[0],
            {"id": "user-1", "role": "user", "content": "hi"},
        ]
    )
    payload["tools"] = [
        tool(name)
        for name in (
            "computer_navigate",
            "computer_read",
            "computer_write_file",
            "showBarChart",
            "showTable",
            "save_bot",
            "team_ask",
        )
    ]
    await _post(payload)

    sent = [t["function"]["name"] for t in captured[0]["tools"]]
    assert "computer_navigate" in sent
    assert "team_ask" in sent
    assert "showBarChart" not in sent
    assert "save_bot" not in sent
    assert "computer_write_file" not in sent
    # The model is told what it was not given, so it does not reach for it.
    system = _system_text(captured[0])
    assert "not offered on this turn" in system
    assert "showBarChart" in system


@pytest.mark.asyncio
async def test_an_openai_compatible_model_gets_one_system_message_with_the_role_first(
    monkeypatch, model_server
):
    # Some providers read only the first of several system messages, and a small model gives most
    # weight to whatever it reads first. A free-plan model answered as the provider's own assistant
    # while the role sat behind a screen catalog.
    base_url, captured = model_server
    monkeypatch.setenv("MANAGED_AGENT_TOKEN", "ci-token")
    monkeypatch.setenv("BOT_PROVIDER", "openai")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-openbot-ci")
    monkeypatch.setenv("OPENAI_BASE_URL", f"{base_url}/v1")
    holdings = "You hold: Google Drive (read)."

    payload = _run_input(
        [
            MESSAGES[0],
            {"id": "holdings:ada", "role": "system", "content": holdings},
            MESSAGES[1],
        ]
    )
    payload["context"] = [{"description": "A2UI Component Schema", "value": "{}"}]
    await _post(payload)

    sent = captured[0]["messages"]
    assert [message["role"] for message in sent] == ["system", "user"]
    prompt = sent[0]["content"]
    assert prompt.startswith(ROLE)
    assert prompt.index(holdings) > prompt.index(ROLE)
    assert prompt.index("A2UI Component Schema") > prompt.index(holdings)


@pytest.mark.asyncio
async def test_a_run_writes_one_line_saying_what_reached_the_model(
    monkeypatch, model_server, capsys
):
    base_url, _ = model_server
    monkeypatch.setenv("MANAGED_AGENT_TOKEN", "ci-token")
    monkeypatch.setenv("BOT_PROVIDER", "openai")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-secret-never-printed")
    monkeypatch.setenv("OPENAI_BASE_URL", f"{base_url}/v1")

    await _post(_run_input(MESSAGES))

    out = capsys.readouterr().out
    line = next(line for line in out.splitlines() if line.startswith("run: model="))
    assert 'role_opening="You are Ada, Chief of Operations.' in line
    assert "tools=1 [team_ask]" in line
    assert "sk-secret-never-printed" not in out
