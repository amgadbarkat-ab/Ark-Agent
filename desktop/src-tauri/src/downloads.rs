//! Where a download from the ArkAgent window goes, and what the person is told about it.
//!
//! DT Lab (#109, v0.1.48): "Download" in the desktop window (Propose a change's JSON file, for one)
//! saved silently into the app's working folder, with no dialog and no path shown. The web view hands
//! every download to the shell; the shell now puts it in the person's Downloads folder, never over a
//! file already there, and says where it went.

use std::path::{Path, PathBuf};

/// The path a download is saved to: `downloads` joined with the file's own name, numbered
/// ("name (1).json") when that name is taken, so nothing the person already has is replaced.
///
/// Only the last part of the suggested path is used: where the web view would have put it (the app's
/// working folder) is exactly what this replaces.
pub fn destination(downloads: &Path, suggested: &Path) -> PathBuf {
    let name = suggested
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::trim)
        .filter(|name| !name.is_empty() && *name != "." && *name != "..")
        .unwrap_or("download");
    let first = downloads.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, extension) = match name.rfind('.') {
        Some(dot) if dot > 0 => (&name[..dot], &name[dot..]),
        _ => (name, ""),
    };
    (1..)
        .map(|n| downloads.join(format!("{stem} ({n}){extension}")))
        .find(|candidate| !candidate.exists())
        .expect("an unused name exists")
}

// ---- Save As (v0.1.49; Amgad approved the permission it needs) ------------------------------------
//
// A file the page makes itself (Propose a change's JSON, for one) goes through a real Save As dialog:
// the page calls one command, `plugin:ark-save|save_download`, with the file's name and text. The
// dialog suggests that name in the Downloads folder; the person chooses where; Cancel saves nothing.
// The command is granted to the main window only, and only while it shows the app from its own
// loopback address (`save_as_origin`); every other command keeps the permissions it had.

/// The most text the page may hand over to be saved: far more than any file the app makes.
pub const MAX_SAVE_BYTES: usize = 20 * 1024 * 1024;

/// The name the dialog suggests: only the last part of what the page asked for, never a folder.
pub fn suggested_name(asked: &str) -> String {
    let last = asked.rsplit(['/', '\\']).next().unwrap_or("").trim();
    if last.is_empty() || last == "." || last == ".." {
        "download".to_string()
    } else {
        last.to_string()
    }
}

/// Writes the text where the person chose, or nothing at all when they cancelled (None).
pub fn save_chosen(choice: Option<PathBuf>, text: &str) -> std::io::Result<Option<PathBuf>> {
    let Some(path) = choice else {
        return Ok(None);
    };
    if text.len() > MAX_SAVE_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "too large to save",
        ));
    }
    std::fs::write(&path, text)?;
    Ok(Some(path))
}

/// The remote-URL pattern the Save As permission is granted to: exactly the app's own origin,
/// `http://127.0.0.1:<port>/*` or `http://[::1]:<port>/*`. None for any other address, so a page
/// from anywhere else in the window can never call it.
pub fn save_as_origin(address: &str) -> Option<String> {
    let rest = address.strip_prefix("http://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let (host, port) = if let Some(v6) = authority.strip_prefix("[::1]:") {
        ("[::1]", v6)
    } else {
        ("127.0.0.1", authority.strip_prefix("127.0.0.1:")?)
    };
    let port: u16 = port.parse().ok()?;
    if port == 0 {
        return None;
    }
    Some(format!("http://{host}:{port}/*"))
}

/// What the person is told once the file is saved: where it is, in full.
pub fn saved_message(path: &Path, greek: bool) -> String {
    let shown = path.display();
    if greek {
        format!("Αποθηκεύτηκε στον φάκελο Λήψεις:\n{shown}")
    } else {
        format!("Saved to your Downloads folder:\n{shown}")
    }
}

