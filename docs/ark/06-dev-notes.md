# Developer notes

How to build, run and test Ark here. Written 2026-10-08.

## Getting a session ready

In a Claude Code on the web session this happens automatically: `.claude/hooks/session-start.sh`
installs the pinned Bun and every dependency, starts the local PostgreSQL, and creates and migrates
the `ark_test` database, then exports `TEST_DATABASE_URL`. It is safe to run again.

Anywhere else:

```sh
bun install && (cd agent-langgraph && bun install) && (cd agent-bot && bun install)
createdb ark_test        # PostgreSQL 16 with pgvector
export TEST_DATABASE_URL=postgres://USER:PASS@localhost:5432/ark_test
DATABASE_URL=$TEST_DATABASE_URL bun server/scripts/migrate.ts
bun test
```

The integration tests need `TEST_DATABASE_URL` and refuse to run without it. It must be migrated
first, or hundreds of tests fail with `relation "users" does not exist`.

## Running the stack

The supported route is `bash scripts/start.sh` (Docker for PostgreSQL and the bot computers, then the
hub, server, worker and app natively). It needs Docker to be able to build images.

Without Docker, each piece runs natively. The settings are in `.env`; `bash scripts/hub.sh secrets`
fills in the hub's keys and points the server at it.

| Piece | Command | Port |
| --- | --- | --- |
| Hub | `bash scripts/hub.sh start` | 7100 |
| Default bot | `cd agent-langgraph && PORT=4201 bun --env-file=../.env src/index.ts` | 4201 |
| API server | `cd server && bun --env-file=../.env src/index.ts` | 3001 |
| App | `cd app && bun --env-file=../.env --bun node_modules/vite/bin/vite.js --host 0.0.0.0` | 3010 |

Run the server's migrations once first: `bun --env-file=.env server/scripts/migrate.ts`. Mark
onboarding done with `POST /api/me/onboarding {"completed":true}` to skip the wizard.

Set `PORT=4201` for the bot: `.env` holds `PORT=3001` for the server and the bot would otherwise take
that port.

## Sandbox quirks (Claude Code on the web)

- **No IPv6.** The app's dev server binds to `::` and reports "port in use". Pass `--host 0.0.0.0`.
  The proxy-related tests also fail here for the same reason.
- **Docker image builds fail** with `SELF_SIGNED_CERT_IN_CHAIN`: the sandbox's network proxy
  re-signs HTTPS traffic with a certificate containers do not trust. Docker is useful here for
  running images, not for building them.
- **`pkill -f` can kill your own shell** if the pattern appears in the command line. Use
  `pkill -f "[b]un ..."` or kill by process id.

## Known test failures in this sandbox (not product bugs)

About ten tests fail here and passed upstream's CI: the proxy and websocket handshake tests (IPv6),
the voice and dictation idle-timeout tests, a path-handling test, and the sample `agent-bot` tests
when its dependencies are not installed. Everything else passes (5,018 at the time of writing).
