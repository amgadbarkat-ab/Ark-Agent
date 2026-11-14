//! The language of what the engine draws itself: the tray and window menus and the native
//! approval dialogs (#108). Everything else the engine says is an English sentence that the setup
//! window and the app translate from the shared table (shared/i18n), so the Greek lives there.
//!
//! The setup window passes its choice when it opens the app (`show_openbot`), and it is kept in the
//! app's config folder so the menus, built before any window exists, start in it next time.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

static GREEK: AtomicBool = AtomicBool::new(false);

const FILE: &str = "language";

/// Greek for "el"; anything else is English.
pub fn set(code: &str) {
    GREEK.store(code.trim() == "el", Ordering::Relaxed);
}

pub fn greek() -> bool {
    GREEK.load(Ordering::Relaxed)
}

/// The English or the Greek, by the language chosen.
pub fn pick(english: &'static str, greek_text: &'static str) -> &'static str {
    if greek() {
        greek_text
    } else {
        english
    }
}

/// Reads the language kept from the last time, if any.
pub fn load(config: &Path) {
    if let Ok(code) = std::fs::read_to_string(config.join(FILE)) {
        set(&code);
    }
}

/// Takes the language now and keeps it for the next start. A failure to keep it only means the
/// menus start in English next time, so it is not an error anybody is shown.
pub fn save(config: &Path, code: &str) {
    if code != "el" && code != "en" {
        return;
    }
    set(code);
    let _ = std::fs::create_dir_all(config);
    let _ = std::fs::write(config.join(FILE), code);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kept_between_starts_and_only_the_two_languages() {
        let dir = std::env::temp_dir().join(format!("ark-language-{}", std::process::id()));
        save(&dir, "el");
        set("en");
        load(&dir);
        assert!(greek());
        assert_eq!(pick("Quit", "Έξοδος"), "Έξοδος");
        save(&dir, "fr");
        load(&dir);
        assert!(greek(), "an unknown language leaves the kept one alone");
        save(&dir, "en");
        load(&dir);
        assert!(!greek());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
