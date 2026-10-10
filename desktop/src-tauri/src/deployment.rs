//! Putting the deployment on disk, which is not what the installer carries.
//!
//! The installer stays small: a Tauri binary and nothing else. What it needs to run a deployment —
//! `docker-compose.yml`, `server`, `app`, `worker`, the tenant package — is fetched on first run and
//! kept beside it, at a version this app records. Two things follow from that split, and both are
//! the reason for it: the download stays a download rather than becoming part of every installer,
//! and the deployment can be moved forward on its own without shipping a new app.
//!
//! What is fetched is the release's own source tarball, at a tag. Not `main`: an app that pulls
//! whatever is on a branch this morning is not a version anybody can be given, and the images the
//! stack runs are pinned per release, so the tree that names them has to be pinned too.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// Written beside the deployment so the app can tell what it already put there.
const STAMP: &str = ".openbot-deployment";

/// The release asset that says which images this version runs.
///
/// Kept beside the deployment because the tree does not contain it: `docker-compose.yml` names
/// `openbot-supervisor:latest` and friends as defaults, which are local build names that exist on a
/// developer's machine and nowhere else. A desktop install has never built anything, so without
/// this file Compose asks Docker Hub for images that are not there and reports a denial, which
/// reads as an authentication problem and is not one.
const IMAGES: &str = "container-images.json";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Installed {
    pub version: String,
}

/// Where Ark's releases are published, as a GitHub `owner/name`.
///
/// Fixed when the app is built (`ARK_RELEASE_REPO`), and overridable on a machine with the same
/// variable in its own environment, which is how a company that mirrors releases points its people at
/// the mirror. A value that is not `owner/name` is ignored rather than used to build an address from:
/// this string ends up in a URL the app downloads and runs code from.
pub const DEFAULT_RELEASE_REPO: &str = "amgadbarkat-ab/ark-agent";

pub fn release_repo() -> String {
    release_repo_from(
        std::env::var("ARK_RELEASE_REPO").ok().as_deref(),
        option_env!("ARK_RELEASE_REPO"),
    )
}

fn release_repo_from(runtime: Option<&str>, built: Option<&str>) -> String {
    let well_formed = |value: &str| {
        let mut parts = value.split('/');
        let (Some(owner), Some(name), None) = (parts.next(), parts.next(), parts.next()) else {
            return false;
        };
        [owner, name].iter().all(|part| {
            !part.is_empty()
                && !part.starts_with('.')
                && part
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        })
    };
    [runtime, built]
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|value| well_formed(value))
        .unwrap_or(DEFAULT_RELEASE_REPO)
        .to_string()
}

/// Where the company serves its own releases from, when it does: an `https` address that the
/// per-version folders sit under (`<base>/<version>/source.tar.gz`, `<base>/<version>/container-images.json`,
/// and `<base>/latest.json` naming the newest version).
///
/// Fixed when the app is built (`ARK_RELEASE_BASE_URL`) and overridable on a machine with the same
/// variable. The company's customers download ArkAgent from its website and nowhere else, and its
/// repository is private, so a customer's computer cannot be sent to GitHub. When this is set it wins
/// over [`release_repo`]; a value that is not a plain `https` address is ignored, because this string
/// ends up in a URL the app downloads and runs code from.
pub fn release_base() -> Option<String> {
    release_base_from(
        std::env::var("ARK_RELEASE_BASE_URL").ok().as_deref(),
        option_env!("ARK_RELEASE_BASE_URL"),
    )
}

fn release_base_from(runtime: Option<&str>, built: Option<&str>) -> Option<String> {
    let well_formed = |value: &str| {
        let Some(rest) = value.strip_prefix("https://") else {
            return false;
        };
        let mut parts = rest.split('/');
        let host = parts.next().unwrap_or_default();
        let (name, port) = match host.split_once(':') {
            Some((name, port)) => (name, Some(port)),
            None => (host, None),
        };
        let name_ok = !name.is_empty()
            && name.split('.').all(|label| {
                !label.is_empty()
                    && !label.starts_with('-')
                    && !label.ends_with('-')
                    && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            });
        let port_ok = match port {
            None => true,
            Some(port) => {
                !port.is_empty() && port.len() <= 5 && port.chars().all(|c| c.is_ascii_digit())
            }
        };
        name_ok
            && port_ok
            && parts.all(|segment| {
                !segment.is_empty()
                    && segment != "."
                    && segment != ".."
                    && segment
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
            })
    };
    [runtime, built]
        .into_iter()
        .flatten()
        .map(str::trim)
        .map(|value| value.trim_end_matches('/'))
        .find(|value| well_formed(value))
        .map(str::to_string)
}

