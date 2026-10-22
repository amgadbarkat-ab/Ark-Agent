"""Keep a slow answer from looking like a dead connection.

A model on this computer can spend minutes reading its prompt before it writes a word, and the run
is silent for all of it. The server that called this harness, and every timer between them, takes a
quiet connection for a broken one, and the person is shown "The socket connection was closed
unexpectedly" in place of an answer. That is what the first message after installing did on a laptop.

A server-sent-events comment (a line that starts with a colon) is ignored by every reader of the
format, the AG-UI client included, so sending one adds no event and changes nothing the person sees.
It only stops the connection looking idle. Same line, same interval as `shared/keep-alive.ts`, which
the other two Bots send.
"""

import asyncio

FRAME = b": keep-alive\n\n"
EVERY_SECONDS = 8.0


def _is_event_stream(message) -> bool:
    return any(
        name.lower() == b"content-type" and value.lower().startswith(b"text/event-stream")
        for name, value in message.get("headers", [])
    )


class KeepAlive:
    """ASGI middleware: while an event stream is quiet, send a comment line now and then."""

    def __init__(self, app, every: float = EVERY_SECONDS):
        self.app = app
        self.every = every

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        queue: asyncio.Queue = asyncio.Queue()
        failure: Exception | None = None

        async def forward(message):
            await queue.put(message)

        async def run():
            nonlocal failure
            try:
                await self.app(scope, receive, forward)
            except Exception as error:  # re-raised below, in the caller's task
                failure = error
            finally:
                await queue.put(None)

        task = asyncio.create_task(run())
        streaming = False
        try:
            while True:
                try:
                    message = await asyncio.wait_for(
                        queue.get(), timeout=self.every if streaming else None
                    )
                except asyncio.TimeoutError:
                    await send(
                        {"type": "http.response.body", "body": FRAME, "more_body": True}
                    )
                    continue
                if message is None:
                    break
                if message["type"] == "http.response.start":
                    streaming = _is_event_stream(message)
                elif message["type"] == "http.response.body" and not message.get(
                    "more_body"
                ):
                    streaming = False
                await send(message)
        finally:
            # The person went away, or the response is complete: either way nothing more is wanted.
            if not task.done():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        if failure is not None:
            raise failure
