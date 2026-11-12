import { describe, expect, test } from "bun:test";
import { pastedCallback } from "@/lib/plugins/pasted-callback";

describe("finishing sign-in from a pasted address (#83)", () => {
  test("the browser's address becomes this app's own callback, with only code and state", () => {
    expect(
      pastedCallback(
        "  http://localhost:3001/api/plugins/oauth/callback?state=s.1&code=4/0Ab&scope=https://www.googleapis.com/auth/gmail.readonly&authuser=0 ",
      ),
    ).toEqual({
      ok: true,
      path: "/api/plugins/oauth/callback?code=4%2F0Ab&state=s.1",
    });
  });

  test("another host is fine: the browser may have seen the app under any name", () => {
    expect(
      pastedCallback(
        "http://172.17.0.1:3001/api/plugins/oauth/callback?code=c&state=s",
      ).ok,
    ).toBe(true);
  });

  test("a declined consent, a stranger's page, a half-copied address and plain text are refused in words", () => {
    const declined = pastedCallback(
      "http://localhost:3001/api/plugins/oauth/callback?error=access_denied&state=s",
    );
    expect(declined.ok).toBe(false);
    expect(!declined.ok && declined.message).toContain("declined");
    for (const pasted of [
      "https://accounts.google.com/o/oauth2/auth?code=c&state=s",
      "http://localhost:3001/api/plugins/oauth/callback?code=c",
      "code=c&state=s",
      "",
    ]) {
      expect(pastedCallback(pasted).ok).toBe(false);
    }
  });
});
