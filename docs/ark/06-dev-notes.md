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

## Building the mobile apps in the sandbox

What can be built here and what cannot is in `mobile/README.md` and `docs/ark/19-mobile.md`. The quirks:

- **Android builds fully here.** Java 21 and Gradle are installed; the Android SDK (command-line tools,
  platform 36, build-tools 36.0.0) is not, and is downloaded from `dl.google.com` into a scratch directory,
  with `ANDROID_HOME` pointing at it. Check the download against the checksum in
  `https://dl.google.com/android/repository/repository2-3.xml`.
- **`repo.maven.apache.org` answers 429** to this sandbox (it rate-limits the proxy's address), which
  fails the dependency step. The same repository at `https://repo1.maven.org/maven2/` answers, so build
  with a local init script that lists it first (`./gradlew -I mirror.init.gradle ...`). Do not commit that
  script: nothing outside this sandbox needs it.
- **iOS cannot be compiled here** (no Xcode), but Capacitor's CLI makes the Xcode project on Linux, under
  Bun as well as Node. `bun mobile/scripts/prepare-ios.ts` runs end to end and the generated `Info.plist`
  can be parsed with Python's `plistlib` as a check.
- **Browser sign-in pages can be walked** with the security harness's seeded server (`startTarget` in
  `server/tests/security/harness.ts`, with extra environment such as `ARK_IOS_URL_SCHEME`) and Playwright's
  Chromium. A custom-scheme navigation (`arkapp://...`) does not load in Chromium, but the navigation
  request can be observed.

## Known test failures in this sandbox (not product bugs)

Eight failures remain here and are not product bugs: seven tests (the proxy and websocket handshake
tests, which need IPv6; the voice and dictation idle-timeout tests; one path-handling test) and one
file that cannot load because `agent-mastra`'s dependencies are not installed (the desktop app's are
installed with `bun install` inside `desktop/`).

Starting the server by hand: use `bun --env-file=../.env src/production-entry.ts` from `server/`, not
`src/index.ts` (the entry evaluates an ESM-only dependency first). Stop a process by its id; never
`pkill -f` a pattern that appears in your own command line.
Everything else passes (6,022 at the time of writing, 2026-10-09, with 96 skipped). A full run under load
can also time out two or three tests that wait on a clock (the run-gate "a run at the limit" waits, the page
frame retention sweep): they pass alone, every time, and are not a regression. Run `bun test` from the repository
root: `bunfig.toml` there holds the preload that Base UI dialogs need, and bun reads it from the
current directory only.
