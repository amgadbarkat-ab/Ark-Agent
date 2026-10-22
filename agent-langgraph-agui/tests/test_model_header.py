"""The model chosen on the Models page reaches this harness, as it reaches `agent-langgraph`.

The API server sends the choice in `x-ark-model` for every employee it runs. Only the other Bot read
it, so an employee on this harness answered with whatever the container was started with, whatever
the person had picked, and nothing on screen said so.
"""

import base64
import json

import httpx
import pytest

from tests.test_standing_role import MESSAGES, _run_input, model_server  # noqa: F401


def _header(**fields) -> str:
    raw = json.dumps(fields).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


async def _run(payload, header):
    from src import main

    transport = httpx.ASGITransport(app=main.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://harness") as client:
        return await client.post(
            "/",
            json=payload,
            headers={
                main.TOKEN_HEADER: "ci-token",
                "accept": "text/event-stream",
                "x-ark-model": header,
            },
        )


@pytest.fixture
def deployment_model(monkeypatch):
    """What the container was started with: somewhere nothing listens, so using it fails loudly."""
    monkeypatch.setenv("MANAGED_AGENT_TOKEN", "ci-token")
    monkeypatch.setenv("BOT_PROVIDER", "openai")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-deployment")
    monkeypatch.setenv("OPENAI_BASE_URL", "http://127.0.0.1:9/v1")
    monkeypatch.setenv("BOT_MODEL", "deployment-model")


@pytest.mark.asyncio
async def test_an_openai_compatible_choice_is_the_model_that_answers(
    deployment_model, model_server  # noqa: F811
):
    base_url, captured = model_server
    response = await _run(
        _run_input(MESSAGES),
        _header(protocol="openai", baseUrl=f"{base_url}/v1", apiKey="sk-chosen", model="command-a"),
    )

    assert response.status_code == 200
    assert "RUN_ERROR" not in response.text
    assert len(captured) == 1
    assert captured[0]["model"] == "command-a"


@pytest.mark.asyncio
async def test_an_anthropic_choice_goes_to_the_messages_api(
    deployment_model, model_server  # noqa: F811
):
    base_url, captured = model_server
    response = await _run(
        _run_input(MESSAGES),
        _header(protocol="anthropic", baseUrl=f"{base_url}/v1", apiKey="sk-ant", model="claude-sonnet-5-5"),
    )

    assert "RUN_ERROR" not in response.text
    assert captured[0]["model"] == "claude-sonnet-5-5"
    assert "system" in captured[0]


@pytest.mark.asyncio
async def test_a_gateway_choice_is_resolved_against_the_deployment(
    deployment_model, model_server, monkeypatch  # noqa: F811
):
    base_url, captured = model_server
    monkeypatch.setenv("OPENBOT_TOOL_URL", f"{base_url}/api/agent-tools/call")
    response = await _run(
        _run_input(MESSAGES),
        _header(protocol="openai", baseUrl="/api/model-gateway/v1", apiKey="grant", model="gpt-4o-mini", via="gateway"),
    )

    assert "RUN_ERROR" not in response.text
    assert len(captured) == 1


@pytest.mark.asyncio
async def test_an_unreadable_choice_is_refused_not_answered_with_another_model(
    deployment_model, model_server  # noqa: F811
):
    _, captured = model_server
    response = await _run(_run_input(MESSAGES), "not-a-model-selection")

    assert "RUN_ERROR" in response.text
    assert captured == []


def test_decode_refuses_what_the_bot_refuses():
    from src.model_override import decode

    ok = {"protocol": "openai", "baseUrl": "https://x.example/v1", "apiKey": None, "model": "m"}
    assert decode(_header(**ok)) is not None
    assert decode(_header(**{**ok, "protocol": "grpc"})) is None
    assert decode(_header(**{**ok, "baseUrl": "file:///etc/passwd"})) is None
    assert decode(_header(**{**ok, "model": ""})) is None
    # A gateway selection is a path on the deployment, with a grant: never an address.
    gateway = {**ok, "via": "gateway", "baseUrl": "//evil.example/v1", "apiKey": "g"}
    assert decode(_header(**gateway)) is None
    assert decode(_header(**{**gateway, "baseUrl": "/api/model-gateway/v1", "apiKey": None})) is None
    assert decode("x" * (9 * 1024)) is None
