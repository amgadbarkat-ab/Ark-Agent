"""Claude Agent SDK as a Bot, through `ag-ui-claude-sdk`.

It runs on an Anthropic API key, billed to whoever owns the key. It does not run on a Claude plan:
Anthropic does not allow a product to collect or route requests through plan credentials, so this
harness refuses to start with one in its environment rather than quietly ignoring it. A person who
wants their plan uses it in their own, unmodified Claude Code.
"""

import os

from ag_ui_claude_sdk import add_claude_fastapi_endpoint
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .adapter import OpenBotClaudeAgentAdapter

TOKEN_HEADER = "x-openbot-agent-token"


def _require_an_api_key() -> None:
    """An API key, and nothing else.

    A Claude plan token in the environment would be read by the SDK's bundled CLI and used, so it
    is removed before anything starts rather than relied on to be absent.
    """
    if (os.environ.pop("CLAUDE_CODE_OAUTH_TOKEN", "") or "").strip():
        print(
            "CLAUDE_CODE_OAUTH_TOKEN is set. Chat-plan credentials are not used and were ignored.",
            flush=True,
        )
    if not (os.environ.get("ANTHROPIC_API_KEY") or "").strip():
        raise SystemExit("Set ANTHROPIC_API_KEY.")


_require_an_api_key()

app = FastAPI()


@app.middleware("http")
async def refuse_without_the_server_token(request: Request, call_next):
    if request.url.path != "/health":
        expected = (os.environ.get("MANAGED_AGENT_TOKEN") or "").strip()
        offered = (request.headers.get(TOKEN_HEADER) or "").strip()
        if not expected or offered != expected:
            return JSONResponse({"error": "unauthorised"}, status_code=401)
    return await call_next(request)


@app.get("/health")
async def health():
    return {"ok": True, "harness": "claude-agent-sdk"}


add_claude_fastapi_endpoint(
    app=app,
    adapter=OpenBotClaudeAgentAdapter(name="openbot"),
    path="/",
)
