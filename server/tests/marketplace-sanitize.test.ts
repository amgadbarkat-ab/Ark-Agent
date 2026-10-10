import { describe, expect, test } from "bun:test";
import { judge, scan } from "../src/marketplace/sanitize";

const kinds = (text: string) => scan({ text }).map((f) => f.kind);

describe("secrets are always found", () => {
  test.each([
    [
      "an OpenAI-style key",
      "Use sk-proj-AbCdEfGhIjKlMnOpQrStUv123456 for calls",
      "api_key",
    ],
    [
      "an Anthropic key",
      "key: sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx",
      "api_key",
    ],
    ["an AWS access key", "AKIAIOSFODNN7EXAMPLE is the id", "api_key"],
    ["a Google key", "AIzaSyA-1234567890abcdefghijklmnopqrstuv", "api_key"],
    ["a Stripe live key", "sk_live_51H8abcdEFGHijklMNOPqrst", "api_key"],
    ["a GitHub token", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "token"],
    ["a Slack token", "xoxb-1234567890-abcdefghij", "token"],
    [
      "a JWT",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      "token",
    ],
    [
      "a bearer header",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
      "token",
    ],
    ["a private key block", "-----BEGIN RSA PRIVATE KEY-----", "private_key"],
    ["a password assignment", "password: hunter2hunter2", "password"],
    ["an api_key assignment", 'api_key = "abcd1234efgh5678"', "api_key"],
    [
      "credentials in a URL",
      "connect to postgres://admin:s3cret@db.example.com/app",
      "credentials_in_url",
    ],
  ])("%s", (_name, text, kind) => {
    expect(kinds(text)).toContain(kind);
  });

  test("a finding says where it is and never what it found", () => {
    const [finding] = scan({
      roleDescription:
        "line one\nuse sk-proj-AbCdEfGhIjKlMnOpQrStUv123456 here",
    });
    expect(finding).toMatchObject({
      kind: "api_key",
      field: "roleDescription",
      line: 2,
    });
    expect(JSON.stringify(finding)).not.toContain("AbCdEf");
  });
});

describe("private data is found", () => {
  test.each([
    ["an email", "Send it to jane.doe@acme-corp.com please", "email"],
    [
      "an international phone number",
      "Call +49 30 1234 5678 any time",
      "phone",
    ],
    ["a formatted phone number", "Phone: (415) 555-0132", "phone"],
    ["a card number", "Card 4539 1488 0343 6467 on file", "payment_card"],
    ["an IBAN", "Pay to DE89 3704 0044 0532 0130 00", "iban"],
    ["a private IP", "the server at 10.0.4.17 runs it", "internal_address"],
    ["localhost", "it listens on localhost:8080", "internal_address"],
    ["an internal hostname", "see wiki.corp for the rota", "internal_address"],
  ])("%s", (_name, text, kind) => {
    expect(kinds(text)).toContain(kind);
  });
});

describe("ordinary writing is left alone", () => {
  test.each([
    "You are a careful research assistant. Summarise sources in plain English and cite them.",
    "Review expense reports above 500 euros and flag missing receipts. Never approve anything yourself.",
    "Version 2.3.1 released on 2026-10-08 with 12 fixes and 3 known issues.",
    "Ask for the invoice number, the amount (e.g. 1250.00) and the due date.",
    "Use the search tool first, then the calendar tool. Keep answers under 200 words.",
    "The password policy requires twelve characters; explain it to users who ask.",
    "Contact the user's manager only if they ask you to.",
    "Order 1234567 shipped on 12.03.2026",
  ])("%s", (text) => {
    expect(scan({ text })).toEqual([]);
  });

  test("a number that fails the card check is not a card", () => {
    expect(kinds("reference 4539 1488 0343 6468")).not.toContain(
      "payment_card",
    );
  });
});

describe("the verdict", () => {
  const clean = {
    roleDescription: "You summarise meeting notes into actions.",
  };

  test("clean text passes", () => {
    expect(judge(clean, { confirmedNoPrivateData: false })).toEqual({
      ok: true,
    });
  });

  test("a secret is refused whatever the publisher says", () => {
    const verdict = judge(
      { notes: "key sk-proj-AbCdEfGhIjKlMnOpQrStUv123456" },
      { confirmedNoPrivateData: true },
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.secrets).toHaveLength(1);
  });

  test("private data needs the publisher to say they checked, and then passes", () => {
    const text = { notes: "Questions go to support@acme-corp.com" };
    const refused = judge(text, { confirmedNoPrivateData: false });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.secrets).toEqual([]);
      expect(refused.privateData.map((f) => f.kind)).toEqual(["email"]);
    }
    expect(judge(text, { confirmedNoPrivateData: true })).toEqual({ ok: true });
  });
});
