//! Automatic updates of the app itself (Amgad, 26 Nov 2026: "any installed app on any customer
//! computer must get the updates we are releasing at all times").
//!
//! - Where: `update.json` beside the release folders on the company's own site
//!   (`ARK_RELEASE_BASE_URL`, the same place the app fetches its server from), because the
//!   repository is private. Each release writes it (`.github/workflows/publish-release.yml`).
//! - Trust: an update is installed only if it is signed with BlackArk's update key, whose public half
//!   is [`UPDATE_PUBLIC_KEY`]; the private half signs in the release build only. The signature must
//!   also name the version it was signed for, so an old genuine build cannot be passed off as new.
//! - When: [`FIRST_CHECK_AFTER`] after start, then every [`CHECK_EVERY`]. Started before anything
//!   else the app does at start-up, so a release that breaks later in start-up still finds its fix.
//! - Recall: a bad release is replaced by publishing a newer, fixed one; installed apps follow
//!   whatever `update.json` on the site names. Taking `update.json` off the site pauses updates.
//! - Then: download, install, and restart at once (Amgad's decision), even while an employee works.
//!   The app's own deployment then follows the new app version, as it does after a manual install.
//!
//! Off while the key or the address is missing: a build without them never updates itself.

use std::time::Duration;

use tauri::{AppHandle, Runtime};
use tauri_plugin_updater::UpdaterExt;

use crate::deployment;

/// BlackArk's update-signing public key, as `tauri signer generate` writes it to the `.pub` file.
/// Empty until BlackArk makes the key (#149); then every release from that one on updates itself.
pub const UPDATE_PUBLIC_KEY: &str = "";

/// How long after start the first check waits: short, so a release that fails soon after start-up
/// still updates to the fix (security review U3), and on its own thread, so start-up is not slowed.
pub const FIRST_CHECK_AFTER: Duration = Duration::from_secs(10);

/// How often the app looks for a new release while it runs.
pub const CHECK_EVERY: Duration = Duration::from_secs(4 * 60 * 60);

/// The address of `update.json` for this build, or None when it has nowhere to look.
pub fn update_endpoint(base: Option<&str>) -> Option<String> {
    let base = base?.trim_end_matches('/');
    base.starts_with("https://")
        .then(|| format!("{base}/update.json"))
}

/// Whether this build updates itself: it has a key, and an https address to look at.
pub fn enabled(key: &str, endpoint: Option<&str>) -> bool {
    !key.trim().is_empty() && endpoint.is_some_and(|url| url.starts_with("https://"))
}

/// Starts the background checks. Returns at once; does nothing when this build cannot update.
pub fn start<R: Runtime>(app: AppHandle<R>) {
    let Some(endpoint) = update_endpoint(deployment::release_base().as_deref()) else {
        eprintln!("auto-update: no release address in this build; not updating by itself");
        return;
    };
    if !enabled(UPDATE_PUBLIC_KEY, Some(&endpoint)) {
        eprintln!("auto-update: no update key in this build; not updating by itself");
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_CHECK_AFTER);
        loop {
            match tauri::async_runtime::block_on(check_and_install(&app, &endpoint)) {
                Ok(Some(version)) => {
                    eprintln!("auto-update: installed {version}; restarting now");
                    app.restart();
                }
                Ok(None) => {}
                Err(error) => eprintln!("auto-update: {error}"),
            }
            std::thread::sleep(CHECK_EVERY);
        }
    });
}

/// One look: the newer version's number once it is downloaded and installed, None when up to date.
async fn check_and_install<R: Runtime>(
    app: &AppHandle<R>,
    endpoint: &str,
) -> Result<Option<String>, String> {
    let url = endpoint
        .parse()
        .map_err(|error| format!("the update address is not valid: {error}"))?;
    let updater = app
        .updater_builder()
        .pubkey(UPDATE_PUBLIC_KEY)
        .endpoints(vec![url])
        .map_err(|error| error.to_string())?
        .build()
        .map_err(|error| error.to_string())?;
    let Some(update) = updater.check().await.map_err(|error| error.to_string())? else {
        return Ok(None);
    };
    let version = update.version.clone();
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|error| format!("could not install {version}: {error}"))?;
    Ok(Some(version))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_update_address_is_beside_the_releases_on_the_company_site() {
        assert_eq!(
            update_endpoint(Some("https://blackark.uk/downloads/releases/")).as_deref(),
            Some("https://blackark.uk/downloads/releases/update.json")
        );
        assert_eq!(update_endpoint(None), None);
        // Never over plain http: the address says which file is the update.
        assert_eq!(update_endpoint(Some("http://blackark.uk/releases")), None);
    }

    #[test]
    fn a_build_without_its_key_or_address_never_updates_itself() {
        let url = "https://blackark.uk/releases/update.json";
        assert!(!enabled("", Some(url)));
        assert!(!enabled("   ", Some(url)));
        assert!(!enabled("dW50cnVzdGVkIGNvbW1lbnQ=", None));
        assert!(enabled("dW50cnVzdGVkIGNvbW1lbnQ=", Some(url)));
    }

    #[test]
    fn the_first_check_comes_early_enough_to_rescue_a_release_that_fails_soon_after_start() {
        assert!(FIRST_CHECK_AFTER <= Duration::from_secs(15));
        assert!(CHECK_EVERY <= Duration::from_secs(4 * 60 * 60));
    }
}
