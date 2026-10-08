import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

import httpx2
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import main

_LOOPBACK_SOCKET_GUARD_INSTALLED = False


def _openai_response(model, content):
    return {
        "id": "chatcmpl-openbot-ci",
        "object": "chat.completion",
        "created": 0,
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
    }


def _install_loopback_socket_guard():
    global _LOOPBACK_SOCKET_GUARD_INSTALLED
    if _LOOPBACK_SOCKET_GUARD_INSTALLED:
        return

    def guard(event, args):
        if event != "socket.connect":
            return
        _sock, address = args
        if not isinstance(address, tuple) or not address:
            raise RuntimeError(f"Blocked non-IP socket connect: {address!r}")
        host = address[0]
        if host not in {"127.0.0.1", "::1", "localhost"}:
            raise RuntimeError(f"Blocked non-loopback socket connect: {address!r}")

    sys.addaudithook(guard)
    _LOOPBACK_SOCKET_GUARD_INSTALLED = True


def _google_response(content):
    return {
        "candidates": [
            {
                "content": {
                    "parts": [{"text": content}],
                    "role": "model",
                },
                "finishReason": "STOP",
                "index": 0,
            }
        ],
        "usageMetadata": {
            "promptTokenCount": 1,
            "candidatesTokenCount": 1,
            "totalTokenCount": 2,
        },
        "modelVersion": "gemini-2.5-flash",
    }


