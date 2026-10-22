"""The model a person chose for one run, read from the header the API server sent.

`agent-langgraph` has always honoured this header; this harness did not, so the choice made on the
Models page reached one Bot and not the other. A person who picked a model there, and whose employee
ran on this harness, was answered by whatever the container was started with, with nothing to say so.
Same header, same shape, same refusals as `shared/model-header.ts`, which this mirrors.
"""

import base64
import binascii
import json
import os
from contextvars import ContextVar
from dataclasses import dataclass
from urllib.parse import urljoin, urlparse

HEADER = b"x-ark-model"
MAX_ENCODED_LENGTH = 8 * 1024


@dataclass(frozen=True)
class ModelSelection:
    protocol: str  # "openai" or "anthropic"
    base_url: str
    api_key: str | None
    model: str
    via: str | None = None


class UnreadableSelectionError(ValueError):
    """Raised for a run whose header could not be read; reported to the person as a run error."""

    def __init__(self):
        super().__init__("The model selection for this run could not be read.")


class Unreadable:
    """A header was sent and could not be read: refused, never answered with another model."""


UNREADABLE = Unreadable()

_selection: ContextVar[ModelSelection | Unreadable | None] = ContextVar(
    "openbot_model_selection", default=None
)


def current() -> ModelSelection | Unreadable | None:
    return _selection.get()


def decode(value: str | None) -> ModelSelection | None:
    if not value or len(value) > MAX_ENCODED_LENGTH:
        return None
    try:
        padded = value + "=" * (-len(value) % 4)
        parsed = json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))
    except (ValueError, binascii.Error):
        return None
    if not isinstance(parsed, dict):
        return None
    protocol = parsed.get("protocol")
    base_url = parsed.get("baseUrl")
    api_key = parsed.get("apiKey")
    model = parsed.get("model")
    via = parsed.get("via")
    if protocol not in ("openai", "anthropic"):
        return None
    if not isinstance(base_url, str) or not base_url:
        return None
    if not isinstance(model, str) or not model:
        return None
    if api_key is not None and not isinstance(api_key, str):
        return None
    if via is not None and via != "gateway":
        return None
    if via == "gateway":
        # A path on the deployment, never an address: `//host` would be one in disguise.
        if not base_url.startswith("/") or base_url.startswith("//") or not api_key:
            return None
        return ModelSelection(protocol, base_url, api_key, model, via)
    parts = urlparse(base_url)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        return None
    return ModelSelection(protocol, base_url, api_key, model)


def _tool_origin() -> str:
    url = (
        os.environ.get("OPENBOT_TOOL_URL")
        or "http://127.0.0.1:3001/api/agent-tools/call"
    )
    parts = urlparse(url)
    return f"{parts.scheme}://{parts.netloc}"


def resolved_base_url(selection: ModelSelection) -> str:
    """A gateway selection carries a path on the deployment; resolve it against where the deployment is."""
    base = selection.base_url
    if selection.via == "gateway":
        base = urljoin(_tool_origin(), base)
    return base.rstrip("/")


def _anthropic_root(base_url: str) -> str:
    """Anthropic's SDK adds the version itself, so the base must not already carry it."""
    root = base_url.rstrip("/")
    head, _, tail = root.rpartition("/")
    return head if tail[:1] == "v" and tail[1:].isdigit() else root


def _needs_responses_api(selection: ModelSelection, base_url: str) -> bool:
    """Only OpenAI's own endpoint, and only the models that are driven through the newer API."""
    import re

    return urlparse(base_url).hostname == "api.openai.com" and bool(
        re.match(r"^gpt-5\.[6-9]|^gpt-[6-9]", selection.model)
    )


def build_model(selection: ModelSelection):
    base_url = resolved_base_url(selection)
    api_key = selection.api_key or "not-needed"
    if selection.protocol == "anthropic":
        from langchain_anthropic import ChatAnthropic

        return ChatAnthropic(
            model=selection.model,
            api_key=api_key,
            anthropic_api_url=_anthropic_root(base_url),
            streaming=True,
        )
    from langchain_openai import ChatOpenAI

    return ChatOpenAI(
        model=selection.model,
        api_key=api_key,
        base_url=base_url,
        streaming=True,
        **({"use_responses_api": True} if _needs_responses_api(selection, base_url) else {}),
    )


class ModelSelectionMiddleware:
    """ASGI middleware: read the header once, and make it the answer to `current()` for the request."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        offered = next(
            (value for name, value in scope["headers"] if name.lower() == HEADER), None
        )
        selection: ModelSelection | Unreadable | None = None
        if offered is not None and offered.strip():
            selection = decode(offered.decode("latin-1")) or UNREADABLE
        token = _selection.set(selection)
        try:
            await self.app(scope, receive, send)
        finally:
            _selection.reset(token)
