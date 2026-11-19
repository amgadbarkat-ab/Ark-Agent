# Stripe tiers, agent limits and phone meters (v0.1.49)

Status: claimed

Ordered by Amgad, 19 Nov 06:31 Athens. Built by sub-agent G for PE with Matt Pocock's skills (`/tdd`).
Branch `claude/stripe-tiers-149` from `origin/claude/control-board-149` (daf9cd0).

## What
1. Ark Team tiers 5 / 10 / 20 agents per seat (EUR 100 / 140 / 200 per seat a month). Limit on the
   install = agents per seat x seats. ArkAgent and Enterprise unchanged. `maxActiveBots` unchanged.
2. Licence keys carry an optional signed `maxAgents` (5, 10, 20). A team key without it counts as 5.
   Trials: the signed profile's roster size when it has one, otherwise 5.
3. The server refuses every new digital employee past the limit (create, an approved save_bot
   proposal, duplicate, marketplace hire), with an audit row and an English and Greek sentence. It never
   removes, hides or stops an existing one.
4. blackark.uk webhook: the price table carries `max_agents`; `customer.subscription.updated` re-signs
   at once; deleted and payment failure handled.
5. Buy page: the customer picks the tier. The old price is not offered.
6. Phone usage to Stripe meters (display only), queued and retried, never fatal.
7. Control Board: tier, max agents, seats, agents in use, balance, minutes this month; customers per tier.

## Seams under test (from the brief)
- `shared/plans.ts` pure functions: the tier table, `agentLimitFor`, the notices. Catches price and
  limit drift.
- `shared/activation.ts` `readActivationCode`: `maxAgents` read and checked.
- Server: `createActivationService` with the guarded profile store (integration, real Postgres): at the
  limit, above it after a downgrade, each tier, seats x tier, an old key, a trial.
- blackark-checkin `test.sh`: the PHP endpoints over HTTP, with a stand-in Stripe.
- Control Board: its pages and summary functions, with stand-in export data.

## Decisions
- Counted: digital employees people made (an owner, not deleted), hidden or not. The deployment's own
  built-in employees (no owner) are not counted.
- Seeding a signed trial roster is not refused: the roster is where the trial's limit comes from.
- Hosted deployments (no activation) have no agent limit, as before.
