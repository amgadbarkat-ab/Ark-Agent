//! Help → About ArkAgent (desk #73): which version is this, without reading an installer's name.
//!
//! The version is the one this build was made from (`CARGO_PKG_VERSION`, which the release
//! workflow sets with every release), so it cannot drift from what is installed.

pub const TITLE: &str = "About ArkAgent";

/// The version this build was made from.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// What the About box says.
pub fn text(version: &str) -> String {
    format!("ArkAgent v{version}\n\nYour digital employees, on your own computer.\n© BlackArk")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn says_the_version_with_a_v() {
        assert!(text("0.1.24").starts_with("ArkAgent v0.1.24\n"));
    }

    #[test]
    fn the_version_is_this_builds() {
        assert_eq!(version(), env!("CARGO_PKG_VERSION"));
        assert!(!version().is_empty());
    }
}
