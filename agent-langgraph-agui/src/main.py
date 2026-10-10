"""LangGraph as a Bot, through the AG-UI integration rather than by hand.

OpenBot already ships `agent-langgraph`, which speaks AG-UI itself because it predates the rule
against writing adapters. This is the same framework served through `ag-ui-langgraph`, which is the
package the AG-UI project maintains, so the protocol stops being ours to keep working.
"""

import os

from ag_ui_langgraph import add_langgraph_fastapi_endpoint
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from langchain.chat_models import init_chat_model
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import START, MessagesState, StateGraph

from .tool_runtime import (
    ToolAwareAgent,
    bind_tools,
    execute_tools,
    model_messages,
    next_step,
)

TOKEN_HEADER = "x-openbot-agent-token"

# Provider names supported by LangChain's public init_chat_model contract. A colon in an opaque
# compatible model ID (for example qwen2.5:1.5b) is not a provider separator.
MODEL_PROVIDERS = {
    "anthropic",
    "anthropic_bedrock",
    "azure_ai",
    "azure_openai",
    "baseten",
    "bedrock",
    "bedrock_converse",
    "cohere",
    "deepseek",
    "fireworks",
    "google_anthropic_vertex",
    "google_genai",
    "google_vertexai",
    "groq",
    "huggingface",
    "ibm",
    "langsmith",
    "litellm",
    "meta",
    "mistralai",
    "nvidia",
    "ollama",
    "openai",
    "openrouter",
    "perplexity",
    "together",
    "upstage",
    "xai",
}

OPENBOT_PROVIDER_ALIASES = {
    "google": "google_genai",
}


def _normalize_openai_base_url():
    base_url = os.environ.get("OPENAI_BASE_URL")
    if base_url is None:
        return
    base_url = base_url.strip()
    if base_url:
        os.environ["OPENAI_BASE_URL"] = base_url
    else:
        os.environ.pop("OPENAI_BASE_URL", None)


def _google_genai_kwargs(provider: str):
    if provider != "google_genai":
        return {}
    base_url = (os.environ.get("GOOGLE_GENERATIVE_AI_BASE_URL") or "").strip()
    if not base_url:
        return {}
    return {"base_url": base_url}


def _resolve_provider(provider: str):
    return OPENBOT_PROVIDER_ALIASES.get(provider, provider)


def _drop_retired_plan_credentials() -> None:
    """Chat-plan credentials are not used, and are removed from the environment, not honoured.

    An earlier version could be given a ChatGPT plan's login (`CHATGPT_AUTH_FILE`) and a Claude plan
    token. OpenAI allows plan sign-in in a paid app only through its own approved programme, and
    Anthropic does not allow it at all, so neither is read. Removing them here also keeps any tool
    this process starts from inheriting one.
    """
    for name in ("CHATGPT_AUTH_FILE", "CLAUDE_CODE_OAUTH_TOKEN"):
        if (os.environ.pop(name, "") or "").strip():
            print(
                f"{name} is set. Chat-plan credentials are not used and were ignored.",
                flush=True,
            )


_drop_retired_plan_credentials()


def _model():
    """The model this Bot thinks with, chosen by the provider and key the deployment gave it.

    A recognized `provider:model` choice keeps its provider. Otherwise the model is an opaque ID
    and the selected provider is passed separately, including when that ID contains a colon.
    """
    configured_model = os.environ.get("BOT_MODEL")
    model = (configured_model or "gpt-4o-mini").strip()

    _normalize_openai_base_url()
    provider = (os.environ.get("BOT_PROVIDER") or "").strip() or "openai"
    provider = _resolve_provider(provider)
    if not configured_model:
        model = {
            "anthropic": "claude-sonnet-4-5",
            "google_genai": "gemini-2.5-flash",
        }.get(provider, model)
    prefix, separator, _ = model.partition(":")
    if separator and prefix in MODEL_PROVIDERS:
        return init_chat_model(model, **_google_genai_kwargs(prefix))
    return init_chat_model(
        model,
        model_provider=provider,
        **_google_genai_kwargs(provider),
    )


def _system_turns_first(messages):
    """Every system message ahead of the conversation, in the order it was given.

    ANTHROPIC TAKES ONE SYSTEM PROMPT, AT THE TOP. `langchain-anthropic` joins system messages that
    follow one another into it, and refuses one that comes after a conversation turn: "Received
    multiple non-consecutive system messages." A skill somebody picks arrives as a system turn just
    ahead of their message and stays in the thread, so from then on every run in that conversation
    failed on Anthropic before the model was asked.

    Moved rather than merged, because the integration already joins the ones that are adjacent.
    Only for Anthropic: OpenAI takes a system turn anywhere, so a skill stays beside the message it
    was picked for, and `langchain-google-genai` already gathers every system message into Gemini's
    one system instruction by itself.
    """
    from langchain_core.messages import SystemMessage, convert_to_messages

    messages = convert_to_messages(messages)
    return [
        *(message for message in messages if isinstance(message, SystemMessage)),
        *(message for message in messages if not isinstance(message, SystemMessage)),
    ]


def _wants_system_turns_first(model) -> bool:
    """
    Anthropic is the provider that refuses non-consecutive system turns, and it is asked for by
    class rather than by `BOT_PROVIDER` because `BOT_MODEL` can name a provider on its own.

    The import is here rather than at the top of the file because this module is imported to read
    a deployment's provider configuration in places that install no provider package at all, and a
    missing import there would answer that question with a crash.
    """
    try:
        from langchain_anthropic import ChatAnthropic
    except ImportError:
        return False
    return isinstance(model, ChatAnthropic)


async def answer(state: MessagesState):
    from openai import AuthenticationError, PermissionDeniedError
    from .tool_runtime import current_tools

    try:
        model = _model()
        messages = model_messages(state["messages"])
        if _wants_system_turns_first(model):
            messages = _system_turns_first(messages)
        return {"messages": [await bind_tools(model).ainvoke(messages)]}
    except (AuthenticationError, PermissionDeniedError):
        # Typed provider boundary only. A callback or harness 401 is a different credential.
        current_tools().connection["authentication_failed"] = True
        raise


builder = StateGraph(MessagesState)
builder.add_node("answer", answer)
builder.add_edge(START, "answer")
builder.add_node("tools", execute_tools)
builder.add_conditional_edges("answer", next_step)
builder.add_edge("tools", "answer")
# A checkpointer, because the AG-UI integration resumes a thread by id and LangGraph refuses to
# without one. In memory rather than in Postgres: OpenBot's database is where a conversation lives,
# and two stores remembering the same thread is how they come to disagree.
graph = builder.compile(checkpointer=MemorySaver())

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
    return {"ok": True, "harness": "langgraph"}


add_langgraph_fastapi_endpoint(
    app=app,
    agent=ToolAwareAgent(name="openbot", graph=graph, config={"recursion_limit": 25}),
    path="/",
)
