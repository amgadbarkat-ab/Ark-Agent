# Ark Hub

The conversation service behind Ark. It stores every conversation, streams live runs to the
browser, and keeps one run at a time per conversation. It replaces CopilotKit's hosted
"Intelligence" service, so Ark owns its conversations and runs without any third-party service.

## How it fits

```
browser ──(REST + socket)──▶ API server ──▶ hub ◀──(socket)── bot runner
                                  │            │
                                  ▼            ▼
                             app database   hub database
```

The OpenBot API server uses CopilotKit's MIT-licensed SDK, which talks to a conversation service
over a documented-by-code protocol: a REST API plus Phoenix-channel sockets. The hub implements that
protocol, so the SDK and the app run unchanged and only point at the hub instead.

## What it serves

| Piece | Where | What for |
| --- | --- | --- |
| REST API | `/api/...` | threads, messages, run locks, join tokens, entitlements |
| Runner socket | `/runner/websocket` | a bot run streams its events in; each batch is acknowledged once stored |
| Client socket | `/client/websocket` | the browser joins a conversation (replay, then live) or its thread list |
| Health | `/health` | for the process supervisor |

Design rules:

- **The event log is the truth.** Messages are rebuilt from it on read (`src/fold.ts`), so a
  replay can never disagree with history.
- **Storing is idempotent.** An event is identified by the id the runner stamps on it, so a resend
  after a dropped acknowledgement changes nothing.
- **Acknowledge only what is durable.** A runner holds events until the hub says they are stored.
- **One run at a time per conversation.** A lock with an expiry; released when the run ends.
- **A token opens one door.** Browser join tokens are signed and name a single conversation (or one
  person's thread list). API and runner access use a separate secret key.
- **A person's conversations are theirs.** Every read and write is scoped to the user id.

## Run it

```sh
HUB_API_KEY=$(openssl rand -base64 32) \
HUB_JOIN_SECRET=$(openssl rand -base64 32) \
HUB_DATABASE_URL=postgres://user:pass@localhost:5432/ark_hub \
bun hub/src/index.ts
```

Migrations are applied on start. Point the API server at it:

```
INTELLIGENCE_API_URL=http://localhost:7100
INTELLIGENCE_GATEWAY_WS_URL=ws://localhost:7100
INTELLIGENCE_API_KEY=<the same value as HUB_API_KEY>
```

| Variable | Default | |
| --- | --- | --- |
| `HUB_API_KEY` | required, 32+ chars | bearer key for the API server and runner |
| `HUB_JOIN_SECRET` | required, 32+ chars | signs browser join tokens |
| `HUB_DATABASE_URL` | `DATABASE_URL` | its own database, separate from the app's |
| `HUB_PORT` | `7100` | |
| `HUB_JOIN_TOKEN_TTL_SECONDS` | `86400` | |
| `HUB_DEFAULT_LOCK_TTL_SECONDS` | `60` | when the caller does not say |
| `HUB_BUS` | `postgres` | how live events travel between sockets. `postgres`: through the database, so any number of hub processes share them. `memory`: inside one process; only right for exactly one |

## Tests

`TEST_DATABASE_URL` must name a dedicated test database; every test file gets its own schema.

```sh
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/ark_test bun test hub/tests
```

`tests/sdk-contract.test.ts` is the one that matters: it drives CopilotKit's own SDK client,
runner and Phoenix browser client against the hub. If the SDK is upgraded, run it first.

## Known limits

- **Several hub processes are supported** (`HUB_BUS=postgres`, the default; `src/shared-bus.ts`). Live
  events cross between processes by `LISTEN/NOTIFY` (one extra connection per process); an event too
  big for a notification (8000 bytes) goes through a short-lived table. A lost connection is answered
  by the conversation sockets themselves: every stored event names its predecessor, so a socket told of an event whose predecessor it never sent reads the log and catches up in order (and does the same for every open conversation when the bus reconnects). What is not replayed is a stop request or a
  thread-list update sent in the gap: at worst a stop that has to be pressed again and a list that
  refreshes on its next change. The processes must share one database and one schema
  (the channel is named for the schema). Tested with two hubs on one database
  (`tests/scale-out.test.ts`), including a lost connection mid-run.
- **Replay sends the whole conversation** when a browser has no cursor. Long conversations should
  be compacted into a snapshot first.
- **Not provided:** memories, managed channels, the inspector's debug endpoints. The app does not
  use them; they answer 404.
- **The SDK's internal API is the contract.** It is pinned (`@copilotkit/runtime` 1.70.1) and the
  contract tests guard it.
