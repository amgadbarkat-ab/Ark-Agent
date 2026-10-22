//! Choose a release for a new deployment, keep an existing deployment's exact version, and bring it
//! up to this app's own version when the app is newer.

use std::path::Path;

use serde::Deserialize;

use crate::deployment;

/// The release this app was cut from. A desktop release and the deployment it runs share one tag.
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Only new deployments ask which version is newest, and they ask the company's own copy when it
/// serves one (`ARK_RELEASE_BASE_URL`), else GitHub. The fetcher records the exact tag after the
/// source and image manifest have both downloaded successfully; restarts and repairs retain that pin.
/// Uses blocking HTTP, so callers in an async runtime must use a blocking task.
pub fn resolve_version(root: &Path) -> Result<String, String> {
    resolve_version_with(root, APP_VERSION, || {
        let body = deployment::get(&deployment::latest_url())
            .map_err(|error| format!("could not find the latest ArkAgent release: {error}"))?;
        release_tag(&body)
    })
}

fn resolve_version_with(
    root: &Path,
    app_version: &str,
    latest: impl FnOnce() -> Result<String, String>,
) -> Result<String, String> {
    /*
     * AN UPDATED APP USED TO KEEP RUNNING THE OLD SOFTWARE.
     *
     * The installed version was kept for good, so installing a newer ArkAgent replaced the window
     * and nothing behind it: the server, the web app and the digital employees' images stayed at
     * whatever version was first downloaded. Two releases of fixes to what an employee is told
     * never reached the one person testing them, and every report said "no change". The app now
     * brings its deployment up to its own version; an older app leaves a newer deployment alone,
     * because the database has already moved forward with it.
     */
    if let Some(tag) = behind(root, app_version) {
        return Ok(tag);
    }
    match deployment::installed(root) {
        Some(installed) => Ok(installed.version),
        None => latest(),
    }
}

/// This app's own release tag, when the deployment on disk is older than this app.
pub fn behind_app(root: &Path) -> Option<String> {
    behind(root, APP_VERSION)
}

fn behind(root: &Path, app_version: &str) -> Option<String> {
    let installed = deployment::installed(root)?;
    let app = numbers(app_version)?;
    (numbers(&installed.version)? < app)
        .then(|| format!("v{}", app_version.trim_start_matches('v')))
}

/// `v0.1.12` as (0, 1, 12). Anything that is not three numbers is not compared at all.
fn numbers(version: &str) -> Option<(u64, u64, u64)> {
    let core = version.trim().trim_start_matches('v');
    let core = core.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let parsed = (
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    );
    parts.next().is_none().then_some(parsed)
}

