//! A staff computer that joins the company's ArkAgent (Amgad, 24 Nov 2026, option A).
//!
//! Instead of an ArkAgent of its own, a staff computer runs one small relay
//! (`server/src/office/join-proxy.ts`) on its loopback. The relay passes everything to the
//! administrator's computer over HTTPS and trusts only the certificate the join code names. Nothing
//! else is installed or started: no container engine, no database, no model. The window then opens
//! on the relay, and each person signs in with their own sub-profile.
//!
//! The join code is kept beside the app's other settings, so the next start goes straight back to
//! the company's ArkAgent. It admits nobody by itself: it says where the company's computer is and
//! which certificate is its own.

use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::time::{Duration, Instant};

/// Where the relay answers on this computer. Beside the stack's own ports, and never one of them.
pub const JOIN_PORT: u16 = 52130;

const FILE: &str = "join.json";
const PREFIX: &str = "ARK-";
/// The relay, as the installed source lays it out.
const SCRIPT: [&str; 4] = ["server", "src", "office", "join-proxy.ts"];

/// The join code as typed or pasted, without the spaces and line breaks a paste brings with it.
pub fn tidy(code: &str) -> String {
    code.chars().filter(|c| !c.is_whitespace()).collect()
}

/// Whether this could be a join code at all. The relay reads it properly and refuses a bad one.
pub fn looks_like_code(code: &str) -> bool {
    let code = tidy(code);
    code.len() > PREFIX.len() + 16
        && code.len() < 4096
        && code.starts_with(PREFIX)
        && code[PREFIX.len()..]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The join code kept from last time, if this computer joined a company.
pub fn saved(config: &Path) -> Option<String> {
    let text = std::fs::read_to_string(config.join(FILE)).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let code = value.get("code")?.as_str()?.to_string();
    looks_like_code(&code).then_some(code)
}

pub fn save(config: &Path, code: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(config)?;
    let body = serde_json::json!({ "code": tidy(code) }).to_string();
    std::fs::write(config.join(FILE), body)
}

/// This computer no longer joins the company's ArkAgent; the next start offers setup again.
pub fn forget(config: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(config.join(FILE)) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

pub fn script(root: &Path) -> PathBuf {
    SCRIPT
        .iter()
        .fold(root.to_path_buf(), |path, part| path.join(part))
}

/// Where the window goes once the relay answers.
pub fn address(port: u16) -> String {
    format!("http://127.0.0.1:{port}/")
}

/// Starts the relay with this computer's Bun, its output in `logs/join.log`.
pub fn spawn(
    root: &Path,
    bun: &Path,
    code: &str,
    port: u16,
    language: Option<&str>,
    logs: &Path,
) -> std::io::Result<Child> {
    std::fs::create_dir_all(logs)?;
    let out = std::fs::File::create(logs.join("join.log"))?;
    let err = out.try_clone()?;
    let mut command = crate::quiet::command(bun);
    command
        .arg(script(root))
        .current_dir(root)
        .env("ARK_JOIN_CODE", tidy(code))
        .env("ARK_JOIN_PORT", port.to_string())
        .env("ARK_LANGUAGE", language.unwrap_or("en"))
        .stdin(Stdio::null())
        .stdout(out)
        .stderr(err);
    command.spawn()
}

/// What the relay says about the company's computer.
#[derive(Debug, PartialEq, Eq)]
pub enum Reached {
    /// The relay answers, and found the company's computer with the certificate the code names.
    Connected,
    /// The relay answers, but the company's computer is off, elsewhere, or not the one in the code.
    NotFound,
    /// The relay itself did not answer in time.
    NoRelay,
}

/// Asks the relay until it answers or `wait` runs out.
pub fn reach(port: u16, wait: Duration) -> Reached {
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
    {
        Ok(client) => client,
        Err(_) => return Reached::NoRelay,
    };
    let url = format!("http://127.0.0.1:{port}/__ark_join/health");
    let until = Instant::now() + wait;
    loop {
        if let Ok(response) = client.get(&url).send() {
            let connected = response
                .json::<serde_json::Value>()
                .ok()
                .and_then(|value| value.get("connected")?.as_bool())
                .unwrap_or(false);
            return if connected {
                Reached::Connected
            } else {
                Reached::NotFound
            };
        }
        if Instant::now() >= until {
            return Reached::NoRelay;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CODE: &str = "ARK-eyJ2IjoxLCJhIjpbIjE5Mi4xNjguMS4yMCJdLCJwIjo1MjQ0MywiZiI6ImFhYWEifQ";

    #[test]
    fn a_join_code_is_recognised_and_anything_else_is_not() {
        assert!(looks_like_code(CODE));
        assert!(looks_like_code(&format!(" {CODE}\n")));
        assert!(!looks_like_code("ARK-short"));
        assert!(!looks_like_code("hello there, this is not a join code"));
        assert!(!looks_like_code(&format!("{CODE}; rm -rf /")));
    }

    #[test]
    fn the_code_is_kept_for_the_next_start_and_forgotten_on_leaving() {
        let config = crate::test_support::temp_root("join-saved");
        assert_eq!(saved(&config), None);
        save(&config, &format!("  {CODE}\n")).unwrap();
        assert_eq!(saved(&config).as_deref(), Some(CODE));
        forget(&config).unwrap();
        assert_eq!(saved(&config), None);
        // Leaving twice is not an error.
        forget(&config).unwrap();
        std::fs::remove_dir_all(&config).ok();
    }

    #[test]
    fn a_kept_file_that_is_not_a_code_is_not_used() {
        let config = crate::test_support::temp_root("join-garbled");
        std::fs::create_dir_all(&config).unwrap();
        std::fs::write(config.join(FILE), r#"{"code":"not one"}"#).unwrap();
        assert_eq!(saved(&config), None);
        std::fs::remove_dir_all(&config).ok();
    }

    #[test]
    fn the_relay_is_the_one_in_the_installed_source_and_the_window_goes_to_loopback() {
        let root = Path::new("/opt/arkagent");
        assert_eq!(
            script(root),
            root.join("server")
                .join("src")
                .join("office")
                .join("join-proxy.ts")
        );
        assert_eq!(address(JOIN_PORT), "http://127.0.0.1:52130/");
    }

    #[test]
    fn nothing_listening_is_no_relay() {
        // A port nothing here listens on: asked once, briefly, and reported as no relay.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        assert_eq!(reach(port, Duration::from_millis(300)), Reached::NoRelay);
    }
}
