/**
 * The logic both relays share (`core.ts`): the WebCrypto checks the Workers relay uses, compared with
 * Node's crypto (a different implementation), and the TwiML and messages both relays write.
 */
import { describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import {
  billingHeaders,
  hmacSha1Base64,
  parseBalanceView,
  sameText,
  sha256HexWeb,
  signatureBase,
  twilioBasicAuth,
} from "./core";

describe("the shared relay core", () => {
  test("Twilio's signature by WebCrypto equals Node's HMAC-SHA1 over the URL and sorted fields", async () => {
    const url = "https://blackark-phone.blackark.workers.dev/twilio/voice";
    const params = { To: "+302101234567", CallSid: "CA1", AccountSid: "AC1" };
    const node = createHmac("sha1", "token")
      .update(`${url}AccountSidAC1CallSidCA1To+302101234567`)
      .digest("base64");
    expect(signatureBase(url, params)).toBe(
      `${url}AccountSidAC1CallSidCA1To+302101234567`,
    );
    expect(await hmacSha1Base64("token", signatureBase(url, params))).toBe(
      node,
    );
  });

  test("SHA-256 and the billing HMAC by WebCrypto equal Node's", async () => {
    expect(await sha256HexWeb("line-token")).toBe(
      createHash("sha256").update("line-token").digest("hex"),
    );
    const headers = await billingHeaders("secret", '{"a":1}', 1700000000);
    expect(headers["x-ark-time"]).toBe("1700000000");
    expect(headers["x-ark-signature"]).toBe(
      createHmac("sha256", "secret").update('1700000000.{"a":1}').digest("hex"),
    );
  });

  test("the Twilio API's basic auth, without Buffer", () => {
    expect(twilioBasicAuth("AC1", "tok")).toBe(
      `Basic ${Buffer.from("AC1:tok").toString("base64")}`,
    );
  });

  test("text compared in full, never equal by prefix", () => {
    expect(sameText("abc", "abc")).toBe(true);
    expect(sameText("abc", "abd")).toBe(false);
    expect(sameText("abc", "abcd")).toBe(false);
  });

  test("a balance answer is taken only when it has every field and whole positive rates", () => {
    const good = {
      customerId: "demo",
      balanceMils: 100,
      state: "low",
      minutesLeftAtLeast: 0,
      topUpUrl: "https://x",
      rates: { incoming: 78, landline: 88, mobile: 139 },
    };
    expect(parseBalanceView(good)).toEqual(good as never);
    expect(parseBalanceView({ ...good, state: "rich" })).toBeNull();
    expect(
      parseBalanceView({ ...good, rates: { ...good.rates, mobile: 0 } }),
    ).toBeNull();
    expect(parseBalanceView(null)).toBeNull();
  });
});
