"""Keep what is sent to a model with a small window inside it.

THE PROMPT WAS LARGER THAN THE MODEL'S MEMORY. A "hi" to the model on this computer was a request of
21,097 tokens against a window of 16,384, and the model refused it. Most of those tokens were not the
conversation: they were about 40 tool definitions, sent whole with every message, most of which a
greeting has no use for (charts, forms, file and command tools, the tools that make new digital
employees). A large hosted model carries that without noticing; a model on a laptop cannot, and even
when it fits, reading it before the first word of an answer is the minutes a person waits.

This runs only when the deployment says how big the window is (`BOT_CONTEXT_TOKENS`, written by the
desktop app for the model it runs itself), and only when the tools would not fit. Then the tools the
employee's own work stands on stay, and three groups are offered when the person's message is about
them or the thread has already used them.

What stays, always: the browser tools, asking the person, and every tool the deployment itself runs
for this employee (its grants, its team, its memories): those are its abilities, and a team tool the
model never sees is how an employee came to say it had no way to reach a colleague.

It is not a boundary and must never be mistaken for one: what an employee may do is its grants, checked
where the tool runs. This only chooses what to put in front of the model on this turn. When it is
wrong the model says so and the person asks again by name, so every doubt here resolves towards
offering a group rather than hiding it.
"""

import json
import os
import re
import unicodedata

from langchain_core.messages import AIMessage, HumanMessage

# Share of the window the tools may take. The role, the guidance and the conversation need the rest.
TOOL_SHARE = 0.4

FILES = frozenset(
    {
        "computer_list_files",
        "computer_read_file",
        "computer_write_file",
        "computer_run_command",
    }
)
MANAGE = frozenset(
    {
        "list_bots",
        "read_bot",
        "list_bot_skills",
        "save_bot",
        "list_skills",
        "read_skill",
        "list_skill_tools",
        "save_skill",
    }
)
# A component a person looks at: showBarChart, showTable, askApproval, askForm.
_VISUAL_NAME = re.compile(r"^(show|ask)[A-Z]")

_WANTS = {
    "visual": (
        "chart",
        "graph",
        "plot",
        "table",
        "dashboard",
        "metric",
        "progress",
        "checklist",
        "report",
        "form",
        "approv",
        "choose",
        "choice",
        "quote",
        "visual",
        "diagram",
        "γραφημ",
        "διαγραμμ",
        "πινακ",
        "πίνακ",
        "φορμ",
        "φόρμ",
        "εγκριση",
        "έγκριση",
        "αναφορ",
        "مخطط",
        "جدول",
        "نموذج",
        "تقرير",
        "رسم",
    ),
    "manage": (
        "employee",
        "hire",
        "skill",
        "new role",
        "colleague",
        "δεξιοτ",
        "υπαλλ",
        "ψηφιακ",
        "موظف",
        "مهار",
    ),
    "files": (
        "file",
        "folder",
        "workspace",
        "notes",
        "save",
        "write",
        "csv",
        "document",
        "download",
        "command",
        "script",
        "αρχει",
        "αρχεί",
        "φακελ",
        "φάκελ",
        "σημειω",
        "αποθηκευ",
        "ملف",
        "مجلد",
    ),
}


def _fold(text: str) -> str:
    """Lower case without accents, so "γράφημα" and "γραφημα" are the same word."""
    decomposed = unicodedata.normalize("NFD", text.lower())
    return "".join(ch for ch in decomposed if unicodedata.category(ch) != "Mn")


_FOLDED_WANTS = {
    group: tuple(_fold(word) for word in words) for group, words in _WANTS.items()
}


def window() -> int | None:
    """The window of the model on this computer, or None when the deployment did not say."""
    raw = (os.environ.get("BOT_CONTEXT_TOKENS") or "").strip()
    try:
        tokens = int(raw)
    except ValueError:
        return None
    return tokens if tokens > 0 else None


def cost(tool) -> int:
    """About how many tokens a tool definition takes: its name, description and schema."""
    text = json.dumps(
        {
            "name": tool.name,
            "description": tool.description,
            "parameters": tool.parameters,
        },
        ensure_ascii=False,
    )
    return len(text) // 3


def _text(message) -> str:
    content = message.content
    if isinstance(content, str):
        return content
    return " ".join(
        block.get("text", "")
        for block in content
        if isinstance(block, dict) and block.get("type") == "text"
    )


def _last_person_text(messages) -> str:
    for message in reversed(messages):
        if isinstance(message, HumanMessage):
            return _fold(_text(message))
    return ""


def _already_used(messages) -> set[str]:
    used: set[str] = set()
    for message in messages:
        if isinstance(message, AIMessage):
            for call in message.tool_calls or []:
                name = call.get("name") if isinstance(call, dict) else None
                if name:
                    used.add(name)
    return used


def _group(tool, deployment: frozenset[str]) -> str | None:
    if tool.name in deployment:
        return None
    if tool.name in FILES:
        return "files"
    if tool.name in MANAGE:
        return "manage"
    if _VISUAL_NAME.match(tool.name):
        return "visual"
    return None


def narrow(tools, deployment, messages, tokens=None):
    """The tools to offer on this turn, and the names that were left out.

    Everything is offered unless the window is known and the tools would take more than their share
    of it. Then groups the person did not ask about and the thread has not used are left out, biggest
    first, until they fit or nothing optional is left.
    """
    tokens = window() if tokens is None else tokens
    tools = list(tools)
    if tokens is None:
        return tools, []
    budget = int(tokens * TOOL_SHARE)
    if sum(cost(tool) for tool in tools) <= budget:
        return tools, []

    asked = _last_person_text(messages)
    used = _already_used(messages)
    wanted = {
        name
        for name, words in _FOLDED_WANTS.items()
        if any(word in asked for word in words)
    }
    in_use = {_group(tool, deployment) for tool in tools if tool.name in used}
    optional = {
        group
        for group in ("visual", "manage", "files")
        if group in wanted or group in in_use
    }

    offered = list(tools)
    for group in ("visual", "manage", "files"):
        if sum(cost(tool) for tool in offered) <= budget:
            break
        if group in optional:
            continue
        offered = [tool for tool in offered if _group(tool, deployment) != group]
    left_out = [tool.name for tool in tools if tool not in offered]
    return offered, left_out


def left_out_note(names) -> str:
    """Said to the model, so it does not reach for a tool it was not given."""
    return (
        "These tools exist but are not offered on this turn: "
        + ", ".join(names)
        + ". If the person's task needs one, tell them to ask for it by name (for example to save a "
        "file, show a chart or hire a digital employee) and do what you can in words meanwhile."
    )
