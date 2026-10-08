# Moving the desktop app off CopilotKit's services

Written 2026-10-08. The hosted product (browser, cloud) already runs with no CopilotKit service: Ark
Hub replaced Intelligence (Phase 1). The **desktop app has not moved yet**. This lists exactly what
still ties it to CopilotKit, what was removed, and the order to finish it. It is Phase 6 work
(desktop and mobile), and it is blocked on three things that are not code: Ark's brand assets, a
place to publish Ark's own releases, and code-signing certificates.

## Removed

- **Usage telemetry** (2026-10-08). The desktop used to send setup events to
  `telemetry.copilotkit.ai`, on by default. The native emitter, its schema, the window's reporting,
  the server's relay and the probe tools are deleted, and every process the desktop starts is told
  telemetry is off. A test asserts the window sends no telemetry command whatever the person does.
  If Ark wants usage statistics later it should be its own, opt-in, and designed then.
- **Chat-plan sign-ins** (see 04-llm-providers.md).

## Still tied to CopilotKit

| What | Where | Replace with |
| --- | --- | --- |
| Setup signs the person in to CopilotKit Intelligence and picks or creates a project to obtain an API key | `desktop/src-tauri/src/intelligence.rs`, the "connect" step in `desktop/src/App.tsx`, `MANAGED_INTELLIGENCE_API_URL` | Nothing to sign in to. The desktop generates the hub's keys itself (as `scripts/hub.sh` does) and runs Ark Hub on loopback beside the server. The "connect" step disappears. |
| Organisation sign-in against a CopilotKit authority | `organization_auth.rs`, `desktop/src/OrganizationSignIn.tsx` | Not needed on a person's own computer. Cloud sign-in (Microsoft Entra ID) is a web concern (Phase 7). |
| The release it installs: source archive, image list and "latest" tag come from `github.com/CopilotKit/OpenBot` | `deployment_release.rs`, `deployment.rs` | Ark's own release location, with a signed manifest. |
| The images it pulls are `ghcr.io/copilotkit/openbot-*` | the release manifest, `deployment::reference` | Images published by Ark's own pipeline to Ark's own registry (Azure Container Registry fits the hosting plan). |
| The CI that builds and publishes those images | `.github/workflows/publish-release.yml`, `release.yml`, `desktop*.yml` | New workflows in Ark's repository, publishing to Ark's registry. These currently name CopilotKit's registry and must not be run as they are. |
| Identity of the app: name "OpenBot", bundle id `ai.copilotkit.openbot.desktop`, icons, updater keys | `tauri.conf.json`, `desktop/src/marks`, signing config | Ark's brand (brand assets are decision D8, later), a new bundle id, and Ark's own signing keys. |
| Helm values and CI that point at `api.intelligence.copilotkit.ai` | `charts/openbot/ci/*.yaml`, `.github/workflows/ci.yml` | Ark Hub's address. |

## Order

1. **Brand assets** arrive (name, logo, colours, domain). Nothing below ships without them.
2. **Ark Hub into the release.** Package the hub with the one-container image and the desktop's
   deployment source (Phase 1's open item), so there is something to run locally.
3. **Desktop runs the hub** and drops the connect step and the organisation step. Verify with the
   exit test below.
4. **Release pipeline** in Ark's repository: build, sign, publish images and a signed manifest.
5. **Desktop reads Ark's releases**; new bundle id, name, icons and updater keys. Windows and macOS
   signing certificates and Apple notarisation are needed here (a cost and a lead time).
6. **Mobile** (Phase 6) clients talk to the cloud service and, for a person's own computer, to a
   relay; they have none of these dependencies.

## Exit test

Start the desktop app on a machine whose network blocks `*.copilotkit.ai` and every other host
except the one Ark publishes releases to, and complete setup and a conversation. The same test for
the browser product is the Phase 1 exit test and already holds at the code level.
