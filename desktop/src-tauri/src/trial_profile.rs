//! A customer trial profile, chosen in the setup window and handed to the server (#109, v0.1.37).
//!
//! The setup window runs before the server does, so the file the person picks is kept in this
//! app's config folder first (`trial.arktrial`). When ArkAgent opens its app, the file is sent to the
//! server on this computer, which checks BlackArk's signature and keeps the trial in its database.
//! The server decides everything; this side only carries the file.
//!
//! After the server takes it, the file is renamed `trial.arktrial.imported`, so it is not sent on
//! every start. When the server refuses it (not signed, another customer's), the file is removed and
//! the server's sentence is shown, so the person is never stuck with a file that will not go in. When
//! the server cannot be reached, the file stays and goes on the next open.

use std::path::{Path, PathBuf};
use std::time::Duration;

const PENDING: &str = "trial.arktrial";
const IMPORTED: &str = "trial.arktrial.imported";
/// A roster of a few dozen employees with long instructions is well under this.
const MAX_BYTES: usize = 400_000;

pub fn pending_path(config: &Path) -> PathBuf {
    config.join(PENDING)
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

/// Keeps the chosen file until ArkAgent opens its app.
pub fn save(config: &Path, text: &str) -> Result<(), String> {
    if text.len() > MAX_BYTES || !looks_like_profile(text) {
        return Err("This file is not a trial profile.".into());
    }
    std::fs::create_dir_all(config)
        .and_then(|()| std::fs::write(pending_path(config), text))
        .map_err(|_| "ArkAgent could not keep the trial profile on this computer.".into())
}

#[derive(Debug, PartialEq, Eq)]
pub enum Delivery {
    /// No file is waiting.
    Nothing,
    /// The server took it.
    Imported,
    /// The server refused it, in these words. The file is gone.
    Refused(String),
    /// The server did not answer. The file stays for next time.
    Unreachable,
}

/// Sends a waiting file to the server on `port`, if there is one.
pub fn deliver(config: &Path, port: u16) -> Delivery {
    deliver_with(config, |body| {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|error| error.to_string())?;
        let response = client
            .post(format!("http://127.0.0.1:{port}/api/trial/profile"))
            .header("content-type", "application/json")
            .body(body.to_owned())
            .send()
            .map_err(|error| error.to_string())?;
        let status = response.status().as_u16();
        let text = response.text().unwrap_or_default();
        Ok((status, text))
    })
}

/// `deliver`, with the request given, so it can be tested without a server.
pub fn deliver_with(
    config: &Path,
    post: impl FnOnce(&str) -> Result<(u16, String), String>,
) -> Delivery {
    let path = pending_path(config);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Delivery::Nothing;
    };
    let body = serde_json::json!({ "text": text }).to_string();
    match post(&body) {
        Ok((status, _)) if (200..300).contains(&status) => {
            let _ = std::fs::rename(&path, config.join(IMPORTED));
            Delivery::Imported
        }
        Ok((status, answer)) if (400..500).contains(&status) => {
            let _ = std::fs::remove_file(&path);
            let said = serde_json::from_str::<serde_json::Value>(&answer)
                .ok()
                .and_then(|value| value.get("error")?.as_str().map(str::to_owned))
                .unwrap_or_else(|| "The trial profile was not accepted.".into());
            Delivery::Refused(said)
        }
        _ => Delivery::Unreachable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("arkagent-trial-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    const GOOD: &str = r#"{"format":"arktrial/1","profile":"eyJ2IjoxfQ","signature":"c2ln"}"#;

    #[test]
    fn only_a_profile_shaped_file_is_kept() {
        let dir = folder("save");
        assert!(save(&dir, "hello").is_err());
        assert!(save(&dir, r#"{"format":"other"}"#).is_err());
        assert!(save(&dir, GOOD).is_ok());
        assert_eq!(std::fs::read_to_string(pending_path(&dir)).unwrap(), GOOD);
    }

    #[test]
    fn taken_is_renamed_refused_is_removed_with_the_reason_unreachable_stays() {
        let dir = folder("deliver");
        assert_eq!(deliver_with(&dir, |_| unreachable!()), Delivery::Nothing);

        save(&dir, GOOD).unwrap();
        let mut sent = String::new();
        assert_eq!(
            deliver_with(&dir, |body| {
                sent = body.to_owned();
                Ok((200, "{}".into()))
            }),
            Delivery::Imported
        );
        assert!(sent.contains("arktrial/1"));
        assert!(!pending_path(&dir).exists());
        assert!(dir.join(IMPORTED).exists());

        save(&dir, GOOD).unwrap();
        assert_eq!(
            deliver_with(&dir, |_| Err("connection refused".into())),
            Delivery::Unreachable
        );
        assert!(pending_path(&dir).exists());

        assert_eq!(
            deliver_with(&dir, |_| Ok((
                400,
                r#"{"error":"This trial profile is not signed by BlackArk."}"#.into()
            ))),
            Delivery::Refused("This trial profile is not signed by BlackArk.".into())
        );
        assert!(!pending_path(&dir).exists());
    }
}