/// The tarball a release is installed from: the company's own copy when it serves one, otherwise
/// the one GitHub publishes for a tag.
///
/// A release asset rather than a branch, and https rather than git, so nothing needs a git client
/// or credentials to get a deployment.
pub fn tarball_url(version: &str) -> String {
    tarball_url_from(release_base().as_deref(), &release_repo(), version)
}

fn tarball_url_from(base: Option<&str>, repo: &str, version: &str) -> String {
    match base {
        Some(base) => format!("{base}/{version}/source.tar.gz"),
        None => format!("https://github.com/{repo}/archive/refs/tags/{version}.tar.gz"),
    }
}

/// Where the release publishes its image manifest.
pub fn images_url(version: &str) -> String {
    images_url_from(release_base().as_deref(), &release_repo(), version)
}

fn images_url_from(base: Option<&str>, repo: &str, version: &str) -> String {
    match base {
        Some(base) => format!("{base}/{version}/{IMAGES}"),
        None => format!("https://github.com/{repo}/releases/download/{version}/{IMAGES}"),
    }
}

/// Where the newest version is named: `latest.json` beside the release folders when the company
/// serves its own, otherwise GitHub's "latest release" answer. Both carry a `tag_name`.
pub fn latest_url() -> String {
    latest_url_from(release_base().as_deref(), &release_repo())
}

fn latest_url_from(base: Option<&str>, repo: &str) -> String {
    match base {
        Some(base) => format!("{base}/latest.json"),
        None => format!("https://api.github.com/repos/{repo}/releases/latest"),
    }
}

