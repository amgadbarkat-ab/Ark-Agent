import { describe, expect, test } from "bun:test";
import { connectedAccount } from "../src/plugins/connected-account";

function answering(status: number, body: unknown, seen: string[] = []) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(
      `${String(input)} ${new Headers(init?.headers).get("authorization")}`,
    );
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

describe("which account was connected (#83: the Gmail page names no account)", () => {
  test("Gmail names the mailbox from its profile, asked with the fresh access token", async () => {
    const seen: string[] = [];
    expect(
      await connectedAccount(
        "google-gmail",
        "ya29.token",
        answering(200, { emailAddress: "arkagenttest@gmail.com" }, seen),
      ),
    ).toBe("arkagenttest@gmail.com");
    expect(seen).toEqual([
      "https://gmail.googleapis.com/gmail/v1/users/me/profile Bearer ya29.token",
    ]);
  });

  test("Drive reads the nested address, Microsoft falls back to the sign-in name", async () => {
    expect(
      await connectedAccount(
        "google-drive",
        "t",
        answering(200, { user: { emailAddress: "a@b.gr" } }),
      ),
    ).toBe("a@b.gr");
    expect(
      await connectedAccount(
        "microsoft-365",
        "t",
        answering(200, { mail: null, userPrincipalName: "nikos@wine24.gr" }),
      ),
    ).toBe("nikos@wine24.gr");
  });

  test("a refusal, an odd answer, a throw, no token or an unknown connector name nobody", async () => {
    expect(
      await connectedAccount("google-gmail", "t", answering(401, {})),
    ).toBeNull();
    expect(
      await connectedAccount(
        "google-gmail",
        "t",
        answering(200, { emailAddress: "<script>x</script>" }),
      ),
    ).toBeNull();
    expect(
      await connectedAccount("google-gmail", "t", (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch),
    ).toBeNull();
    expect(await connectedAccount("google-gmail", undefined)).toBeNull();
    expect(
      await connectedAccount("linear", "t", answering(200, { email: "x@y.z" })),
    ).toBeNull();
  });
});
