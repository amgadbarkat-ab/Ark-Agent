# Weekly summary, then chat cleanup: what it does to LLM usage

Amgad, 24 Nov 2026 (#149, item C). Estimates, not measurements: the numbers below come from the
history limits in the code and typical message sizes, and say which is which.

## What a request carries today

A request to a digital employee carries its standing instructions (role, tools, memories), then the
conversation so far. How much of the conversation depends on the runtime:

| Runtime | History sent to the model on each request |
|---|---|
| The built-in bot (`agent-bot`) | The last 12 turns, at most 60,000 characters (about 15,000 tokens); older tool results cut to 2,000 characters (`agent-bot/src/history-budget.ts`) |
| Hired employees on the LangGraph path (`agent-langgraph`) and other runtimes | **The whole conversation**, every time (AG-UI carries all of it; nothing trims it) |

So the longer a person keeps writing in the same conversation, the more every request costs, and on the
LangGraph path without limit.

## What changes

Once a week (Sunday 02:00 to 05:59 in the person's own time zone) each employee with the setting on:
1. reads its one-to-one conversations of the week;
2. merges them into its summary file (at most about 3,000 tokens);
3. saves it, and only then deletes those conversations.

Every request then starts from the summary (in its instructions, beside its memories) instead of weeks
of conversation.

## Example: one employee, 4 weeks, one long conversation

Assumptions (typical, not measured): 15 requests a working day, 20 working days. Per turn: the person
about 80 tokens, the employee about 300, tool results about 600 (500 once cut). Standing instructions
about 3,000 tokens. Summary about 2,000 tokens.

| | Without the cleanup | With the weekly cleanup |
|---|---|---|
| Conversation kept | 300 turns (4 weeks) | at most 1 week (about 75 turns), plus the summary |
| **LangGraph path**, history per request in week 4 | about 225 to 300 turns × 980 ≈ **220,000 to 294,000 tokens**: over most models' context window, so requests fail or the provider cuts it | about 0 to 75 turns × 980, on average **≈ 37,000** + 2,000 summary |
| **Built-in bot**, history per request | 12 turns × ≈ 880 ≈ **10,500 tokens** (its cap) | the same 12-turn window once a conversation passes 12 turns; **about 2,000 to 10,500**, depending on how far into the week |
| Plus standing instructions | 3,000 | 3,000 |

**The summary run itself** happens once a week. Its input is the week's conversations once (75 turns ×
about 380 tokens of text, without tool output ≈ 28,000 tokens), and its output is about 2,000 tokens.
That costs about as much as two or three requests on the LangGraph path in week 4.

## Cost and speed for an API-key user

Illustrative price: €3 per million input tokens. Check your provider's real price.

- **LangGraph path, week 4:**
  - without the cleanup, about 220,000 tokens: about €0.66 a request, if the model accepts it at all;
  - with it, about 42,000 tokens on average: about €0.13 a request.
  - Over the 75 requests of week 4, that is about **€50 before, €10 after**.
- **Built-in bot:** at most about 13,500 tokens a request before. After, between about 5,000 and 15,500 depending on the day of the week.
  - The saving is in the first part of each week. The model also no longer forgets everything older than 12 turns, because the summary keeps it.
- **Speed:** a model reads its input before it answers, so time to the first word grows with the input.
  - A model on this computer often reads a few hundred tokens a second.
  - At 300 a second, 13,500 tokens is about 45 seconds before the first word; 5,000 tokens is about 17 seconds.
  - On the LangGraph path the difference is minutes, or a request that cannot run at all on a local model with an 8,000 to 32,000 token window.

## What can be lost (the trade-offs)

- **Exact wording.** The summary keeps facts, decisions, open tasks, customer details and preferences, but not the conversation word for word. A quote, a long list or a draft from week 1 survives only as the summary puts it.
- **Tool output and attachments** are not in the summary: what a file or a web page said is kept only if the conversation itself said it.
- **A small local model writes a weaker summary.** It may drop or blur a detail. The summary is capped at about 3,000 tokens, so the oldest details are compressed first.
- **The delete is permanent.** It happens only after the summary is saved, and never when the summary fails. Still, the old conversations cannot be brought back.
- **What is never touched:** a group conversation (several employees), and a conversation active in the last hour.
- **Existing employees** (made before this version) keep their full chat until the person switches the cleanup on. New employees have it on by default. Switching it off shows: "deactivating this function will affect the usage of your LLM model."