/// What the person is told when the file could not be saved.
pub fn failed_message(greek: bool) -> &'static str {
    if greek {
        "Το αρχείο δεν αποθηκεύτηκε. Δοκιμάστε ξανά ή χρησιμοποιήστε την Αντιγραφή."
    } else {
        "The file was not saved. Try again, or use Copy instead."
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(label: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("arkagent-downloads-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_download_goes_to_the_downloads_folder_under_its_own_name() {
        let downloads = scratch("plain");
        let suggested = Path::new("/opt/ArkAgent/proposal-sales-2026-11-18.json");
        assert_eq!(
            destination(&downloads, suggested),
            downloads.join("proposal-sales-2026-11-18.json")
        );
    }

    #[test]
    fn a_file_already_there_is_never_replaced() {
        let downloads = scratch("taken");
        std::fs::write(downloads.join("proposal.json"), "first").unwrap();
        std::fs::write(downloads.join("proposal (1).json"), "second").unwrap();
        assert_eq!(
            destination(&downloads, Path::new("proposal.json")),
            downloads.join("proposal (2).json")
        );
        std::fs::write(downloads.join("notes"), "x").unwrap();
        assert_eq!(
            destination(&downloads, Path::new("notes")),
            downloads.join("notes (1)")
        );
    }

    #[test]
    fn a_download_with_no_usable_name_is_still_saved() {
        let downloads = scratch("nameless");
        assert_eq!(
            destination(&downloads, Path::new("")),
            downloads.join("download")
        );
        assert_eq!(
            destination(&downloads, Path::new("..")),
            downloads.join("download")
        );
    }

    #[test]
    fn save_as_suggests_the_file_own_name_only() {
        assert_eq!(suggested_name("proposal-sales.json"), "proposal-sales.json");
        assert_eq!(suggested_name("../../etc/passwd"), "passwd");
        assert_eq!(suggested_name("C:\\Users\\x\\report.json"), "report.json");
        assert_eq!(suggested_name("  "), "download");
        assert_eq!(suggested_name(".."), "download");
    }

    #[test]
    fn a_cancelled_save_as_saves_nothing() {
        let dir = scratch("cancelled");
        assert_eq!(save_chosen(None, "{}").unwrap(), None);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
    }

    #[test]
    fn save_as_writes_exactly_the_text_where_the_person_chose() {
        let dir = scratch("chosen");
        let path = dir.join("elsewhere.json");
        assert_eq!(
            save_chosen(Some(path.clone()), "{\"a\":1}").unwrap(),
            Some(path.clone())
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"a\":1}");
    }

    #[test]
    fn save_as_refuses_more_than_it_should_ever_be_handed() {
        let dir = scratch("large");
        let big = "x".repeat(MAX_SAVE_BYTES + 1);
        assert!(save_chosen(Some(dir.join("big.txt")), &big).is_err());
        assert!(!dir.join("big.txt").exists());
    }

    #[test]
    fn save_as_is_allowed_only_from_the_app_own_loopback_origin() {
        assert_eq!(
            save_as_origin("http://127.0.0.1:3010/channel/x?lang=el").as_deref(),
            Some("http://127.0.0.1:3010/*")
        );
        assert_eq!(
            save_as_origin("http://[::1]:3010/").as_deref(),
            Some("http://[::1]:3010/*")
        );
        // Anything else: no permission at all.
        assert_eq!(save_as_origin("https://127.0.0.1:3010/"), None);
        assert_eq!(save_as_origin("http://localhost:3010/"), None);
        assert_eq!(save_as_origin("http://127.0.0.1/"), None);
        assert_eq!(save_as_origin("http://127.0.0.1:3010@evil.example/"), None);
        assert_eq!(save_as_origin("http://evil.example:3010/"), None);
        assert_eq!(save_as_origin("tauri://localhost/"), None);
        assert_eq!(save_as_origin("http://127.0.0.1:99999/"), None);
    }

    #[test]
    fn the_person_is_told_where_the_file_went_in_their_language() {
        let path = Path::new("/home/someone/Downloads/proposal.json");
        let english = saved_message(path, false);
        assert!(english.contains("/home/someone/Downloads/proposal.json"));
        assert!(english.starts_with("Saved to your Downloads folder"));
        let greek = saved_message(path, true);
        assert!(greek.contains("/home/someone/Downloads/proposal.json"));
        assert!(greek.starts_with("Αποθηκεύτηκε στον φάκελο Λήψεις"));
    }
}
