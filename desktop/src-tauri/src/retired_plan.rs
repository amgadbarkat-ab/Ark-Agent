//! Chat-plan sign-ins Ark no longer offers, and the clean-up of what an older version left behind.
//!
//! An earlier version could sign in to a Claude plan (storing `CLAUDE_CODE_OAUTH_TOKEN`) or reuse a
//! ChatGPT plan's Codex login (storing the whole token store). Anthropic does not allow a product to
//! collect, store or route requests through plan credentials, and OpenAI allows plan sign-in in a
//! paid app only through its own approved programme (docs/ark/04-llm-providers.md). So nothing in
//! the shell reads, writes or signs in to either now.
//!
//! What remains is the removal: a machine that ran the older version still holds those credentials,
//! and a credential nobody uses is still one somebody can lose.

use std::path::Path;

use crate::problem::Problem;

/// Settings and secrets the older version wrote for a plan.
pub const KEYS: [&str; 3] = [
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CHATGPT_AUTH_FILE",
    "CHATGPT_OAUTH_TOKEN",
];

/// Where the older version kept a signed-in ChatGPT plan's token store, under the deployment root.
pub const CHATGPT_STORE_FILE: &str = ".langchain/chatgpt-auth.json";

/**
Take every retired plan credential off this machine for the deployment at `root`.

The protected-store entries, the token store file, and the lines in `.env`. Each is removed only if
it is there, so this is safe to run on every start and from a screen that must not change anything
on a machine that never had a plan: it creates nothing, and leaves `.env` byte for byte as it was
unless a retired line is in it. It never reads a value back.
*/
pub fn purge(root: &Path) -> Result<(), Problem> {
    // `forget` makes the protected-store folder if it is missing, which a clean machine should not
    // have done to it by a clean-up.
    if root.join(".secrets").is_dir() {
        for key in KEYS {
            crate::vault::forget(root, key)?;
        }
    }
    remove_store_file(&root.join(CHATGPT_STORE_FILE)).map_err(|error| {
        Problem::with(
            "Ark Agent could not remove an old ChatGPT sign-in. Delete the .langchain folder in the deployment folder and try again.",
            error.to_string(),
        )
    })?;
    let env_file = root.join(".env");
    // A file only. Anything else there is not ours to rewrite, and the settings writer will say so.
    if env_file.is_file() && names_a_retired_key(&env_file) {
        let purge = KEYS
            .iter()
            .map(|key| ((*key).to_string(), String::new()))
            .collect();
        let owned = std::collections::BTreeMap::new();
        crate::env::write(&env_file, &owned, &purge).map_err(|error| {
            Problem::with(
                "Ark Agent could not remove an old sign-in from its settings.",
                error.to_string(),
            )
        })?;
    }
    Ok(())
}

fn names_a_retired_key(env_file: &Path) -> bool {
    std::fs::read_to_string(env_file).is_ok_and(|text| {
        text.lines().any(|line| {
            let key = line.split('=').next().unwrap_or("").trim();
            !line.trim_start().starts_with('#') && KEYS.contains(&key)
        })
    })
}

fn remove_store_file(path: &Path) -> std::io::Result<()> {
    // No folder to hold it means nothing to remove.
    if path.parent().is_some_and(|parent| !parent.is_dir()) {
        return Ok(());
    }
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        // A directory here is what an older version's mount could leave behind. It holds nothing
        // this version reads, so it goes too rather than failing every start.
        Err(_) if path.is_dir() => std::fs::remove_dir_all(path),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::temp_root;

    #[test]
    fn purge_removes_the_token_store_and_the_env_lines_and_keeps_everything_else() {
        let root = temp_root("retired-plan");
        std::fs::create_dir_all(root.join(".langchain")).unwrap();
        std::fs::write(
            root.join(CHATGPT_STORE_FILE),
            "{\"refresh_token\":\"synthetic\"}\n",
        )
        .unwrap();
        std::fs::write(
            root.join(".env"),
            "CUSTOM=kept\nCLAUDE_CODE_OAUTH_TOKEN=synthetic-claude\nCHATGPT_AUTH_FILE=/x\nCHATGPT_OAUTH_TOKEN=old\n",
        )
        .unwrap();

        purge(&root).unwrap();

        assert!(!root.join(CHATGPT_STORE_FILE).exists());
        let env = std::fs::read_to_string(root.join(".env")).unwrap();
        assert!(env.contains("CUSTOM=kept"));
        for key in KEYS {
            assert!(!env.contains(key), "{key} survived: {env}");
        }
        assert!(!env.contains("synthetic"));
    }

    #[test]
    fn purge_is_safe_on_a_machine_that_never_had_a_plan() {
        let root = temp_root("retired-plan-clean");
        std::fs::create_dir_all(&root).unwrap();
        purge(&root).unwrap();
        purge(&root).unwrap();
        assert!(!root.join(".env").exists());
        assert!(!root.join(".secrets").exists(), "a clean-up made a folder");
    }

    #[test]
    fn purge_leaves_a_settings_file_without_a_retired_line_exactly_as_it_was() {
        let root = temp_root("retired-plan-untouched");
        std::fs::create_dir_all(&root).unwrap();
        let text = "CUSTOM=kept\nANTHROPIC_API_KEY=\n# CLAUDE_CODE_OAUTH_TOKEN=commented\n";
        std::fs::write(root.join(".env"), text).unwrap();
        purge(&root).unwrap();
        assert_eq!(std::fs::read_to_string(root.join(".env")).unwrap(), text);
    }

    #[test]
    fn purge_forgets_a_token_in_the_protected_store() {
        let root = temp_root("retired-plan-vault");
        std::fs::create_dir_all(&root).unwrap();
        crate::vault::remember(&root, "CLAUDE_CODE_OAUTH_TOKEN", "synthetic-token").unwrap();
        assert!(crate::vault::recall(&root, "CLAUDE_CODE_OAUTH_TOKEN")
            .unwrap()
            .is_some());
        purge(&root).unwrap();
        assert!(crate::vault::recall(&root, "CLAUDE_CODE_OAUTH_TOKEN")
            .unwrap()
            .is_none());
    }

    #[test]
    fn purge_removes_a_directory_left_where_the_store_file_was() {
        let root = temp_root("retired-plan-dir");
        std::fs::create_dir_all(root.join(CHATGPT_STORE_FILE)).unwrap();
        purge(&root).unwrap();
        assert!(!root.join(CHATGPT_STORE_FILE).exists());
    }
}
