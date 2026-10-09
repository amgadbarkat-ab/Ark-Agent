# Moving the desktop app off CopilotKit's services

Written 2026-10-08, updated 2026-10-09. The hosted product (browser, cloud) already runs with no
CopilotKit service: Ark Hub replaced Intelligence (Phase 1). The **desktop app now runs Ark Hub on the
person's own computer** and asks nobody to sign in to anything (step 3 below, done). This lists what
was removed, what still ties it to CopilotKit and the order to finish it. What is left needs things that
are not code: Ark's brand assets, a place to publish Ark's own releases, and code-signing certificates.

## Removed

- **Usage telemetry** (2026-10-08). The desktop used to send setup events to
  `telemetry.copilotkit.ai`, on by default. The native emitter, its schema, the window's reporting,
  the server's relay and the probe tools are deleted, and every process the desktop starts is told
  telemetry is off. A test asserts the window sends no telemetry command whatever the person does.
  If Ark wants usage statistics later it should be its own, opt-in, and designed then.
- **Chat-plan sign-ins** (see 04-llm-providers.md).
- **The CopilotKit "connect" step, the project picker and the organisation sign-in** (2026-10-09).
  Setup is now: welcome, choose the Bot, install, choose the AI (choosing it starts OpenBot), then a
  question to prove it answers. `intelligence.rs`, `organization_auth.rs` and
  `OrganizationSignIn.tsx` are deleted, with the commands that served them. The window sends
  `start_stack` a folder, a model and a Bot, and nothing about a conversation service; a test walks
  every screen and asserts none of them mentions CopilotKit, a project key or an organisation.

## How the conversation service works now

