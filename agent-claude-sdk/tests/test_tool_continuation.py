"""Real AG-UI adapter and SDK message types, controlled SDK process boundary (see conftest.py)."""

import asyncio
import sys
from pathlib import Path

import pytest
from ag_ui.core import RunAgentInput

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.adapter import OpenBotClaudeAgentAdapter


def request(thread="thread-a", run="run-1", results=(), tool_count=1):
    return RunAgentInput.model_validate(
        {
            "threadId": thread,
            "runId": run,
            "state": {},
            "messages": [
                {"id": "user-1", "role": "user", "content": str(tool_count)},
                *[
                    {
                        "id": f"result-{id}",
                        "role": "tool",
                        "toolCallId": id,
                        "content": text,
                    }
                    for id, text in results
                ],
            ],
            "tools": [
                {
                    "name": "computer_navigate",
                    "description": "Navigate",
                    "parameters": {"type": "object", "properties": {}},
                }
            ],
            "context": [],
            "forwardedProps": {},
        }
    )


async def events(adapter, input_data):
    async with asyncio.timeout(2):
        return [event async for event in adapter.run(input_data)]


@pytest.mark.parametrize("streaming", [False, True])
def test_client_result_resumes_original_sdk_query(sdk, streaming):
    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(
            name="test",
            options={"include_partial_messages": streaming},
        )
        try:
            first = await events(adapter, request())
            assert any(event.type == "TOOL_CALL_END" for event in first)
            opened = [
                event.message_id
                for event in first
                if event.type == "TEXT_MESSAGE_START"
            ]
            closed = [
                event.message_id for event in first if event.type == "TEXT_MESSAGE_END"
            ]
            assert opened == closed, (
                "finish the assistant's text before handing off client tools"
            )
            resumed = await events(
                adapter,
                request(
                    run="run-2",
                    results=[
                        (
                            "thread-a-tool-0",
                            '{"url":"https://example.com","title":"Example Domain"}',
                        )
                    ],
                ),
            )
            assert sdk[0].queries == [("1", "thread-a")], (
                "a tool result must not become another SDK user prompt"
            )
            assert sdk[0].results["thread-a-tool-0"] == [
                {
                    "type": "text",
                    "text": '{"url":"https://example.com","title":"Example Domain"}',
                }
            ]
            assert resumed[0].type == "RUN_STARTED"
            assert resumed[-1].type == "RUN_FINISHED"
            assert any(
                event.type == "TOOL_CALL_RESULT"
                and event.tool_call_id == "thread-a-tool-0"
                for event in resumed
            )
            assert all(
                getattr(event, "run_id", "run-2") == "run-2" for event in resumed
            )
        finally:
            await adapter.shutdown()

    asyncio.run(scenario())


@pytest.mark.parametrize("separate_requests", [False, True])
def test_parallel_calls_with_identical_arguments_keep_distinct_results(
    sdk, separate_requests
):
    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(
            name="test",
        )
        try:
            first = await events(adapter, request(tool_count=2))
            assert any(
                getattr(event, "tool_call_id", None) == "thread-a-tool-0"
                for event in first
            )
            assert any(
                getattr(event, "tool_call_id", None) == "thread-a-tool-1"
                for event in first
            )
            results = [
                ("thread-a-tool-0", "first result"),
                ("thread-a-tool-1", "second result"),
            ]
            if separate_requests:
                second = await events(
                    adapter, request(run="run-2", results=results[:1], tool_count=2)
                )
                assert [event.type for event in second] == [
                    "RUN_STARTED",
                    "RUN_FINISHED",
                ]
                await events(
                    adapter, request(run="run-3", results=results[1:], tool_count=2)
                )
            else:
                await events(
                    adapter,
                    request(run="run-2", results=list(reversed(results)), tool_count=2),
                )
            assert sdk[0].queries == [("2", "thread-a")]
            assert sdk[0].results == {
                "thread-a-tool-0": [{"type": "text", "text": "first result"}],
                "thread-a-tool-1": [{"type": "text", "text": "second result"}],
            }
        finally:
            await adapter.shutdown()

    asyncio.run(scenario())


def test_unknown_id_cannot_resolve_another_threads_tool(sdk):
    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(
            name="test",
        )
        try:
            await events(adapter, request())
            await events(adapter, request(thread="thread-b"))
            wrong = await events(
                adapter,
                request(
                    thread="thread-b",
                    run="wrong",
                    results=[("thread-a-tool-0", "foreign")],
                ),
            )
            assert wrong[-1].type == "RUN_ERROR"
            assert all(not client.results for client in sdk)
            await events(
                adapter, request(run="a-ok", results=[("thread-a-tool-0", "a result")])
            )
            await events(
                adapter,
                request(
                    thread="thread-b",
                    run="b-ok",
                    results=[("thread-b-tool-0", "b result")],
                ),
            )
            assert sdk[0].results["thread-a-tool-0"][0]["text"] == "a result"
            assert sdk[1].results["thread-b-tool-0"][0]["text"] == "b result"
        finally:
            await adapter.shutdown()

    asyncio.run(scenario())


def test_interrupt_cancels_pending_tool_without_fabricating_a_result(sdk):
    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(
            name="test",
        )
        await events(adapter, request())
        await asyncio.wait_for(sdk[0].hooks_entered.wait(), 2)
        await asyncio.wait_for(adapter.interrupt("thread-a"), 2)
        await asyncio.wait_for(adapter.shutdown(), 2)
        assert sdk[0].interrupted
        assert sdk[0].disconnected
        assert not sdk[0].results

    asyncio.run(scenario())


def test_disconnected_event_consumer_cancels_the_sdk_query(sdk):
    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(name="test")
        stream = adapter.run(request())
        assert (await anext(stream)).type == "RUN_STARTED"
        assert (await anext(stream)).type == "STATE_SNAPSHOT"
        await asyncio.wait_for(stream.aclose(), 2)
        assert sdk[0].interrupted
        assert sdk[0].disconnected
        assert not sdk[0].results
        stale = await events(
            adapter, request(run="stale", results=[("thread-a-tool-0", "late result")])
        )
        assert stale[-1].type == "RUN_ERROR"
        assert len(sdk) == 1
        await adapter.shutdown()

    asyncio.run(scenario())


def test_query_timeout_interrupts_sdk_before_abandoning_client_result(sdk):
    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(
            name="test",
            query_timeout_seconds=0.02,
        )
        try:
            first = await events(adapter, request())
            assert first[-1].type == "RUN_FINISHED"
            await asyncio.wait_for(sdk[0].disconnected_event.wait(), 2)
            assert sdk[0].interrupted, (
                "timeout must send the SDK an interrupt, not only cancel a Python future"
            )
            assert not sdk[0].results
            assert "thread-a" not in adapter._workers, (
                "timed-out SDK worker must not be reused"
            )
        finally:
            await adapter.shutdown()

    asyncio.run(scenario())


def test_sdk_authentication_signal_is_typed(sdk):
    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(
            name="test",
        )
        try:
            result = await events(adapter, request(tool_count="auth-failed"))
            assert result[-1].type == "RUN_ERROR"
            assert result[-1].code == "OPENBOT_MODEL_AUTH_REQUIRED"
        finally:
            await adapter.shutdown()

    asyncio.run(scenario())
