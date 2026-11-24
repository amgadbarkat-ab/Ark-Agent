//! A customer's signed trial profile, loaded by BlackArk staff in the on-site setup session (#109;
//! the import folder from v0.1.50).
//!
//! Nothing on a customer's screen offers this (Amgad, 16 Nov: one release for everyone, nothing
//! trial- or customer-specific visible in the app). Instead the installer drops the `.arktrial` file
//! BlackArk signed into `<app config dir>/import/`. When ArkAgent next opens its app, and its server
//! is running, each file there is sent to the server on this computer, which checks BlackArk's
//! signature exactly as it always has and keeps the trial in its database. This side only carries the
//! file and keeps a record: it decides nothing.
//!
//! - Taken: moved to `import/imported/`, so it is sent once.
//! - Refused (not a profile, not signed by BlackArk, altered, another customer's, older): moved to
//!   `import/refused/`. The reason goes to `import/import.log` and the app's log, never to the
//!   window: the customer did not start this and has nothing to do about it.
//! - Server not answering: left where it is, for the next start.
//!
//! Every attempt is one JSON line in `import/import.log`: when, which file, its SHA-256, the outcome
//! and the reason. The server also audits each import that changed the trial
//! (`trial.profile_imported`).
//!
//! The setup window's button (v0.1.37 to v0.1.49) kept its file at `<app config dir>/trial.arktrial`;
//! one left there by an older version is moved into the folder and goes the same way.

use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// The folder staff drop a profile into, under the app's config folder.
pub const IMPORT: &str = "import";
/// Under `import/`: files the server took.
pub const IMPORTED: &str = "imported";
/// Under `import/`: files that were refused.
pub const REFUSED: &str = "refused";
/// Under `import/`: one line per attempt.
pub const LOG: &str = "import.log";
const EXTENSION: &str = "arktrial";
/// Where the setup window's button kept its file before v0.1.50.
const LEGACY: &str = "trial.arktrial";
/// A roster of a few dozen employees with long instructions is well under this.
const MAX_BYTES: u64 = 400_000;
const NOT_A_PROFILE: &str = "This file is not a trial profile.";

pub fn import_dir(config: &Path) -> PathBuf {
    config.join(IMPORT)
}

/// Whether the text has the shape of a profile file. The signature is the server's to check.
pub fn looks_like_profile(text: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return false;
    };
    value.get("format").and_then(|v| v.as_str()) == Some("arktrial/1")
        && value.get("profile").and_then(|v| v.as_str()).is_some()
        && value.get("signature").and_then(|v| v.as_str()).is_some()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// The server took it; `changed` is false when this exact profile was already in.
    Imported { changed: bool },
    /// Refused, in these words. The file is in `refused/`.
    Refused(String),
    /// The server did not answer. The file stays for next time.
    Unreachable,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Attempt {
    pub file: String,
    pub outcome: Outcome,
}

/// Sends each file waiting in the import folder to the server on `port`.
pub fn pick_up(config: &Path, port: u16) -> Vec<Attempt> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build();
    pick_up_with(config, |body| {
        let client = client.as_ref().map_err(|error| error.to_string())?;
        let response = client
            .post(format!("http://127.0.0.1:{port}/api/trial/profile"))
            .header("content-type", "application/json")
            .body(body.to_owned())
            .send()
            .map_err(|error| error.to_string())?;
        let status = response.status().as_u16();
        Ok((status, response.text().unwrap_or_default()))
    })
}

/// `pick_up`, with the request given, so it can be tested without a server.
pub fn pick_up_with(
    config: &Path,
    mut post: impl FnMut(&str) -> Result<(u16, String), String>,
) -> Vec<Attempt> {
    let folder = import_dir(config);
    if std::fs::create_dir_all(&folder).is_err() {
        return Vec::new();
    }
    let legacy = config.join(LEGACY);
    if legacy.is_file() && !folder.join(LEGACY).exists() {
        let _ = std::fs::rename(&legacy, folder.join(LEGACY));
    }
    let mut waiting: Vec<PathBuf> = std::fs::read_dir(&folder)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| {
                    path.is_file()
                        && path
                            .extension()
                            .is_some_and(|ext| ext.eq_ignore_ascii_case(EXTENSION))
                })
                .collect()
        })
        .unwrap_or_default();
    waiting.sort();

    let mut attempts = Vec::new();
    for path in waiting {
        let file = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let bytes = std::fs::metadata(&path)
            .ok()
            .filter(|meta| meta.len() <= MAX_BYTES)
            .and_then(|_| std::fs::read(&path).ok())
            .unwrap_or_default();
        let digest = hex(&Sha256::digest(&bytes));
        let text = String::from_utf8(bytes).unwrap_or_default();
        let outcome = if looks_like_profile(&text) {
            send(&text, &mut post)
        } else {
            Outcome::Refused(NOT_A_PROFILE.into())
        };
        let now = now_secs();
        match &outcome {
            Outcome::Imported { .. } => move_into(&path, &folder.join(IMPORTED), now, &file),
            Outcome::Refused(_) => move_into(&path, &folder.join(REFUSED), now, &file),
            Outcome::Unreachable => {}
        }
        record(&folder, now, &file, &digest, &outcome);
        attempts.push(Attempt { file, outcome });
    }
    attempts
}