fn release_tag(body: &[u8]) -> Result<String, String> {
    #[derive(Deserialize)]
    struct Release {
        tag_name: String,
    }

    let release: Release = serde_json::from_slice(body)
        .map_err(|error| format!("the latest ArkAgent release is not readable: {error}"))?;
    if release.tag_name.trim().is_empty() {
        return Err("the latest ArkAgent release has no version tag".into());
    }
    Ok(release.tag_name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::temp_root;

    fn scratch(label: &str) -> std::path::PathBuf {
        let root = temp_root(label);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn a_fresh_install_selects_latest_without_recording_an_unfinished_download() {
        let root = scratch("release-fresh");
        let version = resolve_version_with(&root, "0.0.9", || Ok("v0.0.9".into())).unwrap();
        assert_eq!(version, "v0.0.9");
        assert!(deployment::installed(&root).is_none());
        assert!(deployment::needs_fetch(&root, &version));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_installed_version_does_not_query_github_or_upgrade() {
        let root = scratch("release-installed");
        deployment::record(&root, "v0.0.7").unwrap();
        std::fs::write(deployment::images_path(&root), "{}").unwrap();
        let version = resolve_version_with(&root, "0.0.7", || panic!("must work offline")).unwrap();
        assert_eq!(version, "v0.0.7");
        assert!(!deployment::needs_fetch(&root, &version));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_missing_manifest_repairs_the_pinned_version() {
        let root = scratch("release-repair");
        deployment::record(&root, "v0.0.7").unwrap();
        let version =
            resolve_version_with(&root, "0.0.7", || panic!("keep the installed pin")).unwrap();
        assert_eq!(version, "v0.0.7");
        assert!(deployment::needs_fetch(&root, &version));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_failed_lookup_is_reported_without_recording_a_version() {
        let root = scratch("release-lookup-failed");
        let error = resolve_version_with(&root, "0.0.9", || Err("GitHub answered 403".into()))
            .expect_err("a failed lookup must not fall back to an old release");
        assert!(error.contains("403"));
        assert!(deployment::installed(&root).is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_updated_app_brings_its_deployment_to_its_own_version_without_asking_github() {
        let root = scratch("release-updated-app");
        deployment::record(&root, "v0.1.10").unwrap();
        std::fs::write(deployment::images_path(&root), "{}").unwrap();
        let version =
            resolve_version_with(&root, "0.1.12", || panic!("the app knows its own version"))
                .unwrap();
        assert_eq!(version, "v0.1.12");
        assert!(deployment::needs_fetch(&root, &version));
        assert_eq!(behind(&root, "0.1.12").as_deref(), Some("v0.1.12"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_older_app_leaves_a_newer_deployment_alone() {
        let root = scratch("release-older-app");
        deployment::record(&root, "v0.1.12").unwrap();
        std::fs::write(deployment::images_path(&root), "{}").unwrap();
        assert_eq!(
            resolve_version_with(&root, "0.1.10", || panic!("keep the installed pin")).unwrap(),
            "v0.1.12"
        );
        assert_eq!(behind(&root, "0.1.10"), None);
        assert_eq!(behind(&root, "0.1.12"), None);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn versions_compare_as_numbers_and_anything_else_is_left_alone() {
        assert!(numbers("v0.1.9") < numbers("v0.1.10"));
        assert_eq!(numbers("0.1.12"), Some((0, 1, 12)));
        assert_eq!(numbers("v1.2.3-rc.1"), Some((1, 2, 3)));
        assert_eq!(numbers("main"), None);
        assert_eq!(numbers("1.2"), None);
        assert_eq!(numbers("1.2.3.4"), None);
        let root = scratch("release-unreadable");
        deployment::record(&root, "nightly").unwrap();
        assert_eq!(behind(&root, "0.1.12"), None);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn this_app_knows_its_own_version() {
        assert!(numbers(APP_VERSION).is_some(), "{APP_VERSION}");
    }

    #[test]
    fn githubs_exact_tag_is_used_instead_of_the_release_title() {
        assert_eq!(
            release_tag(br#"{"name":"OpenBot September release","tag_name":"v0.0.9"}"#).unwrap(),
            "v0.0.9"
        );
    }

    #[test]
    fn missing_or_unreadable_release_metadata_is_refused() {
        for body in [b"not json".as_slice(), b"{}", br#"{"tag_name":" "}"#] {
            assert!(release_tag(body).is_err());
        }
    }

    /// Exercises the production resolver and downloader against GitHub in an empty directory.
    #[test]
    #[ignore = "downloads the latest public release from GitHub"]
    fn live_latest_release_is_downloaded_and_pinned() {
        let root = scratch("release-live");
        let version = resolve_version(&root).expect("resolve the public release");
        assert!(deployment::installed(&root).is_none());
        deployment::fetch(&root, &version).expect("download the tagged deployment and manifest");
        assert_eq!(deployment::installed(&root).unwrap().version, version);
        let images: deployment::Images =
            serde_json::from_slice(&std::fs::read(deployment::images_path(&root)).unwrap())
                .unwrap();
        assert_eq!(images.version, version);
        let package: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.join("package.json")).unwrap()).unwrap();
        assert_eq!(package["version"], version.trim_start_matches('v'));
        for path in deployment::REQUIRED {
            assert!(root.join(path).exists(), "missing {path}");
        }
        assert_eq!(
            resolve_version_with(&root, &version, || panic!("restart must not need GitHub"))
                .unwrap(),
            version
        );
        assert!(!deployment::needs_fetch(&root, &version));
        // The release's own page, not one for the computer to build: what the first real install of
        // 0.1.2 lacked, and what makes the app answer in seconds instead of minutes.
        assert!(
            !deployment::lacks_prebuilt_app(&root),
            "the downloaded deployment has no pre-built web app"
        );
        assert!(root.join("app").join("dist").join("index.html").is_file());
        println!("Downloaded and pinned {version}; tagged source, image manifest, and offline reuse verified.");
        std::fs::remove_dir_all(root).unwrap();
    }
}