pub fn images_path(root: &Path) -> PathBuf {
    root.join(IMAGES)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Image {
    pub reference: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Images {
    pub version: String,
    pub images: BTreeMap<String, Image>,
}

/// The Compose variable each published image answers to.
///
/// A published name on the left, a Compose variable on the right, because the two vocabularies are
/// different and neither is going to change to suit the other.
pub const IMAGE_VARIABLES: [(&str, &str); 6] = [
    ("server", "SERVER_IMAGE"),
    ("hub", "HUB_IMAGE"),
    ("supervisor", "SUPERVISOR_IMAGE"),
    ("agent-computer", "COMPUTER_IMAGE"),
    ("agent-bot", "BOT_IMAGE"),
    ("agent-langgraph", "LANGGRAPH_IMAGE"),
];

/// Read the manifest laid down beside the deployment and turn it into Compose variables.
///
/// Digests, not tags. A tag can be moved to point at a different image after the version that was
/// tested; a digest is the image that was tested.
pub fn image_variables(root: &Path) -> Result<Vec<(String, String)>, String> {
    let text = std::fs::read_to_string(images_path(root))
        .map_err(|error| format!("could not read {}: {error}", images_path(root).display()))?;
    let manifest: Images = serde_json::from_str(&text)
        .map_err(|error| format!("{IMAGES} is not readable: {error}"))?;
    pin(&manifest)
}

/// One published image's reference, digest-pinned, from the manifest beside the deployment.
///
/// Every image reference comes from here, whether Compose reads it or the shell runs it directly.
/// The alternative was a name built from a version, and an engine given an unqualified name looks
/// it up on Docker Hub: `openbot-agent-langgraph-agui:v0.0.8` became
/// `docker.io/library/openbot-agent-langgraph-agui`, and the person was shown "requested access to
/// the resource is denied", which reads as a credentials problem and is not one.
///
/// An image this release does not publish is named as that. It is the honest answer and the
/// actionable one: the alternative is somebody debugging registry permissions for an image that
/// was never pushed.
pub fn reference(root: &Path, published: &str) -> Result<String, String> {
    let text = std::fs::read_to_string(images_path(root))
        .map_err(|error| format!("could not read {}: {error}", images_path(root).display()))?;
    let manifest: Images = serde_json::from_str(&text)
        .map_err(|error| format!("{IMAGES} is not readable: {error}"))?;
    manifest
        .images
        .get(published)
        .map(|image| image.reference.clone())
        .ok_or_else(|| {
            format!(
                "ArkAgent {} does not include {published}.",
                manifest.version
            )
        })
}

/// Every image the stack runs, or a failure that names the one that is missing.
///
/// Refusing a partial manifest rather than filling the gaps from Compose's defaults: a stack that
/// runs four published images and one local build is neither the released version nor a build, and
/// the difference would only show up as behaviour nobody can reproduce.
pub fn pin(manifest: &Images) -> Result<Vec<(String, String)>, String> {
    let mut pinned = Vec::new();
    for (published, variable) in IMAGE_VARIABLES {
        let image = manifest.images.get(published).ok_or_else(|| {
            format!(
                "{IMAGES} for {} names no {published} image.",
                manifest.version
            )
        })?;
        pinned.push((variable.to_string(), image.reference.clone()));
    }
    Ok(pinned)
}

pub fn stamp_path(root: &Path) -> PathBuf {
    root.join(STAMP)
}

/// What version is already there, if any.
pub fn installed(root: &Path) -> Option<Installed> {
    std::fs::read_to_string(stamp_path(root))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
}

pub fn record(root: &Path, version: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(root)?;
    let stamp = Installed {
        version: version.to_string(),
    };
    std::fs::write(
        stamp_path(root),
        serde_json::to_string(&stamp).unwrap_or_default(),
    )
}

/// Whether anything needs fetching.
///
/// Answered from the stamp rather than by looking for files, so a half-extracted directory from an
/// interrupted download is replaced rather than trusted: the stamp is written last, and its absence
/// means the fetch did not finish.
///
/// The image manifest is the one exception. A deployment laid down by an app that predates it has a
/// stamp that matches and no manifest, and re-fetching is a better answer than an error about a
/// file the person has never heard of.
pub fn needs_fetch(root: &Path, wanted: &str) -> bool {
    if !images_path(root).exists() {
        return true;
    }
    match installed(root) {
        Some(found) => found.version != wanted,
        None => true,
    }
}

/// Everything the three host processes and Compose need from the tree.
///
/// Named rather than "the whole repository" because most of it is not needed to run: the charts, the
/// docs, the tests and the Dockerfiles are not part of a deployment, and copying them makes the
/// directory look like a place to develop rather than a place something runs.
pub const REQUIRED: [&str; 4] = ["docker-compose.yml", "server", "app", "worker"];

/// The rest of what a deployment needs, which is not what it is checked for.
pub const ALSO_COPIED: [&str; 8] = [
    "shared",
    // The app's config generator reads the privacy notice and the terms from here every time it
    // builds or serves, and stops with ENOENT without them. Only this folder of `docs`.
    "docs/legal",
    "examples",
    "package.json",
    "bun.lock",
    "scripts",
    // Every package's tsconfig extends this one. Without it vite fails inside `parseExtends`, in a
    // stack trace that names the parser and not the missing file.
    "tsconfig.base.json",
    "bunfig.toml",
];

/// Fetch the tagged tarball and lay the deployment out under `root`.
///
/// The stamp is written last. Anything that fails before that leaves a directory without one, which
/// `needs_fetch` treats as absent, so an interrupted download is retried rather than half-run.
pub fn fetch(root: &Path, version: &str) -> Result<(), String> {
    let body = get(&tarball_url(version)).map_err(|error| {
        format!("could not fetch {version}: {error}. Is that a released version?")
    })?;

    std::fs::create_dir_all(root)
        .map_err(|error| format!("could not make {}: {error}", root.display()))?;

    unpack(root, &body)?;

    fetch_images(root, version)?;

    record(root, version).map_err(|error| format!("could not record the version: {error}"))
}

/// Where an archive entry may be written under `root`, or `None` when it is not
/// part of a deployment.
///
/// The traversal is refused here rather than after the fact. `Path::join`
/// followed by `starts_with` compares components and does not resolve `..`, so
/// `root.join("app/../../elsewhere")` starts with `root` and still lands outside
/// it -- which made the check that was there read as a guard without being one.
/// Every component of a path inside the tree is an ordinary name, so anything
/// else (`..`, an absolute path, a Windows drive prefix) is refused outright.
fn destination_in(root: &Path, path: &Path) -> Result<Option<PathBuf>, String> {
    // GitHub wraps everything in one directory named for the tag. Strip it, so the deployment
    // lands at `root` rather than at `root/OpenBot-0.0.7`.
    let mut parts = path.components();
    parts.next();
    let relative: PathBuf = parts.collect();
    if relative.as_os_str().is_empty() {
        return Ok(None);
    }

    // Nothing outside `root`, whatever the archive says. A tarball is somebody else's file.
    if relative
        .components()
        .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return Err(format!(
            "the download tried to write outside {}: {}",
            root.display(),
            path.display()
        ));
    }

    // Only what a deployment needs. The rest of the tree is a place to develop, not to run.
    // `starts_with` compares whole path components, so `docs/legal` takes in `docs/legal/x.md` and
    // not `docs/legal-notes/x.md`, and not the rest of `docs`.
    let wanted = REQUIRED
        .iter()
        .chain(ALSO_COPIED.iter())
        .any(|entry| relative.starts_with(entry));
    if !wanted {
        return Ok(None);
    }

    Ok(Some(root.join(&relative)))
}

/// Lay the tarball's deployment files out under `root`.
///
/// Split from [`fetch`] so the part that decides where somebody else's archive
/// is allowed to write can be exercised without a network.
pub fn unpack(root: &Path, body: &[u8]) -> Result<(), String> {
    let decoder = flate2::read::GzDecoder::new(body);
    let mut archive = tar::Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|error| format!("the download is not readable: {error}"))?;

    for entry in entries {
        let mut entry = entry.map_err(|error| format!("could not read the download: {error}"))?;
        let path = entry
            .path()
            .map_err(|error| format!("could not read a path in the download: {error}"))?
            .into_owned();

        let Some(destination) = destination_in(root, &path)? else {
            continue;
        };
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("could not make {}: {error}", parent.display()))?;
        }
        entry
            .unpack(&destination)
            .map_err(|error| format!("could not write {}: {error}", destination.display()))?;
    }

    Ok(())
}

