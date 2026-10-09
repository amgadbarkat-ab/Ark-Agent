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

## Still tied to CopilotKit

| What | Where | Replace with |
| --- | --- | --- |
| The release it installs: source archive, image list and "latest" tag come from `github.com/CopilotKit/OpenBot` | `deployment_release.rs`, `deployment.rs` | Ark's own release location, with a signed manifest. |
| The images it pulls are `ghcr.io/copilotkit/openbot-*` | the release manifest, `deployment::reference` | Images published by Ark's own pipeline to Ark's own registry (Azure Container Registry fits the hosting plan). The manifest must now also name a `hub` image; a release without one is refused by name. |
| The CI that builds and publishes those images | `.github/workflows/publish-release.yml`, `release.yml`, `desktop*.yml` | New workflows in Ark's repository, publishing to Ark's registry. These currently name CopilotKit's registry and must not be run as they are. |
| Identity of the app: name "OpenBot", bundle id `ai.copilotkit.openbot.desktop`, icons, updater keys | `tauri.conf.json`, `desktop/src/marks`, signing config | Ark's brand (brand assets are decision D8, later), a new bundle id, and Ark's own signing keys. |
| The "Get setup help" link goes to CopilotKit's issue tracker | `desktop/src/Problem.tsx` | Ark's support page (a decision for the owner). |

## Order

1. **Brand assets** arrive (name, logo, colours, domain). Nothing below ships without them.
2. ~~Ark Hub into the release.~~ **Done in the tree**: the compose service, the image variable and the
   manifest check. The first Ark release has to publish the hub image beside the others.
3. ~~Desktop runs the hub and drops the connect step and the organisation step.~~ **Done** (above).
4. **Release pipeline** in Ark's repository: build, sign, publish images (including the hub) and a
   signed manifest.
5. **Desktop reads Ark's releases**; new bundle id, name, icons and updater keys. Windows and macOS
   signing certificates and Apple notarisation are needed here (a cost and a lead time).
6. **Mobile** (Phase 6) clients talk to the cloud service and, for a person's own computer, to a
   relay; they have none of these dependencies.

## What was checked, and what was not

Checked: the Rust unit tests (with `cargo fmt` and `cargo clippy -D warnings`), the window's tests,
and that the server is configured to the hub with the key the hub is given. A fix found on the way:
a machine whose kernel has no IPv6 at all made Start fail with "could not find available local ports"
(it now treats that as "no IPv6 loopback", as it already did for the two error kinds Rust names), which
also lets the start tests run on such a machine.

**Not checked:** the desktop has not been run end to end against real Docker or Podman on Windows or
macOS from here, and the hub container has not been started by the desktop. The first run of the new
release on each platform is where that will be found, and is part of the exit test below.

## Exit test

Start the desktop app on a machine whose network blocks `*.copilotkit.ai` and every other host
except the one Ark publishes releases to, and complete setup and a conversation. The same test for
the browser product is the Phase 1 exit test and already holds at the code level.