fn send(text: &str, post: &mut impl FnMut(&str) -> Result<(u16, String), String>) -> Outcome {
    let body = serde_json::json!({ "text": text }).to_string();
    match post(&body) {
        Ok((status, answer)) if (200..300).contains(&status) => Outcome::Imported {
            changed: serde_json::from_str::<serde_json::Value>(&answer)
                .ok()
                .and_then(|value| value.get("changed")?.as_bool())
                .unwrap_or(true),
        },
        // Nobody signed in yet (sign-in per person, 24 Nov 2026): not a refusal of the file. It stays
        // for the next start, and the administrator can also give it on the Activate screen.
        Ok((401, _)) => Outcome::Unreachable,
        Ok((status, answer)) if (400..500).contains(&status) => Outcome::Refused(
            serde_json::from_str::<serde_json::Value>(&answer)
                .ok()
                .and_then(|value| value.get("error")?.as_str().map(str::to_owned))
                .unwrap_or_else(|| format!("The server refused the trial profile ({status}).")),
        ),
        _ => Outcome::Unreachable,
    }
}

/// Moves a handled file aside, its time first so a second copy with the same name is kept too.
fn move_into(path: &Path, into: &Path, now: u64, file: &str) {
    let _ = std::fs::create_dir_all(into);
    let stamp = utc_stamp(now).replace([':', '-'], "");
    let mut target = into.join(format!("{stamp}-{file}"));
    let mut n = 1;
    while target.exists() {
        n += 1;
        target = into.join(format!("{stamp}-{n}-{file}"));
    }
    if std::fs::rename(path, &target).is_err() {
        // Not movable: removed rather than sent again on every start. The log has its digest.
        let _ = std::fs::remove_file(path);
    }
}