/// Fetch the image manifest and check it before anything depends on it.
///
/// Parsed here rather than at start-up so a release missing an image fails while the person is
/// still looking at a screen that says what is being fetched, not later inside Compose's output.
fn fetch_images(root: &Path, version: &str) -> Result<(), String> {
    let body = get(&images_url(version))
        .map_err(|error| format!("could not fetch the image list for {version}: {error}"))?;
    let manifest: Images = serde_json::from_slice(&body)
        .map_err(|error| format!("the image list for {version} is not readable: {error}"))?;
    pin(&manifest)?;
    std::fs::write(images_path(root), &body)
        .map_err(|error| format!("could not write {IMAGES}: {error}"))
}

/// How long to wait for a server to answer before an attempt is given up.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// How long a download may go without a single byte arriving before it is called stalled.
///
/// Deliberately not a limit on how long a download may take. The client used to be built with
/// reqwest's default, which for the blocking client is thirty seconds for the whole request, body
/// included. The container engine's installer is tens of megabytes, so on an ordinary home
/// connection every attempt was cut off part-way and reported as "error decoding response body",
/// which is reqwest's wording for a body that ended in a timeout.
const STALL_TIMEOUT: Duration = Duration::from_secs(60);

/// Tries before a download is reported as failed, and the pause (times the try number) between them.
const ATTEMPTS: u32 = 3;
const PAUSE: Duration = Duration::from_secs(2);

/// Fetch a URL into memory.
///
/// Shared with `install.rs`, which fetches the engine's installers through it and then checks their
/// digests. One client, one user agent, one set of TLS defaults.
///
/// A connection that drops, or a server that answers 5xx or 429, is tried again; a 404 or any other
/// refusal is not, because asking again gets the same answer.
pub fn get(url: &str) -> Result<Vec<u8>, String> {
    get_with(url, CONNECT_TIMEOUT, STALL_TIMEOUT, ATTEMPTS, PAUSE)
}

fn get_with(
    url: &str,
    connect: Duration,
    stall: Duration,
    attempts: u32,
    pause: Duration,
) -> Result<Vec<u8>, String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("openbot-desktop")
        .timeout(None::<Duration>)
        .connect_timeout(connect)
        .build()
        .map_err(|error| format!("could not prepare the download: {error}"))?;

    let mut last = String::new();
    for attempt in 1..=attempts {
        match attempt_once(&client, url, stall) {
            Attempt::Done(body) => return Ok(body),
            Attempt::Stop(message) => return Err(message),
            Attempt::Retry(message) => last = message,
        }
        if attempt < attempts {
            std::thread::sleep(pause * attempt);
        }
    }
    Err(format!("{last} (tried {attempts} times)"))
}

enum Attempt {
    Done(Vec<u8>),
    /// Worth asking again: the connection or the server, not the address.
    Retry(String),
    Stop(String),
}

/// What the thread doing the download tells the one waiting for it.
enum Progress {
    Status(reqwest::StatusCode),
    Chunk(Vec<u8>),
    End,
    Failed(String),
}

