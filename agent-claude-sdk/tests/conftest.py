"""The controlled SDK process boundary, shared by the adapter tests.

No provider requests, credentials, or Claude subprocesses. The fake client runs the configured
PostToolUse hooks, just as the SDK does before returning a tool result to Claude, and records the
result seen by that original query.
"""

import asyncio
import json

import claude_agent_sdk
import pytest
from claude_agent_sdk import (
    AssistantMessage,
    ResultMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)
from claude_agent_sdk.types import StreamEvent


@pytest.fixture
def sdk(monkeypatch):
    clients = []

    class Client:
        def __init__(self, options):
            self.options = options
            self.queries = []
            self.results = {}
            self.interrupted = False
            self.disconnected = False
            self.disconnected_event = asyncio.Event()
            self.hooks_entered = asyncio.Event()
            clients.append(self)

        async def connect(self):
            pass

        async def disconnect(self):
            self.disconnected = True
            self.disconnected_event.set()

        async def interrupt(self):
            self.interrupted = True

        async def query(self, prompt, session_id):
            if not isinstance(prompt, str):
                self.input_messages = [message async for message in prompt]
                # Model mode supplies structured user input and image blocks.
                # This fixture's requested tool count is in the last labelled user turn.
                for part in self.input_messages[0]["message"]["content"]:
                    if part["type"] == "text" and part["text"].startswith("{"):
                        item = json.loads(part["text"])
                        if item.get("role") == "user":
                            prompt = item.get("content", "")
            self.queries.append((prompt, session_id))

        async def receive_response(self):
            prompt, thread = self.queries[-1]
            if prompt == "auth-failed":
                yield AssistantMessage(
                    content=[], model="controlled-sdk", error="authentication_failed"
                )
                return
            count = int(prompt) if prompt.isdigit() else 0
            calls = [
                ToolUseBlock(
                    id=f"{thread}-tool-{i}",
                    name="mcp__ag_ui__computer_navigate",
                    input={},
                )
                for i in range(count)
            ]
            if self.options.include_partial_messages:
                raw_events = [
                    {"type": "message_start", "message": {"id": "assistant-message"}},
                    {
                        "type": "content_block_delta",
                        "delta": {"type": "text_delta", "text": "Opening the browser."},
                    },
                    {"type": "content_block_stop"},
                ]
                for call in calls:
                    raw_events.extend(
                        [
                            {
                                "type": "content_block_start",
                                "content_block": {
                                    "type": "tool_use",
                                    "id": call.id,
                                    "name": call.name,
                                },
                            },
                            {
                                "type": "content_block_delta",
                                "delta": {
                                    "type": "input_json_delta",
                                    "partial_json": "{}",
                                },
                            },
                            {"type": "content_block_stop"},
                        ]
                    )
                raw_events.append({"type": "message_stop"})
                for raw in raw_events:
                    yield StreamEvent(uuid="stream", session_id=thread, event=raw)
            yield AssistantMessage(content=calls, model="controlled-sdk")

            async def finish_tool(call):
                # This is the CLI's PostToolUse stage, after the MCP response
                # envelope was removed. SDK 0.2.152's bundled MCP output schema
                # accepts string | content-block[] | null; its result-size
                # mapper calls .reduce() on nonstrings. Hooks replace that
                # output directly, NOT the earlier MCP {content: ...} envelope.
                # https://code.claude.com/docs/en/hooks#posttooluse-decision-control
                result = [{"type": "text", "text": "Tool call forwarded to client"}]
                for matcher in (self.options.hooks or {}).get("PostToolUse", []):
                    for hook in matcher.hooks:
                        update = await hook(
                            {
                                "hook_event_name": "PostToolUse",
                                "tool_name": call.name,
                                "tool_input": {},
                                "tool_response": result,
                            },
                            call.id,
                            {},
                        )
                        result = update.get("hookSpecificOutput", {}).get(
                            "updatedMCPToolOutput", result
                        )
                self.results[call.id] = result
                assert result is None or isinstance(result, (str, list)), (
                    "CLI MCP hook output must be content blocks, not a {content: ...} response envelope"
                )

            self.hooks_entered.set()
            await asyncio.gather(*(finish_tool(call) for call in calls))
            yield UserMessage(
                content=[
                    ToolResultBlock(tool_use_id=id, content=result)
                    for id, result in self.results.items()
                ]
            )
            yield AssistantMessage(
                content=[TextBlock(text=json.dumps(self.results))],
                model="controlled-sdk",
            )
            yield ResultMessage(
                subtype="success",
                duration_ms=1,
                duration_api_ms=1,
                is_error=False,
                num_turns=1,
                session_id=thread,
            )

    monkeypatch.setattr(claude_agent_sdk, "ClaudeSDKClient", Client)
    return clients
