//! What the desktop app writes down when it fails, so a window that vanished leaves a reason behind.
//!
//! DT Lab, v0.1.23 (desk #73): the window disappeared once when focus moved to Chrome, and came back
//! after a relaunch. A relaunch means the app had quit, and a release build on Windows has no
//! console, so a panic there went nowhere at all. From now on a panic, on any thread, is appended to
//! `<deployment>/.logs/desktop-crash.log` with the version, the thread, where it happened and a
//! backtrace, beside the other logs a person is already asked to send.
//!
//! The default hook still runs afterwards, so a debug build prints exactly what it printed before.

use std::io::Write;
use std::path::{Path, PathBuf};

pub const FILE: &str = "desktop-crash.log";

/// Larger than this and the file is started again: a crash loop must not fill a disk.
const LIMIT: u64 = 1024 * 1024;

/// Route every panic to the crash log under `root` before the default hook sees it.
pub fn install(root: PathBuf, version: String) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let entry = describe(
            &version,
            thread.name().unwrap_or("unnamed"),
            &payload(info.payload()),
            info.location().map(|at| at.to_string()).as_deref(),
            &std::backtrace::Backtrace::force_capture().to_string(),
        );
        let _ = record(&root, &entry);
        previous(info);
    }));
}

fn payload(payload: &(dyn std::any::Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|text| (*text).to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "a panic with no message".to_string())
}

/// One entry, as it is written to the file.
pub fn describe(
    version: &str,
    thread: &str,
    message: &str,
    location: Option<&str>,
    backtrace: &str,
) -> String {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or(0);
    format!(
        "--- ArkAgent {version} panicked (unix time {seconds}) on thread '{thread}' at {} ---\n{message}\n{backtrace}\n",
        location.unwrap_or("an unknown place"),
    )
}

/// Append `entry` to `<root>/.logs/desktop-crash.log`, starting the file again when it is too big.
pub fn record(root: &Path, entry: &str) -> std::io::Result<()> {
    let logs = root.join(".logs");
    std::fs::create_dir_all(&logs)?;
    let path = logs.join(FILE);
    let too_big = std::fs::metadata(&path).is_ok_and(|meta| meta.len() > LIMIT);
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(!too_big)
        .write(true)
        .truncate(too_big)
        .open(path)?;
    file.write_all(entry.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_entry_names_the_version_the_thread_the_place_and_the_message() {
        let entry = describe(
            "0.1.24",
            "main",
            "index out of bounds",
            Some("src/main.rs:10:5"),
            "backtrace here",
        );
        assert!(entry.contains("ArkAgent 0.1.24 panicked"));
        assert!(entry.contains("thread 'main' at src/main.rs:10:5"));
        assert!(entry.contains("index out of bounds\nbacktrace here"));
    }

    #[test]
    fn entries_are_appended_under_the_deployments_logs() {
        let root = std::env::temp_dir().join(format!("arkagent-crash-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        record(&root, "first\n").unwrap();
        record(&root, "second\n").unwrap();
        let written = std::fs::read_to_string(root.join(".logs").join(FILE)).unwrap();
        assert_eq!(written, "first\nsecond\n");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_file_past_the_limit_is_started_again() {
        let root = std::env::temp_dir().join(format!("arkagent-crash-big-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        record(&root, &"x".repeat(LIMIT as usize + 1)).unwrap();
        record(&root, "fresh\n").unwrap();
        let written = std::fs::read_to_string(root.join(".logs").join(FILE)).unwrap();
        assert_eq!(written, "fresh\n");
        let _ = std::fs::remove_dir_all(&root);
    }
}