/// One try, on a thread of its own so that the wait for each piece can be bounded.
///
/// The blocking client has no per-read timeout, and its whole-request timeout is the thing that
/// cut the engine installer off. So the download runs on a worker and this function waits for each
/// message from it for at most `stall`. A worker whose connection has gone quiet is left to end when
/// the connection does; its channel is dropped, so it stops at the next thing it tries to send.
fn attempt_once(client: &reqwest::blocking::Client, url: &str, stall: Duration) -> Attempt {
    let (sender, receiver) = std::sync::mpsc::channel();
    let worker_client = client.clone();
    let address = url.to_string();
    std::thread::spawn(move || {
        use std::io::Read;
        let mut response = match worker_client.get(&address).send() {
            Ok(response) => response,
            Err(error) => {
                let _ = sender.send(Progress::Failed(format!(
                    "could not reach {address}: {error}"
                )));
                return;
            }
        };
        let status = response.status();
        if sender.send(Progress::Status(status)).is_err() || !status.is_success() {
            return;
        }
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            match response.read(&mut buffer) {
                Ok(0) => {
                    let _ = sender.send(Progress::End);
                    return;
                }
                Ok(read) => {
                    if sender
                        .send(Progress::Chunk(buffer[..read].to_vec()))
                        .is_err()
                    {
                        return;
                    }
                }
                Err(error) => {
                    let _ = sender.send(Progress::Failed(format!(
                        "the download did not finish: {error}"
                    )));
                    return;
                }
            }
        }
    });

    let quiet = || {
        Attempt::Retry(format!(
            "the download did not finish: nothing arrived from {url} for {} seconds",
            stall.as_secs_f32().max(0.1)
        ))
    };
    let mut body = Vec::new();
    loop {
        match receiver.recv_timeout(stall) {
            Ok(Progress::Status(status)) if status.is_success() => {}
            Ok(Progress::Status(status)) => {
                let message = format!("{url} answered {status}");
                return if status.is_server_error() || status.as_u16() == 429 {
                    Attempt::Retry(message)
                } else {
                    Attempt::Stop(message)
                };
            }
            Ok(Progress::Chunk(piece)) => body.extend_from_slice(&piece),
            Ok(Progress::End) => return Attempt::Done(body),
            Ok(Progress::Failed(message)) => return Attempt::Retry(message),
            Err(_) => return quiet(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(names: &[&str]) -> Images {
        Images {
            version: "v0.0.7".into(),
            images: names
                .iter()
                .map(|name| {
                    (
                        (*name).to_string(),
                        Image {
                            reference: format!("ghcr.io/copilotkit/openbot-{name}@sha256:abc"),
                        },
                    )
                })
                .collect(),
        }
    }

    #[test]
    fn a_deployment_without_an_image_manifest_is_fetched_again_rather_than_refused() {
        let dir = std::env::temp_dir().join(format!("openbot-manifest-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let _ = std::fs::remove_file(images_path(&dir));
        record(&dir, "v0.0.7").unwrap();

        assert!(
            needs_fetch(&dir, "v0.0.7"),
            "a matching stamp is not enough when the images are not named"
        );

        std::fs::write(images_path(&dir), "{}").unwrap();
        assert!(!needs_fetch(&dir, "v0.0.7"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn every_service_compose_can_run_is_pinned_to_a_published_digest() {
        let published: Vec<&str> = IMAGE_VARIABLES.iter().map(|(name, _)| *name).collect();
        let pinned = pin(&manifest(&published)).expect("a complete manifest pins");
        assert_eq!(pinned.len(), IMAGE_VARIABLES.len());
        for (_, reference) in &pinned {
            assert!(
                reference.contains("@sha256:"),
                "a tag is not a version: {reference}"
            );
        }
    }

    #[test]
    fn a_manifest_missing_an_image_is_refused_rather_than_filled_in_from_compose() {
        // Compose's defaults are local build names. Falling back to them would run four published
        // images beside one that does not exist, and say nothing about the difference.
        let missing = pin(&manifest(&[
            "server",
            "hub",
            "supervisor",
            "agent-computer",
            "agent-bot",
        ]));
        let error = missing.expect_err("an incomplete manifest is not a deployment");
        assert!(error.contains("agent-langgraph"), "{error}");
    }

    #[test]
    fn releases_come_from_ark_unless_a_well_formed_other_place_is_named() {
        assert_eq!(release_repo_from(None, None), DEFAULT_RELEASE_REPO);
        assert_eq!(
            release_repo_from(Some("example-org/ark-mirror"), None),
            "example-org/ark-mirror"
        );
        // A machine's own setting wins over the one the app was built with.
        assert_eq!(release_repo_from(Some("a/b"), Some("c/d")), "a/b",);
        assert_eq!(release_repo_from(None, Some("c/d")), "c/d");
        // Anything that is not `owner/name` is not a place to download and run code from.
        for bad in [
            "",
            "no-slash",
            "a/b/c",
            "/b",
            "a/",
            "a/../b",
            "a b/c",
            "https://evil.example/x",
            "a/b?x=1",
            "a/b#frag",
            "a@evil/b",
        ] {
            assert_eq!(
                release_repo_from(Some(bad), None),
                DEFAULT_RELEASE_REPO,
                "{bad:?}"
            );
        }
        // A bad runtime value falls through to the built one, not past it.
        assert_eq!(release_repo_from(Some("a/../b"), Some("c/d")), "c/d");
    }

    #[test]
    fn no_address_the_app_downloads_from_names_copilotkit() {
        for url in [
            tarball_url_from(None, DEFAULT_RELEASE_REPO, "v1.0.0"),
            images_url_from(None, DEFAULT_RELEASE_REPO, "v1.0.0"),
            tarball_url_from(
                Some("https://get.example.test"),
                DEFAULT_RELEASE_REPO,
                "v1.0.0",
            ),
        ] {
            assert!(!url.to_lowercase().contains("copilotkit"), "{url}");
            assert!(url.starts_with("https://"), "{url}");
        }
    }

    #[test]
    fn the_company_can_serve_its_own_releases_and_nothing_else_is_a_place_to_download_from() {
        assert_eq!(release_base_from(None, None), None);
        assert_eq!(
            release_base_from(Some("https://get.example.test/releases/"), None).as_deref(),
            Some("https://get.example.test/releases"),
            "a trailing slash is not part of the address"
        );
        // A machine's own setting wins over the one the app was built with.
        assert_eq!(
            release_base_from(Some("https://a.test"), Some("https://b.test")).as_deref(),
            Some("https://a.test")
        );
        assert_eq!(
            release_base_from(None, Some("https://b.test:8443/x")).as_deref(),
            Some("https://b.test:8443/x")
        );
        // Anything that is not a plain https address is not somewhere to download and run code from.
        for bad in [
            "",
            "get.example.test",
            "http://get.example.test",
            "ftp://get.example.test",
            "https://",
            "https:///x",
            "https://-bad.test",
            "https://bad..test",
            "https://user@get.example.test",
            "https://get.example.test:port",
            "https://get.example.test/../x",
            "https://get.example.test//x",
            "https://get.example.test/x?y=1",
            "https://get.example.test/x#frag",
            "https://get.example.test/a b",
        ] {
            assert_eq!(release_base_from(Some(bad), None), None, "{bad:?}");
        }
        // A bad runtime value falls through to the built one, not past it.
        assert_eq!(
            release_base_from(Some("http://nope.test"), Some("https://b.test")).as_deref(),
            Some("https://b.test")
        );
    }

    #[test]
    fn a_company_copy_is_laid_out_one_folder_per_version() {
        let base = Some("https://get.example.test/releases");
        assert_eq!(
            tarball_url_from(base, "o/r", "v0.1.0"),
            "https://get.example.test/releases/v0.1.0/source.tar.gz"
        );
        assert_eq!(
            images_url_from(base, "o/r", "v0.1.0"),
            "https://get.example.test/releases/v0.1.0/container-images.json"
        );
        assert_eq!(
            latest_url_from(base, "o/r"),
            "https://get.example.test/releases/latest.json"
        );
        // With no company copy the addresses are GitHub's, unchanged.
        assert_eq!(
            tarball_url_from(None, "o/r", "v0.1.0"),
            "https://github.com/o/r/archive/refs/tags/v0.1.0.tar.gz"
        );
        assert_eq!(
            images_url_from(None, "o/r", "v0.1.0"),
            "https://github.com/o/r/releases/download/v0.1.0/container-images.json"
        );
        assert_eq!(
            latest_url_from(None, "o/r"),
            "https://api.github.com/repos/o/r/releases/latest"
        );
    }

    #[test]
    fn the_image_manifest_is_fetched_from_the_same_version_as_the_tree() {
        let url = images_url_from(None, DEFAULT_RELEASE_REPO, "v0.0.7");
        assert!(url.contains("/download/v0.0.7/"), "{url}");
        assert!(url.ends_with("container-images.json"), "{url}");
    }

    #[test]
    fn the_tarball_is_a_tag_rather_than_a_branch() {
        let url = tarball_url_from(None, DEFAULT_RELEASE_REPO, "v0.0.7");
        assert!(url.contains("/refs/tags/v0.0.7"), "{url}");
        assert!(!url.contains("/heads/"), "a branch is not a version: {url}");
        assert!(
            url.starts_with("https://"),
            "must not need a git client: {url}"
        );
    }

    #[test]
    fn an_empty_directory_needs_fetching() {
        let dir = std::env::temp_dir().join(format!("openbot-dep-empty-{}", std::process::id()));
        assert!(needs_fetch(&dir, "v0.0.7"));
    }

    /// One tarball, written as bytes rather than through `tar::Builder`.
    ///
    /// The builder refuses a path holding `..` outright ("paths in archives must
    /// not have `..`"), which is the right thing for it to do and makes it the
    /// wrong tool for this: an archive that climbs out of its root is not
    /// produced by a careful writer, it is produced by somebody writing the
    /// bytes. A ustar header is a name, a size, a checksum and padding.
    fn tarball(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut tar: Vec<u8> = Vec::new();
        for (name, body) in entries {
            let mut header = [0u8; 512];
            let bytes = name.as_bytes();
            assert!(bytes.len() < 100, "the test uses short names");
            header[..bytes.len()].copy_from_slice(bytes);
            header[100..107].copy_from_slice(b"0000644"); // mode
            header[108..115].copy_from_slice(b"0000000"); // uid
            header[116..123].copy_from_slice(b"0000000"); // gid
            let size = format!("{:011o}", body.len());
            header[124..135].copy_from_slice(size.as_bytes());
            header[136..147].copy_from_slice(b"00000000000"); // mtime
            header[156] = b'0'; // a regular file
            header[257..263].copy_from_slice(b"ustar ");
            header[263..265].copy_from_slice(b"00");
            // The checksum is computed with its own field read as spaces.
            header[148..156].copy_from_slice(b"        ");
            let sum: u32 = header.iter().map(|byte| u32::from(*byte)).sum();
            let checksum = format!("{sum:06o}  ");
            header[148..156].copy_from_slice(checksum.as_bytes());

            tar.extend_from_slice(&header);
            tar.extend_from_slice(body);
            tar.resize(tar.len().div_ceil(512) * 512, 0); // pad to a block
        }
        tar.extend_from_slice(&[0u8; 1024]); // two empty blocks end an archive

        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        std::io::Write::write_all(&mut encoder, &tar).expect("the test archive is compressed");
        encoder.finish().expect("the test archive is compressed")
    }

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("openbot-unpack-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("the scratch directory is made");
        dir
    }

    #[test]
    fn the_test_archive_really_carries_the_traversal() {
        // Guards the guard: if the archive did not hold `..` the next test would
        // pass for the wrong reason.
        let archive = tarball(&[("OpenBot-0.0.8/app/../../escaped.txt", b"owned")]);
        let decoder = flate2::read::GzDecoder::new(&archive[..]);
        let mut tar = tar::Archive::new(decoder);
        let paths: Vec<String> = tar
            .entries()
            .expect("the test archive is readable")
            .map(|entry| {
                entry
                    .expect("an entry")
                    .path()
                    .expect("a path")
                    .display()
                    .to_string()
            })
            .collect();
        assert_eq!(paths, ["OpenBot-0.0.8/app/../../escaped.txt"]);
    }

    #[test]
    fn a_download_that_climbs_out_of_the_root_is_refused() {
        // `root.join("app/../../x")` starts with `root` -- `Path::starts_with`
        // compares components and does not resolve `..` -- so asking where the
        // path landed cannot answer this. The entry sits under `app`, which is a
        // directory a deployment wants, so the wanted-list does not stop it
        // either.
        let dir = scratch("escape");
        let root = dir.join("deployment");
        std::fs::create_dir_all(&root).expect("the root is made");

        let archive = tarball(&[("OpenBot-0.0.8/app/../../escaped.txt", b"owned")]);
        let outcome = unpack(&root, &archive);

        let climbed = dir.join("escaped.txt");
        let written = climbed.exists();
        let _ = std::fs::remove_dir_all(&dir);

        assert!(!written, "a file was written above the root");
        assert!(outcome.is_err(), "the traversal was accepted: {outcome:?}");
        assert!(
            outcome.unwrap_err().contains("outside"),
            "the refusal should say what it refused"
        );
    }

    #[test]
    fn an_ordinary_download_still_lands_where_it_should() {
        let dir = scratch("ordinary");

        let archive = tarball(&[
            ("OpenBot-0.0.8/app/index.ts", b"export {}"),
            ("OpenBot-0.0.8/docker-compose.yml", b"services: {}"),
            // Not part of a deployment: skipped, not refused.
            ("OpenBot-0.0.8/docs/readme.md", b"# hi"),
            (
                "OpenBot-0.0.8/docs/legal-notes/x.md",
                b"# not the legal folder",
            ),
            // The one folder of docs/ that is: the app's config generator reads it.
            ("OpenBot-0.0.8/docs/legal/privacy-notice.md", b"# privacy"),
        ]);
        unpack(&dir, &archive).expect("an ordinary download is laid out");

        let app = std::fs::read_to_string(dir.join("app/index.ts")).ok();
        let compose = std::fs::read_to_string(dir.join("docker-compose.yml")).ok();
        let legal = std::fs::read_to_string(dir.join("docs/legal/privacy-notice.md")).ok();
        let other_docs =
            dir.join("docs/readme.md").exists() || dir.join("docs/legal-notes").exists();
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(app.as_deref(), Some("export {}"));
        assert_eq!(compose.as_deref(), Some("services: {}"));
        assert_eq!(
            legal.as_deref(),
            Some("# privacy"),
            "the app's generator needs it"
        );
        assert!(
            !other_docs,
            "the rest of the tree is not part of a deployment"
        );
    }

    #[test]
    fn a_recorded_version_is_not_fetched_again() {
        let dir = std::env::temp_dir().join(format!("openbot-dep-same-{}", std::process::id()));
        record(&dir, "v0.0.7").unwrap();
        std::fs::write(images_path(&dir), "{}").unwrap();
        assert!(!needs_fetch(&dir, "v0.0.7"));
        assert!(
            needs_fetch(&dir, "v0.0.8"),
            "a newer version has to be fetched"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_interrupted_fetch_is_replaced_rather_than_trusted() {
        // Files present, stamp absent: what an interrupted extract leaves behind. The stamp is
        // written last precisely so this case is distinguishable.
        let dir = std::env::temp_dir().join(format!("openbot-dep-partial-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("server")).unwrap();
        std::fs::write(dir.join("docker-compose.yml"), "services: {}\n").unwrap();
        assert!(
            needs_fetch(&dir, "v0.0.7"),
            "a directory with no stamp is not a deployment"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unreadable_stamp_is_treated_as_absent_rather_than_fatal() {
        let dir = std::env::temp_dir().join(format!("openbot-dep-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(stamp_path(&dir), "{ not json").unwrap();
        assert!(installed(&dir).is_none());
        assert!(needs_fetch(&dir, "v0.0.7"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_shared_tsconfig_is_copied_or_every_package_fails_to_parse_its_own() {
        assert!(
            ALSO_COPIED.contains(&"tsconfig.base.json"),
            "app, server and worker all extend it"
        );
    }

    #[test]
    fn what_is_required_is_what_the_stack_actually_runs() {
        // The check in stack.rs looks for exactly these, so the two cannot drift apart.
        for entry in ["docker-compose.yml", "server", "app", "worker"] {
            assert!(
                REQUIRED.contains(&entry),
                "{entry} is not required but is checked for"
            );
        }
        assert!(
            !REQUIRED.contains(&"charts"),
            "a deployment is not a place to develop"
        );
        assert!(!REQUIRED.contains(&"docs"));
    }

    /// What a scripted server does with one connection.
    type Answer = Box<dyn Fn(&mut std::net::TcpStream) + Send>;

    /// An HTTP server whose answers are scripted, the nth connection getting the nth answer.
    /// Returns its address and how many connections it has served.
    fn scripted_server(
        script: Vec<Answer>,
    ) -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        use std::io::Read;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let served = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&served);
        std::thread::spawn(move || {
            for answer in script {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                counted.fetch_add(1, Ordering::SeqCst);
                // Each answer on its own thread, so one that stalls does not hold up the next try.
                std::thread::spawn(move || {
                    let mut request = [0u8; 2048];
                    let _ = stream.read(&mut request);
                    answer(&mut stream);
                });
            }
        });
        (address, served)
    }

    fn write_all(stream: &mut std::net::TcpStream, bytes: &[u8]) {
        use std::io::Write;
        let _ = stream.write_all(bytes);
        let _ = stream.flush();
    }

    #[test]
    fn a_slow_download_that_keeps_arriving_is_not_cut_off() {
        // Three pieces, 400 ms apart: 1.2 s in all, longer than the 1 s stall limit, with no gap
        // longer than it. A limit on the whole request would have ended this one; that was the bug.
        let (address, served) = scripted_server(vec![Box::new(|stream| {
            write_all(stream, b"HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\n");
            for piece in [b"abc", b"def", b"ghi"] {
                std::thread::sleep(Duration::from_millis(400));
                write_all(stream, piece);
            }
        })]);
        let body = get_with(
            &address,
            Duration::from_secs(5),
            Duration::from_secs(1),
            1,
            Duration::ZERO,
        )
        .unwrap();
        assert_eq!(body, b"abcdefghi");
        assert_eq!(served.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn a_download_that_stops_arriving_is_tried_again_and_then_reported() {
        let stalls = || -> Answer {
            Box::new(|stream| {
                write_all(stream, b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc");
                std::thread::sleep(Duration::from_millis(1500));
            })
        };
        let (address, served) = scripted_server(vec![stalls(), stalls()]);
        let error = get_with(
            &address,
            Duration::from_secs(5),
            Duration::from_millis(300),
            2,
            Duration::ZERO,
        )
        .unwrap_err();
        assert!(error.contains("the download did not finish"), "{error}");
        assert!(error.contains("tried 2 times"), "{error}");
        assert_eq!(served.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[test]
    fn a_server_error_is_tried_again_and_a_refusal_is_not() {
        let answer = |status: &'static str, body: &'static str| -> Answer {
            Box::new(move |stream| {
                let text = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\n\r\n{body}",
                    body.len()
                );
                write_all(stream, text.as_bytes());
            })
        };

        let (address, served) = scripted_server(vec![
            answer("503 Service Unavailable", ""),
            answer("200 OK", "fine"),
        ]);
        let body = get_with(
            &address,
            Duration::from_secs(5),
            Duration::from_secs(5),
            3,
            Duration::ZERO,
        )
        .unwrap();
        assert_eq!(body, b"fine");
        assert_eq!(served.load(std::sync::atomic::Ordering::SeqCst), 2);

        let (address, served) =
            scripted_server(vec![answer("404 Not Found", ""), answer("200 OK", "late")]);
        let error = get_with(
            &address,
            Duration::from_secs(5),
            Duration::from_secs(5),
            3,
            Duration::ZERO,
        )
        .unwrap_err();
        assert!(error.contains("404"), "{error}");
        assert_eq!(served.load(std::sync::atomic::Ordering::SeqCst), 1);
    }
}
