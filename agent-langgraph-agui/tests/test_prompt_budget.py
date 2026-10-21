"""A model with a small window is offered the tools a turn needs, and a hosted model is offered all."""

import json

import pytest
from ag_ui.core import Tool
from langchain_core.messages import AIMessage, HumanMessage

from src.prompt_budget import narrow


def tool(name: str, size: int = 400) -> Tool:
    return Tool(
        name=name,
        description="x" * size,
        parameters={"type": "object", "properties": {}},
    )


BROWSER = [tool(n) for n in ("computer_navigate", "computer_read", "computer_click")]
ASK = [tool("ask_person", 100)]
FILES = [tool(n) for n in ("computer_read_file", "computer_write_file")]
VISUAL = [tool(n, 1500) for n in ("showBarChart", "showTable", "askForm")]
MANAGE = [tool(n) for n in ("list_bots", "save_bot")]
TEAM = [tool("team_ask"), tool("team_list")]
EVERYTHING = [*BROWSER, *ASK, *FILES, *VISUAL, *MANAGE, *TEAM]
DEPLOYMENT = frozenset({"team_ask", "team_list"})


def names(tools) -> list[str]:
    return [t.name for t in tools]


def test_everything_is_offered_when_the_window_is_not_known(monkeypatch):
    monkeypatch.delenv("BOT_CONTEXT_TOKENS", raising=False)
    offered, left_out = narrow(EVERYTHING, DEPLOYMENT, [HumanMessage("hi")])
    assert names(offered) == names(EVERYTHING)
    assert left_out == []


def test_everything_is_offered_when_it_fits():
    offered, left_out = narrow(
        EVERYTHING, DEPLOYMENT, [HumanMessage("hi")], tokens=1_000_000
    )
    assert names(offered) == names(EVERYTHING)
    assert left_out == []


def test_a_greeting_keeps_the_browser_asking_and_the_deployment_tools():
    offered, left_out = narrow(
        EVERYTHING, DEPLOYMENT, [HumanMessage("hi")], tokens=2000
    )
    assert set(names(offered)) == {
        "computer_navigate",
        "computer_read",
        "computer_click",
        "ask_person",
        "team_ask",
        "team_list",
    }
    assert set(left_out) == set(names([*FILES, *VISUAL, *MANAGE]))


def test_a_group_comes_back_when_the_person_asks_for_it():
    offered, _ = narrow(
        EVERYTHING,
        DEPLOYMENT,
        [HumanMessage("Show me a chart of sales by month")],
        tokens=4000,
    )
    assert {"showBarChart", "showTable", "askForm"} <= set(names(offered))
    assert "computer_write_file" not in names(offered)


def test_greek_and_arabic_requests_are_understood():
    greek, _ = narrow(
        EVERYTHING,
        DEPLOYMENT,
        [HumanMessage("Φτιάξε ένα γράφημα πωλήσεων")],
        tokens=4000,
    )
    arabic, _ = narrow(
        EVERYTHING, DEPLOYMENT, [HumanMessage("احفظ في ملف")], tokens=4000
    )
    assert "showBarChart" in names(greek)
    assert "computer_write_file" in names(arabic)


def test_a_group_the_thread_already_used_stays_offered():
    used = AIMessage(
        content="",
        tool_calls=[{"name": "computer_write_file", "args": {}, "id": "c1"}],
    )
    offered, _ = narrow(
        EVERYTHING, DEPLOYMENT, [HumanMessage("save it"), used, HumanMessage("ok")], tokens=4000
    )
    assert "computer_read_file" in names(offered)


def test_the_deployment_tools_are_never_left_out_however_small_the_window():
    offered, _ = narrow(EVERYTHING, DEPLOYMENT, [HumanMessage("hi")], tokens=100)
    assert {"team_ask", "team_list"} <= set(names(offered))


def test_only_what_does_not_fit_is_left_out():
    # Room for the visual group once the biggest group is gone: nothing further is dropped.
    total = sum(len(json.dumps(t.model_dump())) // 3 for t in EVERYTHING)
    offered, left_out = narrow(
        EVERYTHING, DEPLOYMENT, [HumanMessage("hi")], tokens=int(total / 0.4) - 1
    )
    assert left_out
    assert not {"computer_navigate", "ask_person"} & set(left_out)


@pytest.mark.parametrize("raw", ["", "abc", "0", "-5"])
def test_a_missing_or_bad_window_changes_nothing(monkeypatch, raw):
    monkeypatch.setenv("BOT_CONTEXT_TOKENS", raw)
    offered, left_out = narrow(EVERYTHING, DEPLOYMENT, [HumanMessage("hi")])
    assert names(offered) == names(EVERYTHING)
    assert left_out == []
