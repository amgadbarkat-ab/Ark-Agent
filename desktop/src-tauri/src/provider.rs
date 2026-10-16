//! The model provider screen's list, as data.
//!
//! OpenAI and Anthropic are connected with an API key. Neither offers a chat-subscription sign-in
//! here: Anthropic does not allow a product to use plan credentials, and OpenAI allows it in a paid
//! app only through its approved programme (docs/ark/04-llm-providers.md). Google and xAI use named
//! endpoint presets with API keys, or their own sign-in; their official addresses are supplied by
//! the frontend.
//!
//! The row that asks for a URL is the last one, and it is the only one that asks. Keeping it there
//! keeps a base URL off the main path.
//!
//! Independent of the harness picker, always. No harness on that list is tied to a vendor's models,
//! so nothing chosen there may narrow what is offered here.

use serde::{Deserialize, Serialize};

/// How a person proves they may use a provider.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Login {
    /// Paste a key.
    ApiKey,
    /// A base URL, a key and a model name. The developer row and the everything-else row at once.
    Endpoint,
    /// Browser authorization for the provider's model API, with renewable credentials.
    Oauth,
    /// Nothing to type: ArkAgent fetches and runs the model itself (`local_setup`).
    Managed,
}

/// One row on the model screen.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Provider {
    pub id: String,
    /// Shown on every row, mark or no mark. See `mark`.
    pub name: String,
    pub summary: String,
    /// The ways in, in the order the screen offers them. First is the default.
    pub logins: Vec<Login>,
    /// The vendored icon's file stem, or `None` where no maintained set has one.
    ///
    /// A row with `None` is drawn with its name and nothing else. Nothing is invented to fill the
    /// space: a monogram somebody made up reads as the vendor's own mark.
    pub mark: Option<String>,
    /// One sentence the screen must show when this provider is chosen, and the page it links to.
    pub caution: Option<Caution>,
    /// Shown, but cannot be chosen yet, and why. A row that is not there cannot be waited for.
    #[serde(default)]
    pub unavailable: Option<String>,
}

/// Something true about a provider that a person finds out too late otherwise.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Caution {
    pub says: String,
    pub reads_more_at: String,
}

