# Digital employees in the marketplace

What Ark's own listings are, how an install works, and what was learned from other products. Read with
`server/src/marketplace/official-roles.ts` (the words), `official.ts` (how they become an instruction) and
`store.ts` (the install).

## The list (17)

| Listing | Was | Category |
| --- | --- | --- |
| Sales, Sales Engineer | new | Sales |
| Marketing | new | Marketing |
| Designer | new | Design |
| Accounting, Finance | Finance is the earlier Finance Assistant | Finance |
| Customer Support, Front Desk | Customer Support is the earlier Support Agent | Support |
| Inventory and Logistics, Chief of Operations, Chief of Staff | Chief of Operations is the earlier Operations Coordinator | Operations |
| Personal Secretary | the earlier Executive Assistant | Productivity |
| Programmer, Coding Engineer, Code Reviewer | Code Reviewer is earlier | Engineering |
| Research Analyst, Writing Editor | earlier | Research, Writing |

The owner's list of 15 had 14 roles and "a role you write (custom)". The custom one is a row at the end of the list that
opens the new digital employee form. Four of the 14 were the same job as one of the earlier seven, so those were renamed
in place (the address of a listing never changes) rather than listed twice. Accounting and Finance, and Programmer and
Coding Engineer, are kept apart as asked.

## What an install writes

1. A digital employee, private to the person, with the role description (two or three sentences, shown on screens and
   read by the router) and the **persona**: the full instruction, composed by `composeInstruction`. It says who the
   employee is in the first person, its work, who it works with, who supports it, what it can do, which skills it has,
   what it will ask to be connected, and how it works in a team. The company name comes from the account's name unless that
   is an email address.
2. The role's skills, as the person's own skills (origin `marketplace:<listing>`), granted to the new employee. Skills here
   declare no tools, so nothing is granted beyond the instructions.
3. Nothing else. Connections and servers are requests: shown on the page, told to the employee, never granted.

On a deployment with a shared agent (the normal case), the standing role message is built from the persona when there is
one and from the role description otherwise (`standingRoleMessage`). The persona is a separate column so the router, which
reads every role description to choose who answers, is not made to read 3,000 characters per employee.

## Honesty rules in the text

- Every instruction ends with the rule that an unsure employee says so and invents nothing.
- No role claims a feature, a figure or an ability it was not given. Skills say what to do when the input is missing.
- No role says it can message a colleague or open an account. It says who it would ask and asks the person to bring them in.
  (Real employee-to-employee messaging is a later release.)
- Requests name only servers that exist in the deployment's catalogue: Google Drive, Notion and Routines. Other apps are
  listed as accounts to connect, by their usual names; whether one can be connected depends on the deployment.

## What other products show (checked 2026-10-18, public pages only)

- **OpenBot** (openbot.run): its public marketplace lists one agent template (Code Review Partner) and 17 plugins by category
  (Data & Analytics, Design, Coding, Productivity, Research, Automation, Other). A skill is "a set of instructions for a
  particular kind of task"; a plugin is a connection; a skill is added to an agent from a listing, and plugins bring their own.
  Plugins relevant to our roles: Canva, Figma, Paper (design); Linear, Sentry, Vercel, Context7 (engineering); PostHog,
  Firecrawl, Brave Search (marketing, research); Notion, Airtable, Stripe, Resend. It does not describe skills per job role.
- **Grok**: no public role marketplace was found; only its home page was looked at.

So there is no per-role skill catalogue elsewhere to copy: the skills here were written for each role from what the job
involves, in the same shape OpenBot describes (instructions, plus the connection that brings the data).

## A team (release C)

- **The primary digital employee.** The first one a person makes leads their team without being asked. They can choose another
  on its General page ("Make primary"). One at a time per person, never a platform employee. If the lead is deleted, the one
  that has been there longest takes over. Changes are recorded as `bot.primary_changed`.
- **Every employee knows it is on a team.** Its standing instruction now names its colleagues (up to twelve, then a count),
  says who leads, and says what to do when a task is someone else's: name the colleague, say what it would ask them, and ask the
  person to bring them in. It asks a colleague directly only if it was given a tool for that, and never says a colleague did
  something unless a tool result shows it. When nobody on the team can settle a question it says so and suggests ArkAgent
  support. The text is `server/src/agents/team.ts`; it is built from rows already loaded for the request, so it costs no query.
  A person's shared employee is not told about someone else's team.
