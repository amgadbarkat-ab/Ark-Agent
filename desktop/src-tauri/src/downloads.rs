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