pub fn catalogue() -> Vec<Provider> {
    vec![
        /*
         * The two ways to start with no key and no account elsewhere, ahead of the providers a person
         * brings their own key to. Decided with the owner on 2026-10-16: at setup the person chooses to
         * run the model on their own computer, on ArkAgent's server, or with their own key.
         */
        Provider {
            id: "local".into(),
            name: "On this computer".into(),
            summary:
                "Free and private. ArkAgent downloads a model once and runs it here; it works \
                      without internet and needs no account or key."
                    .into(),
            logins: vec![Login::Managed],
            mark: None,
            caution: None,
            unavailable: None,
        },
        Provider {
            id: "ark-server".into(),
            name: "ArkAgent's server".into(),
            summary:
                "Nothing to download. Answers come from a larger model that ArkAgent runs for you."
                    .into(),
            logins: vec![],
            mark: None,
            caution: None,
            // Needs the ArkAgent cloud and a signed-in account (docs/ark/22-starter-model.md), neither of
            // which exists yet. Shown now so the choice is already there to be waited for.
            unavailable: Some("Arrives with your ArkAgent account.".into()),
        },
        Provider {
            id: "openai".into(),
            name: "OpenAI".into(),
            summary: "Use an OpenAI API key.".into(),
            /*
             * No ChatGPT plan sign-in. OpenAI's official "Sign in with ChatGPT" programme is the
             * only route for a paid app, and it needs OpenAI's approval first; the Codex CLI's own
             * login is not ours to reuse. It returns here, as its own row, once approved.
             */
            logins: vec![Login::ApiKey],
            mark: Some("openai".into()),
            caution: None,
            unavailable: None,
        },
        Provider {
            id: "anthropic".into(),
            name: "Anthropic".into(),
            summary: "Use an Anthropic API key.".into(),
            /*
             * An API key only. Anthropic does not permit a product to offer Claude plan sign-in or
             * to route requests through plan credentials; a person who wants to use their plan does
             * that in their own, unmodified Claude Code.
             */
            logins: vec![Login::ApiKey],
            mark: Some("anthropic".into()),
            caution: Some(Caution {
                says: "A Claude.ai plan cannot be used here. Use an API key from the Anthropic \
                       Console; it is billed to you by Anthropic."
                    .into(),
                reads_more_at: "https://code.claude.com/docs/en/legal-and-compliance".into(),
            }),
            unavailable: None,
        },
        Provider {
            id: "google".into(),
            name: "Google Gemini".into(),
            summary: "Use a Google AI Studio key or sign in for Gemini API access.".into(),
            logins: vec![Login::Endpoint, Login::Oauth],
            mark: None,
            caution: None,
            unavailable: None,
        },
        Provider {
            id: "xai".into(),
            name: "xAI".into(),
            summary: "Use an xAI API key or sign in to your xAI account.".into(),
            logins: vec![Login::Endpoint, Login::Oauth],
            mark: None,
            caution: None,
            unavailable: None,
        },
        Provider {
            id: "openai-compatible".into(),
            name: "Any OpenAI-compatible endpoint".into(),
            summary: "Azure, Bedrock, Mistral, DeepSeek, Ollama, vLLM or your own.".into(),
            logins: vec![Login::Endpoint],
            // Deliberately unmarked: it stands for every provider rather than one, so any single
            // vendor's logo here would be a lie about what the row does.
            mark: None,
            caution: None,
            unavailable: None,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// No row, now or by accident, offers a chat-subscription sign-in. The `Login` type has no such
    /// way in; this keeps a future one from arriving without somebody deciding it should.
    #[test]
    fn no_provider_offers_a_chat_plan_sign_in() {
        let allowed = [Login::ApiKey, Login::Endpoint, Login::Oauth, Login::Managed];
        for provider in catalogue() {
            for login in &provider.logins {
                assert!(allowed.contains(login), "{} offers {login:?}", provider.id);
            }
        }
        let serialised = serde_json::to_string(&catalogue()).unwrap();
        assert!(!serialised.contains("\"plan\""));
    }

    /// Only Google and xAI sign in; for them it is their own model API, not a chat subscription.
    #[test]
    fn only_google_and_xai_sign_in() {
        let signing_in: Vec<String> = catalogue()
            .into_iter()
            .filter(|p| p.logins.contains(&Login::Oauth))
            .map(|p| p.id)
            .collect();
        assert_eq!(signing_in, vec!["google", "xai"]);
    }

    /// Named providers stay ahead of the custom endpoint escape hatch.
    #[test]
    fn the_free_ways_first_then_four_named_providers_and_one_custom_endpoint() {
        let rows = catalogue();
        let ids: Vec<&str> = rows.iter().map(|provider| provider.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "local",
                "ark-server",
                "openai",
                "anthropic",
                "google",
                "xai",
                "openai-compatible"
            ]
        );
    }

    /// The choice at setup: this computer, ArkAgent's server (not yet), or the person's own key.
    #[test]
    fn this_computer_can_be_chosen_and_arkagents_server_is_shown_but_not_yet_available() {
        let rows = catalogue();
        let local = rows.iter().find(|p| p.id == "local").unwrap();
        assert_eq!(local.logins, vec![Login::Managed]);
        assert_eq!(local.unavailable, None);
        let server = rows.iter().find(|p| p.id == "ark-server").unwrap();
        assert!(server.logins.is_empty());
        assert!(server
            .unavailable
            .as_deref()
            .is_some_and(|said| said.contains("ArkAgent account")));
        // Nothing else is held back.
        for other in rows.iter().filter(|p| p.id != "ark-server") {
            assert_eq!(other.unavailable, None, "{}", other.id);
        }
    }

    /// Every row is readable without recognising a logo.
    #[test]
    fn every_row_has_a_name() {
        for provider in catalogue() {
            assert!(
                !provider.name.trim().is_empty(),
                "{} has no name",
                provider.id
            );
        }
    }

    /// The Anthropic caution is required: someone who pays for Claude will look for the plan
    /// sign-in, and has to be told why it is not there.
    #[test]
    fn anthropic_says_why_a_claude_plan_cannot_be_used() {
        let anthropic = catalogue()
            .into_iter()
            .find(|p| p.id == "anthropic")
            .expect("anthropic is not offered");
        let caution = anthropic.caution.expect("anthropic carries no caution");
        assert!(caution.says.contains("plan cannot be used"));
        assert!(caution.reads_more_at.starts_with("https://"));
    }
}