- **Instructions on the General page.** The owner can read and edit the full standing instruction (up to 8,000 characters).
  Leave it empty and the Role is the whole instruction. Editing the Role replaces the long instruction, as before. The long
  instruction is only sent to people who may change it.
- **Cheaper turns.** The built-in agent used to send the whole conversation to the model on every turn, tool results included.
  It now keeps the standing role and the last 12 turns, shortens tool results from earlier turns to 2,000 characters, and drops
  the oldest turns when what is left is over 60,000 characters. When something was left out the model is told so and asks the
  person to repeat it rather than guessing. Limits: `BOT_HISTORY_TURNS`, `BOT_HISTORY_CHARACTERS`,
  `BOT_TOOL_RESULT_CHARACTERS` (0 switches a limit off). This is `agent-bot`; the framework agents are unchanged.

## Looking after the team (release D)

- **Requests.** A change one digital employee wants made to another's work is held in the owner's Requests screen
  until they approve it. Nothing is applied before that, a request nobody answers lapses after seven days, one
  employee can have ten waiting at most, and a double-click or two replicas applies it once (the row is claimed with a
  conditional update before the change runs). Kinds today: change a routine, delete a routine, replace a colleague's
  instructions, reword a memory, delete a memory. Every ask and every decision is in the audit trail
  (`approval.requested`, `approval.approved`, `approval.rejected`, `approval.failed`). The sidebar shows how many are waiting.
- **The lead's tools.** The lead (and only the lead, and only for its own owner) can `team_list`, `team_report` (a
  colleague's routines, how they last ran, and what it keeps in mind), `team_pause_routine` (off or back on; reversible and
  recorded as `team.action`), `team_request_change` (becomes a Request) and `team_ask` (ask a colleague for work through the
  existing hand-off desk, with its depth and fan-out caps and its audit rows). Everyone else on a team of two or more gets
  `team_list` and `team_ask` only. A team of one is offered nothing.
- **Asking without a grant.** The lead may ask the same person's other employees, and two employees of one person may ask
  each other in a conversation both are members of, without an administrator granting it: the person made one the lead, or
  put them in the same room. The default chain depth is 1 (`BOT_HANDOFF_MAX_DEPTH`), so a colleague the lead asks cannot ask a
  third; raise it to 2 to let them.
- **The team channel.** `POST /api/channels/team` finds or makes the person's one channel with every digital employee they
  own, lead first, and keeps its members in step (a new colleague joins, a deleted one leaves). The Agents page has a "Team
  channel" button for a person with two or more. The person talks to the lead; the lead asks colleagues, and their answers
  arrive in the same conversation. Writing `@name` tells the lead who the person wants; the composer still sends to the lead.
- **Memories.** Each digital employee keeps up to 100 short memories (500 characters each); the newest 30 are in front of it
  at the start of every run. It adds with `memory_remember` and drops its own with `memory_forget`; its owner reads, adds,
  corrects and deletes on its Memories page; the lead can read a colleague's and ask, through Requests, to reword or delete
  one. Passwords, keys, card numbers and account numbers are refused (the marketplace's scanner plus a check for "the
  password is ..."): a net, not a guarantee. Audit rows say which memory and who, never the text.

What is **not** verified: all of this is tested at the store, route and component level. It has not been run end to end
against a real model in a signed-in browser, because the build environment has neither. The first thing to do on a
deployed copy is open the team channel with a lead and two colleagues and ask for something that spans two roles.

## Not done

- A message `@`-mentioned to a colleague is not sent to that colleague directly; it goes to the lead, which asks them.
- Colleagues talking to each other freely. They can ask each other in the team channel only when the chain depth allows.
- Translations. The roles are in English; an employee answers in the language it is written to, but the instruction is English.
- Anything that moves money, contacts a customer on its own, or reaches outside the building still waits for the owner's
  hand (docs/ark/01-product-decisions.md).
