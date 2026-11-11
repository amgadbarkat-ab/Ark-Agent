import { describe, expect, test } from "bun:test";
import {
  builtinOAuthClientFor,
  builtinOAuthClientsFrom,
} from "../src/plugins/builtin-oauth-clients";

/** ArkAgent's own Google and Microsoft apps (desk #83), from the environment the desktop writes. */
describe("which built-in client a connector gets", () => {
  const clients = builtinOAuthClientsFrom({
    ARKAGENT_GOOGLE_OAUTH_CLIENT_ID: " google-id.apps.googleusercontent.com ",
    ARKAGENT_GOOGLE_OAUTH_CLIENT_SECRET: "google-desktop-secret",
    ARKAGENT_MICROSOFT_OAUTH_CLIENT_ID: "11111111-2222-3333-4444-555555555555",
  });

  test("Gmail and Drive get Google's, trimmed, with its desktop secret", () => {
    for (const key of ["google-gmail", "google-drive"]) {
      expect(builtinOAuthClientFor(key, clients)).toEqual({
        clientId: "google-id.apps.googleusercontent.com",
        clientSecret: "google-desktop-secret",
      });
    }
  });

  test("Microsoft 365 gets Microsoft's, a public client with no secret", () => {
    expect(builtinOAuthClientFor("microsoft-365", clients)).toEqual({
      clientId: "11111111-2222-3333-4444-555555555555",
      clientSecret: "",
    });
  });

  test("a vendor that registers itself, and anything not in the catalogue, get none", () => {
    expect(builtinOAuthClientFor("notion", clients)).toBeNull();
    expect(builtinOAuthClientFor("somebody-elses-server", clients)).toBeNull();
    expect(builtinOAuthClientFor("composio-gmail", clients)).toBeNull();
  });

  test("unset or blank is none, which is a hosted deployment's normal state", () => {
    const none = builtinOAuthClientsFrom({
      ARKAGENT_GOOGLE_OAUTH_CLIENT_ID: "  ",
      ARKAGENT_GOOGLE_OAUTH_CLIENT_SECRET: "a secret with no id is nothing",
    });
    expect(none).toEqual({});
    expect(builtinOAuthClientFor("google-gmail", none)).toBeNull();
    expect(builtinOAuthClientFor("microsoft-365", {})).toBeNull();
  });
});