@pytest.fixture
def compatible_endpoint():
    captured = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            captured.append({"path": self.path, "body": body})
            response = json.dumps(
                _openai_response(body["model"], "compatible proof")
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

        def log_message(self, *_args):
            # Requests are asserted through captured, without noisy access logs.
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/v1", captured
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


@pytest.fixture
def google_genai_endpoint():
    captured = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            captured.append(
                {
                    "path": self.path,
                    "x_goog_api_key_present": bool(self.headers.get("x-goog-api-key")),
                    "body": body,
                }
            )
            response = json.dumps(_google_response("google loopback proof")).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

        def log_message(self, *_args):
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", captured
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


@pytest.fixture(autouse=True)
def provider_environment(monkeypatch):
    for name in list(os.environ):
        if name.startswith(("LANGCHAIN_", "LANGSMITH_")):
            monkeypatch.delenv(name)
    for name in [
        "ALL_PROXY",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_BASE_URL",
        "BOT_MODEL",
        "BOT_PROVIDER",
        "GOOGLE_API_KEY",
        "GOOGLE_GENERATIVE_AI_BASE_URL",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "all_proxy",
        "http_proxy",
        "https_proxy",
        "no_proxy",
    ]:
        monkeypatch.delenv(name, raising=False)


async def _run_answer_with_httpx2_capture(monkeypatch, response_json, messages=None):
    captured = []

    async def send(self, request, **kwargs):
        captured.append(
            {
                "url": str(request.url),
                "headers": dict(request.headers),
                "body": json.loads(request.content.decode()),
            }
        )
        return httpx2.Response(200, json=response_json, request=request)

    monkeypatch.setattr(httpx2.AsyncClient, "send", send)
    result = await main.answer(
        {"messages": messages or [{"role": "user", "content": "Say hello."}]}
    )
    return result, captured


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("model", "request_model"),
    [(None, "gpt-4o-mini"), ("", "gpt-4o-mini"), ("gpt-ci", "gpt-ci")],
)
async def test_openai_key_without_compatible_endpoint_uses_sdk_default_boundary(
    monkeypatch,
    model,
    request_model,
):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-openbot-ci")
    if model is not None:
        monkeypatch.setenv("BOT_MODEL", model)
    monkeypatch.setenv("OPENAI_BASE_URL", "")

    result, captured = await _run_answer_with_httpx2_capture(
        monkeypatch,
        _openai_response(request_model, "openai proof"),
    )

    assert result["messages"][0].content == "openai proof"
    assert os.environ.get("OPENAI_BASE_URL") is None
    assert len(captured) == 1
    assert captured[0]["url"] == "https://api.openai.com/v1/chat/completions"
    assert captured[0]["headers"]["authorization"] == "Bearer sk-openbot-ci"
    assert captured[0]["body"] == {
        "messages": [{"content": "Say hello.", "role": "user"}],
        "model": request_model,
        "stream": False,
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("provider", "model", "request_model"),
    [
        ("openai", "gpt-compatible", "gpt-compatible"),
        ("openai", "qwen2.5:1.5b", "qwen2.5:1.5b"),
        (
            "openai",
            "namespace/model:variant:revision",
            "namespace/model:variant:revision",
        ),
        ("openai", "claude-compatible:latest", "claude-compatible:latest"),
        ("anthropic", "openai:qwen2.5:1.5b", "qwen2.5:1.5b"),
    ],
)
async def test_compatible_model_id_reaches_real_http_boundary(
    monkeypatch, compatible_endpoint, provider, model, request_model
):
    base_url, captured = compatible_endpoint
    monkeypatch.setenv("OPENAI_API_KEY", "sk-compatible-ci")
    monkeypatch.setenv("BOT_PROVIDER", provider)
    monkeypatch.setenv("BOT_MODEL", model)
    monkeypatch.setenv("OPENAI_BASE_URL", f"  {base_url}  ")

    result = await main.answer(
        {"messages": [{"role": "user", "content": "Say hello."}]}
    )

    assert result["messages"][0].content == "compatible proof"
    assert os.environ["OPENAI_BASE_URL"] == base_url
    assert captured == [
        {
            "path": "/v1/chat/completions",
            "body": {
                "messages": [{"content": "Say hello.", "role": "user"}],
                "model": request_model,
                "stream": False,
            },
        }
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", [None, "", "   "])
@pytest.mark.parametrize("model", ["claude-compatible:latest", "qwen2.5:1.5b"])
async def test_blank_provider_keeps_opaque_model_at_compatible_endpoint(
    monkeypatch, compatible_endpoint, provider, model
):
    _install_loopback_socket_guard()
    base_url, captured = compatible_endpoint
    if provider is not None:
        monkeypatch.setenv("BOT_PROVIDER", provider)
    monkeypatch.setenv("BOT_MODEL", model)
    monkeypatch.setenv("OPENAI_API_KEY", "synthetic-compatible-key")
    monkeypatch.setenv("OPENAI_BASE_URL", base_url)
    # A Claude-like compatible model must not route through another available provider.
    monkeypatch.setenv("ANTHROPIC_API_KEY", "synthetic-anthropic-key")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", base_url.removesuffix("/v1"))

    result = await main.answer(
        {"messages": [{"role": "user", "content": "Say hello."}]}
    )

    assert result["messages"][0].content == "compatible proof"
    assert captured == [
        {
            "path": "/v1/chat/completions",
            "body": {
                "messages": [{"content": "Say hello.", "role": "user"}],
                "model": model,
                "stream": False,
            },
        }
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("provider", "model", "request_model"),
    [
        ("anthropic", None, "claude-sonnet-4-5"),
        ("anthropic", "", "claude-sonnet-4-5"),
        ("anthropic", "claude-sonnet-4-5", "claude-sonnet-4-5"),
        ("openai", "anthropic:claude-sonnet-4-5", "claude-sonnet-4-5"),
        ("anthropic", "claude-compatible:latest", "claude-compatible:latest"),
    ],
)
async def test_anthropic_selection_reaches_anthropic_boundary_without_openai_key(
    monkeypatch, provider, model, request_model
):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-openbot-ci")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "http://127.0.0.1:4311")
    monkeypatch.setenv("BOT_PROVIDER", provider)
    if model is not None:
        monkeypatch.setenv("BOT_MODEL", model)

    result, captured = await _run_answer_with_httpx2_capture(
        monkeypatch,
        {
            "id": "msg-openbot-ci",
            "type": "message",
            "role": "assistant",
            "model": request_model,
            "content": [{"type": "text", "text": "anthropic proof"}],
            "stop_reason": "end_turn",
            "stop_sequence": None,
            "usage": {"input_tokens": 1, "output_tokens": 1},
        },
    )

    assert result["messages"][0].content == "anthropic proof"
    assert "OPENAI_API_KEY" not in os.environ
    assert captured[0]["url"] == "http://127.0.0.1:4311/v1/messages"
    assert captured[0]["headers"]["x-api-key"] == "sk-ant-openbot-ci"
    assert captured[0]["headers"]["anthropic-version"] == "2023-06-01"
    assert captured[0]["body"]["model"] == request_model
    assert captured[0]["body"]["messages"] == [
        {"role": "user", "content": "Say hello."}
    ]


# A conversation as the server sends it after somebody picked a skill: the coworker's standing role
# at the head, and the skill's instruction as a system turn just ahead of the message it was picked
# for. The turn stays in the thread's history, so every later run carries it too.
_HISTORY_WITH_A_SKILL = [
    {"role": "system", "content": "You are Ada, Analyst."},
    {"role": "user", "content": "Summarise the Q3 filing."},
    {"role": "assistant", "content": "Revenue rose 4%."},
    {"role": "system", "content": "Answer in bullet points."},
    {"role": "user", "content": "Again, shorter."},
]


@pytest.mark.asyncio
async def test_anthropic_answers_a_conversation_in_which_a_skill_was_picked(
    monkeypatch,
):
    # Anthropic takes one system prompt, and langchain-anthropic refuses a system message that
    # does not follow the others: "Received multiple non-consecutive system messages."
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-openbot-ci")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "http://127.0.0.1:4311")
    monkeypatch.setenv("BOT_PROVIDER", "anthropic")

    result, captured = await _run_answer_with_httpx2_capture(
        monkeypatch,
        {
            "id": "msg-openbot-ci",
            "type": "message",
            "role": "assistant",
            "model": "claude-sonnet-4-5",
            "content": [{"type": "text", "text": "anthropic proof"}],
            "stop_reason": "end_turn",
            "stop_sequence": None,
            "usage": {"input_tokens": 1, "output_tokens": 1},
        },
        _HISTORY_WITH_A_SKILL,
    )

    assert result["messages"][0].content == "anthropic proof"
    assert [block["text"] for block in captured[0]["body"]["system"]] == [
        "You are Ada, Analyst.",
        "Answer in bullet points.",
    ]
    assert captured[0]["body"]["messages"] == [
        {"role": "user", "content": "Summarise the Q3 filing."},
        {"role": "assistant", "content": "Revenue rose 4%."},
        {"role": "user", "content": "Again, shorter."},
    ]


@pytest.mark.asyncio
async def test_openai_keeps_a_skill_turn_beside_the_message_it_was_picked_for(
    monkeypatch,
):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-openbot-ci")

    result, captured = await _run_answer_with_httpx2_capture(
        monkeypatch,
        _openai_response("gpt-4o-mini", "openai proof"),
        _HISTORY_WITH_A_SKILL,
    )

    assert result["messages"][0].content == "openai proof"
    assert [
        (message["role"], message["content"])
        for message in captured[0]["body"]["messages"]
    ] == [(message["role"], message["content"]) for message in _HISTORY_WITH_A_SKILL]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("provider", "model"),
    [
        ("google", None),
        ("google", ""),
        ("google_genai", None),
        ("google_genai", ""),
        ("google", "gemini-2.5-flash"),
        ("openai", "google_genai:gemini-2.5-flash"),
    ],
)
async def test_google_provider_reaches_google_genai_boundary(
    monkeypatch, google_genai_endpoint, provider, model
):
    _install_loopback_socket_guard()
    base_url, captured = google_genai_endpoint
    monkeypatch.setenv("GOOGLE_API_KEY", "synthetic-google")
    monkeypatch.setenv("GOOGLE_GENERATIVE_AI_BASE_URL", f"  {base_url}  ")
    monkeypatch.setenv("BOT_PROVIDER", provider)
    if model is not None:
        monkeypatch.setenv("BOT_MODEL", model)

    result = await main.answer(
        {"messages": [{"role": "user", "content": "Say hello."}]}
    )

    assert result["messages"][0].content == "google loopback proof"
    assert captured == [
        {
            "path": "/v1beta/models/gemini-2.5-flash:generateContent",
            "x_goog_api_key_present": True,
            "body": {
                "contents": [
                    {
                        "parts": [{"text": "Say hello."}],
                        "role": "user",
                    }
                ],
                "generationConfig": {
                    "candidateCount": 1,
                    "temperature": 0.7,
                },
                "safetySettings": [],
            },
        }
    ]


def test_a_chat_plan_credential_is_dropped_and_never_selects_a_model(
    monkeypatch, capsys
):
    from src import main

    monkeypatch.setenv("CHATGPT_AUTH_FILE", "/auth/chatgpt.json")
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "synthetic-plan-token")
    monkeypatch.setenv("OPENAI_API_KEY", "synthetic-key")

    main._drop_retired_plan_credentials()

    assert "CHATGPT_AUTH_FILE" not in os.environ
    assert "CLAUDE_CODE_OAUTH_TOKEN" not in os.environ
    assert os.environ["OPENAI_API_KEY"] == "synthetic-key"
    said = capsys.readouterr().out
    assert "CHATGPT_AUTH_FILE is set" in said
    assert "synthetic-plan-token" not in said
    assert "codex" not in type(main._model()).__name__.lower()
