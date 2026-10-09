# The desktop app, for a first customer demo

Written 2026-10-09. What a customer sees, what has to exist before they can see it, what has been checked
and what has not, and the few things only the owner can decide. Read the last section first if you only
have a minute.

## What the customer sees

1. A **Welcome** card: the company's animation on a dark panel (the rack, then the globe, then the BlackArk
   mark), the ArkAgent character beside the name, "Your own AI coworkers, on this computer.", and one button.
2. **Choose a coworker type** (the Bot that comes with it), then **Install**. On a computer with no container
   engine, ArkAgent installs one itself (Podman on Windows and on Apple-silicon Macs). On Windows that may
   ask to turn on a Windows feature and restart once; the app says so in plain words and carries on after.
3. It **downloads the release** (the application, its database, Ark Hub and the Bots' images) and starts it.
   The first run is the slow one: the images are large (the one the coworkers' computers run is about 500 MB compressed on its own), so allow a long first download.
4. **Choose the AI** the coworkers use (a key the customer owns, or a sign-in with a provider that allows it).
   Choosing starts everything, and a one-line question proves it answers.
5. The window becomes ArkAgent itself: the same app the web service serves, running on this computer. Nothing
   asks the customer to sign in to anything, and nothing leaves the computer except what the coworkers do
   with the tools and the AI the customer connected.

## What has to exist before they can see it

| Piece | State | Who |
| --- | --- | --- |
| The installers (Windows, macOS, Linux) | **Build in CI from this branch**; unsigned. See "What was checked". | done; signing needs certificates (20-accounts-and-keys.md) |
| A published release: the application's source at a tag, the six container images, and `container-images.json` | **Not made yet.** `publish-release.yml` makes all three, but only runs on the main branch, from a reviewed release pull request. | the owner approves a pull request, then runs the release (below) |
| A place the customer's computer can download that release from without logging in | **Not decided.** The release lives in a private repository and a private registry today, so a customer's computer is refused. | the owner (below) |
| The AI the demo will use | The presenter's own key (OpenAI, Anthropic or Google), or the customer's. | the owner |
| A computer to demo on | Windows 10 or 11, 64-bit, with virtualisation switched on and, as a sensible floor that nobody has measured, 8 GB of memory; or an Apple-silicon Mac. An **Intel Mac** cannot get an engine installed for it (Podman publishes Arm packages only), so it needs Docker Desktop first. | the presenter |

## Making the first release

The pipeline is the inherited one and it is careful on purpose: nothing is published by hand.

1. **Open a pull request from `claude/intelligent-archimedes-681fim` into `main` and merge it.** Until the
   code is on `main`, GitHub does not even list the workflows, so none of them can be started. I do not open
   pull requests unless asked; this is the one that is needed.
2. **Actions, "Create release PR", Run workflow**, `minor` (so the first Ark release is 0.1.0). It reads
   the notes under `## Unreleased` in `CHANGELOG.md` (the first entry is written for Ark), moves the version
   and opens a release pull request.
3. **Review and merge that pull request.** Merging runs the full test suite against that commit, builds the
   application image and the six component images (for Intel/AMD and for Arm), pins them by digest,
   writes `container-images.json`, tags the commit, creates the GitHub Release, and then builds the three
   desktop installers and attaches them to it.
4. **Make the downloads reachable.** See the next section.

Cost: the desktop build is the expensive part on a private repository (the Mac runner counts ten times). A
full run is on the order of a few hundred billed minutes; a free personal account has 2,000 a month. Making
the repository public would make it free.

## Where the customer's computer downloads from: a decision

The desktop app downloads three things with no login: the release's source (at
`github.com/<repo>/archive/refs/tags/<tag>.tar.gz`), `container-images.json` (a release asset), and the
images (from `ghcr.io/<owner>/ark-*`). **For a private repository all three are refused.** This is how the
app was designed (the installer stays small, and the deployment moves forward without a new installer), so the
choices are about where the public copy lives:

| Option | What it means | Good | Cost |
| --- | --- | --- | --- |
| **A. Make this repository public** | Everything in it, including `docs/ark` (the pen-test findings, the pricing and the competitor notes), becomes public. | Nothing to build; the free Actions minutes. | The internal documents would have to be moved out first, and the code is public. |
| **B. A second, public repository for releases** (recommended) | Only what a customer's computer needs is published there: the deployment's source (`docker-compose.yml`, `server`, `app`, `worker`, `shared`, `examples`, the lockfile and the scripts), the images, the installers. This repository stays private. A job in the pipeline copies the sanitised tree across on each release. The app is built with `ARK_RELEASE_REPO=<owner>/<that repo>` (the app already supports this). | Internal documents stay internal. | One more repository, one access token for the job, and a decision about what the public tree contains. I can write the job once the repository exists. |
| **C. Keep it private, for the presenter only** | The presenter downloads the installer and the release files while signed in to GitHub, puts them in the install folder by hand, and signs the container engine in to the registry. The customer sees it run on the presenter's computer. | Needs no decision about publishing. | Not something a customer can install. Fiddly, so only for a first demo. |

Whatever is chosen, **the customer's computer receives the application's source** (the server and app run on
it as ordinary processes), which is how the product was built. If the company does not want customers to hold
the source, the desktop has to ship compiled programs instead; that is a change of design, not of settings.

## Warnings the first customer will see (the installers are not signed)

- **Windows:** SmartScreen shows "Windows protected your PC". Choose **More info**, then **Run anyway**. The
  publisher reads "unknown" until the company's signing is in place.
- **macOS:** the first open is refused. In **System Settings, Privacy & Security**, scroll down and choose
  **Open Anyway**, then confirm. (Recent macOS versions removed the old "Control-click, Open" shortcut.)
- Both go away once the company has a Windows signing identity and an Apple Developer ID
  (20-accounts-and-keys.md). Until then, for a demo in front of a customer, the presenter should install it
  beforehand and show it running.

## What was checked, and what was not

Checked, here:

- The desktop crate compiles for **Windows** (cross-checked for the `x86_64-pc-windows-gnu` target, library,
  binaries and tests), passes `cargo fmt` and `cargo clippy -D warnings`, and 453 of the 461 unit tests that run here pass.
  The other 8 fail only because this sandbox has no IPv6 and runs as root, which tests assert against.
- The Linux package builds and carries the company's icon and the publisher Value Data IKE.
- The Welcome screen in a real browser, with software WebGL: the animation runs through the mark, the rack and
  the globe, falls back to the company's tile with no WebGL, and shows one still frame under "reduce
  motion". Its tests and the window's own (148) pass.

The first two runs on GitHub (macOS, Windows and Linux) found three real problems that nothing run on Linux
could have: the Windows job's PowerShell did not expand a variable the build-version step used (now bash), a
macOS-only test still listed the services without the hub, and two tests still expected the removed Claude and
ChatGPT plan sign-ins to start (they now assert the refusal). In the same runs the app, the macOS disk image
(its version and ad-hoc signature verified), the Windows installer and the Linux package all built.

Not checked, and the first real run will say:

- **macOS has never been cross-checked from here** (the toolchain needs Apple's SDK), so the CI run is the first
  compile of the macOS-only code with today's changes.
- **Nothing has been run end to end on Windows or macOS**: the engine installation, the download of the release,
  starting the stack, a conversation. That needs a real release to download (above) and a real computer.
  The inherited tests cover these steps piece by piece; the walk through all of them has not been done by anyone.
- The installers are unsigned, and the release pipeline has never run (no workflow has ever run on `main`).
- The `ai.copilotkit.openbot.desktop` identifier is still the app's identity on disk (data folder, keychain
  entries); it changes once the owner confirms the new one (20-accounts-and-keys.md), and before the first release.

## Decisions only the owner can make

1. **Let me open the pull request into `main`** (and merge it, or merge it yourself). Nothing else can start.
2. **Where the public copy lives**: A, B or C above. I recommend B.
3. **Which AI the demo uses**, and whose key. A key goes into the app's own setup screen on the demo
   computer, never into this repository or a message to me.
4. **The identifier** (the open question in 20-accounts-and-keys.md), so the app's data and keychain entries
   are named for the company before anybody installs it for real.
5. **Signing**, when there is time: the lead times in 20-accounts-and-keys.md are the long pole for a
   warning-free install.