fn record(folder: &Path, now: u64, file: &str, digest: &str, outcome: &Outcome) {
    let (word, reason) = match outcome {
        Outcome::Imported { changed: true } => ("imported", None),
        Outcome::Imported { changed: false } => ("unchanged", None),
        Outcome::Refused(reason) => ("refused", Some(reason.as_str())),
        Outcome::Unreachable => (
            "unreachable",
            Some("ArkAgent's server did not answer; the file is tried again at the next start."),
        ),
    };
    let line = serde_json::json!({
        "at": utc_stamp(now),
        "file": file,
        "sha256": digest,
        "outcome": word,
        "reason": reason,
    });
    eprintln!("[trial-import] {line}");
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(folder.join(LOG))
        .and_then(|mut log| writeln!(log, "{line}"));
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

/// Seconds since 1970 as `YYYY-MM-DDTHH:MM:SSZ` (UTC), without a date library.
fn utc_stamp(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rest = secs % 86_400;
    // Howard Hinnant's days-to-civil.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3_600,
        rest % 3_600 / 60,
        rest % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD: &str = r#"{"format":"arktrial/1","profile":"eyJ2IjoxfQ","signature":"c2ln"}"#;

    fn drop_in(config: &Path, name: &str, text: &str) {
        std::fs::create_dir_all(import_dir(config)).unwrap();
        std::fs::write(import_dir(config).join(name), text).unwrap();
    }

    fn log(config: &Path) -> Vec<serde_json::Value> {
        std::fs::read_to_string(import_dir(config).join(LOG))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut found: Vec<String> = std::fs::read_dir(dir)
            .map(|entries| {
                entries
                    .flatten()
                    .map(|entry| entry.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        found.sort();
        found
    }

    #[test]
    fn a_profile_dropped_in_the_import_folder_goes_to_the_server_once_and_is_kept_in_imported() {
        let config = crate::test_support::temp_root("trial-import-ok");
        drop_in(&config, "demo-shop.arktrial", GOOD);
        let mut sent = Vec::new();
        let attempts = pick_up_with(&config, |body| {
            sent.push(body.to_owned());
            Ok((200, r#"{"trial":{},"changed":true}"#.into()))
        });
        assert_eq!(
            attempts,
            vec![Attempt {
                file: "demo-shop.arktrial".into(),
                outcome: Outcome::Imported { changed: true },
            }]
        );
        // Exactly what the server's import has always been given: the file's text, as it is.
        let body: serde_json::Value = serde_json::from_str(&sent[0]).unwrap();
        assert_eq!(body, serde_json::json!({ "text": GOOD }));
        assert!(!import_dir(&config).join("demo-shop.arktrial").exists());
        let kept = names(&import_dir(&config).join(IMPORTED));
        assert_eq!(kept.len(), 1);
        assert!(kept[0].ends_with("-demo-shop.arktrial"));

        let entries = log(&config);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["file"], "demo-shop.arktrial");
        assert_eq!(entries[0]["outcome"], "imported");
        assert_eq!(entries[0]["sha256"].as_str().unwrap().len(), 64);
        assert!(entries[0]["at"].as_str().unwrap().ends_with('Z'));

        // Picked up once: the next start has nothing to send.
        assert!(pick_up_with(&config, |_| unreachable!()).is_empty());
    }

    #[test]
    fn an_unsigned_altered_or_foreign_file_is_refused_into_refused_with_the_reason_in_the_log() {
        let config = crate::test_support::temp_root("trial-import-refused");
        drop_in(&config, "a-not-a-profile.arktrial", "hello");
        drop_in(&config, "b-altered.arktrial", GOOD);
        let mut posts = 0;
        let attempts = pick_up_with(&config, |_| {
            posts += 1;
            Ok((
                400,
                r#"{"error":"This trial profile is not signed by BlackArk."}"#.into(),
            ))
        });
        // Not even sent when it is not shaped like a profile.
        assert_eq!(posts, 1);
        assert_eq!(
            attempts
                .iter()
                .map(|a| a.outcome.clone())
                .collect::<Vec<_>>(),
            vec![
                Outcome::Refused("This file is not a trial profile.".into()),
                Outcome::Refused("This trial profile is not signed by BlackArk.".into()),
            ]
        );
        assert_eq!(names(&import_dir(&config)), vec![LOG, REFUSED]);
        assert_eq!(names(&import_dir(&config).join(REFUSED)).len(), 2);
        let entries = log(&config);
        assert_eq!(entries[1]["outcome"], "refused");
        assert_eq!(
            entries[1]["reason"],
            "This trial profile is not signed by BlackArk."
        );
    }

    #[test]
    fn a_server_that_does_not_answer_leaves_the_file_for_the_next_start() {
        let config = crate::test_support::temp_root("trial-import-later");
        drop_in(&config, "demo-shop.arktrial", GOOD);
        let attempts = pick_up_with(&config, |_| Err("connection refused".into()));
        assert_eq!(attempts[0].outcome, Outcome::Unreachable);
        assert!(import_dir(&config).join("demo-shop.arktrial").exists());
        assert_eq!(log(&config)[0]["outcome"], "unreachable");
    }

    #[test]
    fn nobody_signed_in_yet_leaves_the_file_for_the_next_start() {
        let config = crate::test_support::temp_root("trial-import-signed-out");
        drop_in(&config, "demo-shop.arktrial", GOOD);
        let attempts = pick_up_with(&config, |_| Ok((401, r#"{"error":"Sign in"}"#.into())));
        assert_eq!(attempts[0].outcome, Outcome::Unreachable);
        assert!(import_dir(&config).join("demo-shop.arktrial").exists());
    }

    #[test]
    fn a_file_kept_by_the_old_setup_window_button_still_goes_in() {
        let config = crate::test_support::temp_root("trial-import-legacy");
        std::fs::create_dir_all(&config).unwrap();
        std::fs::write(config.join("trial.arktrial"), GOOD).unwrap();
        let attempts = pick_up_with(&config, |_| Ok((200, r#"{"changed":false}"#.into())));
        assert_eq!(attempts[0].outcome, Outcome::Imported { changed: false });
        assert!(!config.join("trial.arktrial").exists());
        assert_eq!(log(&config)[0]["outcome"], "unchanged");
    }

    #[test]
    fn the_import_folder_is_made_so_staff_find_it_after_the_first_start() {
        let config = crate::test_support::temp_root("trial-import-folder");
        assert!(pick_up_with(&config, |_| unreachable!()).is_empty());
        assert!(import_dir(&config).is_dir());
    }

    #[test]
    fn utc_stamps_are_written_the_way_people_read_them() {
        assert_eq!(utc_stamp(0), "1970-01-01T00:00:00Z");
        assert_eq!(utc_stamp(1_795_603_020), "2026-11-25T10:37:00Z");
    }
}
