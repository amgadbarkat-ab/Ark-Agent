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

## Not done

- **The primary employee managing the others** (giving them work, reading their jobs and reports, switching their routines
  off, editing or deleting their routines). Today the lead knows the team and leads it in conversation; it has no tools over its
  colleagues. Two things stand in the way and are decisions rather than code: (1) the existing hand-off between employees is
  only offered to built-in employees, not to the ones that run on the shared agent, which is every employee in the desktop
  product, so reaching a colleague needs a new route for a running agent to call back; (2) anything that edits or deletes a
  colleague's work should ask the person first, which needs an approvals design. Proposed first step: read-only tools (team,
  routines, last runs) and switching a routine off, then writes with approval.
- **Team channels with several employees talking to each other.** A channel is pinned to one employee in the app and in the
  conversation store, and the group chat the owner described needs that changed; the database already allows several
  employees in one channel. Not started.
- **Memories.** There is no memory feature to edit or delete yet.
- A rename of "coworker" to "digital employee" everywhere. "Bot" is now "digital employee" in the app, the administrator console,
  server messages and the desktop's messages; "coworker" still appears in some screens (for example the Models page).
- Translations. The roles are in English; an employee answers in the language it is written to, but the instruction is English.
