# Competitor comparison

Written 2026-10-08. Sources: each product's public website, read on that date, plus press coverage
for Hark. These are marketing pages: **nothing here was installed or tested**, and claims are the
vendors' own.

## Summary

| | openbot.run | Bops (bops.bot) | Hark (hark.com) | James AI (jamesai.si) |
| --- | --- | --- | --- | --- |
| What it is | Desktop app that runs a team of AI agents | "Business ops run by bots": inbox, invoices, CRM, reports | Personal assistant (Hark Pro) and a browser agent (Handoff) | "AI employee" built per job by the vendor's engineers |
| Where it runs | On the user's computer (macOS, Windows, Linux) | Mac app; each bot has a cloud computer | Cloud; web, iOS and Android apps | Cloud; own computer per customer |
| LLM choice | Open: Codex/ChatGPT, Claude, Gemini and Grok plan sign-in; free OpenCode models with no account; any OpenAI-compatible endpoint; Ollama; LM Studio | Not stated; AI credit is bundled in the plan | Vendor's own model; no choice | Not stated; no choice |
| Price | Free ($0); user pays their LLM provider | Free; Pro $20/mo; Max $200/mo, each with AI credit billed "at what it costs us" | Free tier plus subscription (from press) | From $500/mo per job, priced on a call |
| Data location | Local; provider sees prompts | Cloud | Cloud, with end-to-end encryption claim | Cloud |
| Source | Public, PolyForm Noncommercial 1.0.0 | Public (OrgoAI/bops-oss), FSL-1.1-ALv2 | Closed | Closed |
| Distinctive idea | Provider-agnostic, local-first, agents hand work to each other, built-in browser | Each bot has its own email, phone number, computer and memory | Polished consumer app, approvals before actions, custom "Panels" | Done-for-you service priced against a human salary; flowchart jobs with approval steps |

## Notes per product

**openbot.run.** Closest to what we want on the desktop: free, local, and the user picks and
switches provider while the agent keeps its workspace and conversation. Marked a "development
preview" that lets agents act without asking each time. It has a marketplace (agents, skills,
plugins) and "hosted servers" plans (a page exists but was not readable). **It is not related to
CopilotKit's OpenBot**, which is a different project with the same name.

**Bops.** Closest to our pricing shape: tiered plans with a fixed number of included computers and
unlimited bots sharing them. Its strength is bots that reach people through email, phone and chat.
Free tier gives 10 hours a month of computer time.

**Hark.** Consumer-focused, cloud-only. Strong on trust features: approval before sensitive
actions, encrypted vault for logins and cards. Handoff gives each user a private sandboxed
computer. Company led by Brett Adcock according to press coverage. Benchmark claims are the
company's own.

**James AI.** A service business rather than software: customers book a call, engineers build the
"employee", and it is priced per job. Always asks the customer before important steps.

## Where Ark differs (by our decisions)

- Both desktop and cloud, plus iOS and Android (Bops and openbot.run cover less).
- Flat EUR 50 / EUR 100 monthly price per user account with a bot-count limit, instead of free (openbot.run),
  credit-based (Bops) or per-job quotes (James).
- Local and free LLM providers by default, so the user pays only Ark.
- A marketplace where Ark sells its own digital employees and users share theirs.

## Ideas worth borrowing (as ideas, not code)

- Switch provider without losing the agent's workspace (openbot.run).
- Per-bot identity: email address, phone number (Bops).
- Approval step before sensitive actions, and an encrypted credential vault (Hark, James).
- Job templates as visible flowcharts (James).

## Sources

- https://openbot.run
- https://bops.bot/
- https://hark.com/login and https://hark.com/ (sign-in page and home page)
- https://jamesai.si/
- Press on Hark: TechCrunch, 5 Aug 2026 and 6 Oct 2026
