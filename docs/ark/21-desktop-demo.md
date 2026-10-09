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
| A published release: the application's source at a tag, the container images, and `container-images.json` | **Not made yet.** `publish-release.yml` makes all three (and `source.tar.gz` and `latest.json`, the files the website serves), but only runs on the main branch, from a reviewed release pull request. | the owner approves a pull request, then runs the release (below) |
| A place on the company's website the customer's computer downloads from without logging in | **Decided: the website, nothing else (2026-10-09).** The app supports it (`ARK_RELEASE_BASE_URL`); the folder, the images' registry and the build setting are still to be made. See "Where the downloads live". | the owner |
| The AI the demo will use | The presenter's own key (OpenAI, Anthropic or Google), or the customer's. | the owner |
| A computer to demo on | Windows 10 or 11, 64-bit, with virtualisation switched on and, as a sensible floor that nobody has measured, 8 GB of memory; or an Apple-silicon Mac. An **Intel Mac** cannot get an engine installed for it (Podman publishes Arm packages only), so it needs Docker Desktop first. | the presenter |

## Making the first release

The pipeline is the inherited one and it is careful on purpose: nothing is published by hand.

1. **Open a pull request from `claude/intelligent-archimedes-681fim` into `main` and merge it.** Until the
   code is on `main`, GitHub does not even list the workflows, so none of them can be started. The owner
   approved this pull request on 2026-10-09; merging it is the owner's.
2. **Actions, "Create release PR", Run workflow**, `minor` (so the first Ark release is 0.1.0). It reads
   the notes under `## Unreleased` in `CHANGELOG.md` (the first entry is written for Ark), moves the version
   and opens a release pull request.
3. **Review and merge that pull request.** Merging runs the full test suite against that commit, builds the
   application image and the six component images (for Intel/AMD and for Arm), pins them by digest,
   writes `container-images.json`, tags the commit, creates the GitHub Release, and then builds the three
   desktop installers and attaches them to it.
4. **Put the downloads on the website.** See the next section.

Cost: the desktop build is the expensive part on a private repository (the Mac runner counts ten times). A
full run is on the order of a few hundred billed minutes; a free personal account has 2,000 a month. Making
the repository public would make it free.

## Where the downloads live: the company's website

**Decided by the owner (2026-10-09): customers download the app from the company's own website and nowhere
else.** The repository and its container packages are private, so a customer's computer could not use GitHub
anyway. There are two kinds of download, and both come from the website:

1. **The installer** a person clicks (`.exe`, `.dmg`, `.AppImage`). The owner chose the way customers get it:
   a **"Download the ArkAgent app" button on the two product pages**,
   `https://www.blackark.uk/product-arkagent.html` and `https://www.blackark.uk/product-ark-team.html`.
   The button's code is in `docs/ark/site/download-button.html`, ready for the site administrator to paste in
   (it uses the pages' own button styles and picks the right file for the visitor's computer). It links to
   three files that never change name, because every release attaches them under these names:

   ```
   https://www.blackark.uk/get/ArkAgent-windows-x64-setup.exe      (about 4 MB)
   https://www.blackark.uk/get/ArkAgent-macos-arm64.dmg            (about 6 MB; Apple-silicon Macs)
   https://www.blackark.uk/get/ArkAgent-linux-x64.AppImage         (about 95 MB)
   ```

2. **The release the installer then fetches**, which is why the installer stays small. The app downloads
   two files, then starts the stack. It is built with `ARK_RELEASE_BASE_URL` (a repository **variable** of
   that name, read by `desktop.yml`) set to **`https://www.blackark.uk/get/release`**, so it never contacts
   GitHub.

   ```
   https://www.blackark.uk/get/release/latest.json                      {"tag_name": "v0.1.0"}
   https://www.blackark.uk/get/release/v0.1.0/source.tar.gz             the deployment's files only (no internal documents)
   https://www.blackark.uk/get/release/v0.1.0/container-images.json     the images this version runs, pinned by digest
   ```

   The release job produces `source.tar.gz` and `latest.json` beside `container-images.json`, and the stable
   installer names above, all attached to the GitHub Release. **Publishing a version is therefore copying
   files**: from the release into the site's `get/` folder (the three installers), `get/release/` (`latest.json`)
   and `get/release/<version>/` (the other two). `scripts/release-source.test.ts` keeps the archive's contents
   equal to what the app unpacks. The app accepts only an `https` address, and the site must serve the files
   unchanged (no on-the-fly compression of the `.tar.gz`).

   **What the site administrator does, once:** make the folders `get/` and `get/release/` (files are served
   as they are, no page), and paste `docs/ark/site/download-button.html` into both product pages. **For each
   release:** upload the files as above. **What the owner does, once:** in the repository's Settings, Secrets
   and variables, Actions, **Variables**, add `ARK_RELEASE_BASE_URL` with the value above. It has to exist
   before the release is made, because the installers are built with it.

**One piece is not on the website: the images.** They are large (one is about 500 MB compressed), so they
are pulled by the container engine from a registry, not downloaded as files, and the registry has to allow an
anonymous pull. **Decided by the owner (2026-10-09): GitHub's registry, with the packages made public; the
move to an Azure registry comes later.** A package's visibility is a setting of its own, so the repository
stays private. After the first release, in GitHub open **your profile, Packages**, and for each of these
choose **Package settings, Danger Zone, Change visibility, Public**: `ark-server`, `ark-hub`,
`ark-supervisor`, `ark-agent-computer`, `ark-agent-bot`, `ark-agent-langgraph` (the six the desktop app
runs; the other `ark-agent-*` packages are for the hosted service and can stay private). GitHub offers no
way to do this from a script. **I have not confirmed that GitHub allows it for packages made by a private
repository on a personal account**; the first release will show it, and if it refuses, the fallback is the
Azure registry. Anyone could then pull these images, which is the same as saying a customer's computer holds
them, as it must.

Whatever is chosen, **the customer's computer receives the application's source** (the server and app run on
it as ordinary processes), which is how the product was built. If the company does not want customers to hold
the source, the desktop has to ship compiled programs instead; that is a change of design, not of settings.

**Until the first release exists, a demo does not need any of this.** Copy `latest.json`, a folder named for the
version with the two files in it, to any `https` address (a storage account, a page on the website) and build the
installer with that address; or install on the presenter's own computer with the files already in the
install folder (the stamp `.openbot-deployment` and `container-images.json` make the app skip the download).

## Warnings the first customer will see (the installers are issued unsigned)

**Decided by the owner (2026-10-09):** the first installers go out unsigned and the certificates come later.
The warnings below are what a customer sees until then, so the first customers should be told to expect them.

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
- The identifier is now `blackark.arkagent` (the owner's choice), so the app's data folder and keychain entries are
  named for ArkAgent; no earlier installation of this app exists, so nothing is migrated.

## What is still open

1. **Merge the pull request into `main`** (approved and opened 2026-10-09; its checks are being fixed).
   Nothing else can start before this.
2. **The site administrator**: the `get/` folders and the button on the two product pages (above).
3. **The repository variable** `ARK_RELEASE_BASE_URL` (above), before the first release.
4. **Making the six packages public** after the first release (above).
5. **Which AI the demo uses**, and whose key. A key goes into the app's own setup screen on the demo
   computer, never into this repository or a message to me.
6. **Signing**, later: certificates are the long pole for a warning-free install (20-accounts-and-keys.md).
