"""A slow stream is kept alive with comment lines, and nothing else is touched."""

import asyncio

import pytest

from src.keep_alive import FRAME, KeepAlive


def _app(content_type: bytes, chunks, pause: float):
    async def app(scope, receive, send):
        await send(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [(b"content-type", content_type)],
            }
        )
        for index, chunk in enumerate(chunks):
            await asyncio.sleep(pause)
            await send(
                {
                    "type": "http.response.body",
                    "body": chunk,
                    "more_body": index < len(chunks) - 1,
                }
            )

    return app


async def _drive(app):
    sent = []

    async def receive():
        await asyncio.sleep(3600)

    async def send(message):
        sent.append(message)

    await app({"type": "http", "path": "/"}, receive, send)
    return sent


@pytest.mark.asyncio
async def test_a_quiet_event_stream_gets_comment_lines_until_the_answer_comes():
    app = KeepAlive(
        _app(b"text/event-stream; charset=utf-8", [b'data: {"type":"RUN_STARTED"}\n\n', b"data: done\n\n"], 0.25),
        every=0.05,
    )

    sent = await _drive(app)

    bodies = [m["body"] for m in sent if m["type"] == "http.response.body"]
    assert bodies.count(FRAME) >= 3
    assert [b for b in bodies if b != FRAME] == [
        b'data: {"type":"RUN_STARTED"}\n\n',
        b"data: done\n\n",
    ]
    assert sent[0]["type"] == "http.response.start"
    assert sent[-1]["more_body"] is False


@pytest.mark.asyncio
async def test_nothing_is_added_to_a_response_that_is_not_an_event_stream():
    app = KeepAlive(_app(b"application/json", [b"{}"], 0.2), every=0.05)

    sent = await _drive(app)

    assert [m.get("body") for m in sent if m["type"] == "http.response.body"] == [b"{}"]


@pytest.mark.asyncio
async def test_a_failure_in_the_app_still_reaches_the_caller():
    async def broken(scope, receive, send):
        raise RuntimeError("the model is gone")

    with pytest.raises(RuntimeError, match="the model is gone"):
        await _drive(KeepAlive(broken, every=0.05))


@pytest.mark.asyncio
async def test_the_harness_sends_it():
    from src import main

    assert any(m.cls is KeepAlive for m in main.app.user_middleware)