- `docker-compose.yml` has a `hub` service (image from `hub/Dockerfile`, published as `HUB_IMAGE` in the
  release's `container-images.json`). It is in the desktop's list of services, so it starts with the
  database and is stopped with everything else. A developer's `scripts/start.sh` names its own services
  and runs the hub as a process (`scripts/hub.sh`), so the two never compete for the port.
- The desktop **mints the hub's two secrets itself** (`HUB_API_KEY`, `HUB_JOIN_SECRET`), once per
  installation like the other minted secrets, keeps them in the machine's credential store and never in
  `.env`. The server is pointed at `http://127.0.0.1:<hub port>` under the names it has always read
  (`INTELLIGENCE_API_URL`, `INTELLIGENCE_GATEWAY_WS_URL`, `INTELLIGENCE_API_KEY`, the last being the same
  value as `HUB_API_KEY`). These are overwritten on every start, which is what moves an installation set
  up by an earlier version onto the hub.
- The hub has its own port (`HUB_PORT`, default 7100) chosen and remembered like the others, and its own
  database (`ark_hub`) on the same Postgres, created on first start.
- **Conversations an earlier version kept in CopilotKit's service are not moved.** They were never on this
  machine. A person upgrading starts with an empty history; their Bots, settings and saved keys stay.
- An `OPENBOT_ORGANIZATION_AUTH_URL` left in `.env` by an earlier version is removed on the next start and
  never followed.

## Done on the release side (2026-10-09)

- The desktop reads Ark's releases: the repository is `amgadbarkat-ab/ark-agent` unless the app was
  built with `ARK_RELEASE_REPO=owner/name`, and a machine can override that with the same variable
  (anything that is not `owner/name` is ignored, because the string ends up in an address the app
  downloads and runs code from). A test asserts no address it downloads from names CopilotKit.
- `publish-release.yml` publishes to the registry of whoever owns the repository
  (`ghcr.io/<owner>/ark` and `ghcr.io/<owner>/ark-<service>`), attests them, and writes
  `container-images.json` naming the hub among the rest. The chart's default image and the docs say the
  same. CI's boot test no longer points at CopilotKit's hosts.
- The "Get setup help" link is shown only when a build names a support page; it used to go to
  CopilotKit's issue tracker.

## Still tied to CopilotKit, or waiting on the owner

| What | Where | Needs |
| --- | --- | --- |
| Identity of the app: bundle id `ai.copilotkit.openbot.desktop`, updater keys, the wording inside the window | `tauri.conf.json`, `desktop/src`, `src-tauri/src` | **Name and icons are done (2026-10-09):** the installer and window say "Ark Agent" and the icon set is the company's (`brand/README.md`). The bundle id awaits the owner's confirmation of `uk.blackark.arkagent.desktop` (20-accounts-and-keys.md), the updater keys await the release pipeline, and the wording inside the window and the native messages now says Ark Agent (2026-10-09). **Left as they were on purpose, because they are data, not words:** the install folder `~/OpenBot`, the data folders the host-access guard protects, the build-version plist keys, and the tarball names the release fixtures use. Changing the install folder needs a move for anyone who has already installed. |
| Windows signing trusts CopilotKit's Azure tenant and certificate | `desktop-signing.yml` (`azure-federation.json` now names this repository) | Black Ark's own signing: Microsoft Artifact Signing or a certificate authority's cloud signing, set up as 20-accounts-and-keys.md says; then the workflow is changed to it. |
| macOS has no signing or notarisation set up | `desktop.yml` builds ad-hoc signed | An Apple Developer ID certificate and notarisation credentials (20-accounts-and-keys.md names each secret), then a release job that uses them. |
| Installers are built and kept for a week; none is attached to a release | `desktop.yml` | A job that attaches the signed Windows and macOS installers to the GitHub Release, once there are certificates to sign them with. |
| The README and some docs are still the upstream project's | `README.md`, `docs/` | A rewrite once the name is decided. The README still tells a reader to get CopilotKit Intelligence credentials, which Ark no longer needs. |

## Order

1. **Brand assets** arrive (name, logo, colours, domain). Nothing below ships without them.
2. ~~Ark Hub into the release.~~ **Done in the tree**: the compose service, the image variable and the
   manifest check. The first Ark release has to publish the hub image beside the others.
3. ~~Desktop runs the hub and drops the connect step and the organisation step.~~ **Done** (above).
4. ~~Release pipeline in Ark's repository: build, publish images (including the hub) and a manifest.~~
   **Written, not yet run**: nothing here can run GitHub Actions. Signing the installers is the part
   that needs certificates.
5. ~~Desktop reads Ark's releases.~~ **Done.** New bundle id, name, icons and updater keys wait for the
   brand; Windows and macOS signing certificates and Apple notarisation are needed (a cost and a lead
   time).
6. **Mobile** (Phase 6) clients talk to the cloud service and, for a person's own computer, to a
   relay; they have none of these dependencies.

## What was checked, and what was not

Checked:

- The Rust unit tests (with `cargo fmt` and `cargo clippy -D warnings`) and the window's tests; the
  server is configured to the hub with the key the hub is given.
- **The `hub` service, started through the repository's own `docker-compose.yml` on a real engine**:
  it waits for the database to be healthy, creates its own `ark_hub` database, publishes on loopback,
  answers `/health` and `/ready`, accepts the key it was given (`200`) and refuses another (`401`),
  stops cleanly (exit code 0), and `docker compose down` works with none of the secrets in the
  environment, as the desktop runs it. The image used was a stand-in (the same hub sources on the
  host's Bun, because Docker Hub rate-limited the pull of the real base image); the real
  `hub/Dockerfile` is built by CI, which now publishes it (`.github/published-images.json` was missing
  `hub`, which CI would have failed on).
- A fix found on the way: a machine whose kernel has no IPv6 at all made Start fail with "could not
  find available local ports" (it now treats that as "no IPv6 loopback", as it already did for the two
  error kinds Rust names), which also lets the start tests run on such a machine. Compose still
  publishes ports on `[::1]` too, which such a machine refuses; that is the same for the database and
  the computer's port and is not new.

**Not checked:** the desktop has not been run end to end against Docker or Podman on Windows or macOS
from here, and has not been started with the hub image from a real release (there is not one yet). The
first run of the first Ark release on each platform is where that will be found, and is part of the
exit test below.

## Exit test

Start the desktop app on a machine whose network blocks `*.copilotkit.ai` and every other host
except the one Ark publishes releases to, and complete setup and a conversation. The same test for
the browser product is the Phase 1 exit test and already holds at the code level.
