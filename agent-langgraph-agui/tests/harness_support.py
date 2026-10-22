"""What the tests of a coworker's standing role share: a fake model endpoint and a way to drive the harness.

The fake endpoint records every request it is sent and answers in one line, in the shape of whichever
API was called, so a test reads what a model would have been shown. Imported by name from the tests
because `conftest.py` puts this directory on the path; `model_server` is registered there.
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
