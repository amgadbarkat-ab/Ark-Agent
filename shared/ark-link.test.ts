import { describe, expect, test } from "bun:test";
import {
  cleanDeviceName,
  DATA_KIND,
  decodeData,
  decodeDeskMessage,
  decodeRelayMessage,
  deviceTokenFrom,
  encodeControl,
  encodeData,
  formatPairingCode,
  forwardableRequestHeaders,
  forwardableResponseHeaders,
  isDeviceToken,
  isInstallToken,
  newDeviceToken,
  newInstallToken,
  newPairingCode,
  normalisePairingCode,
  PAIRING_CODE_ALPHABET,
  pairUrl,
  tokenHash,
} from "./ark-link";

describe("Ark Link contract", () => {
  test("tokens carry their kind and 32 random bytes", () => {
    const device = newDeviceToken();
    const install = newInstallToken();
    expect(device).toMatch(/^arkd_[A-Za-z0-9_-]{43}$/);
    expect(install).toMatch(/^arki_[A-Za-z0-9_-]{43}$/);
    expect(isDeviceToken(device)).toBe(true);
    expect(isDeviceToken(install)).toBe(false);
    expect(isInstallToken(install)).toBe(true);
    expect(newDeviceToken()).not.toBe(device);
  });

  test("a token is stored as its SHA-256 in hex", async () => {
    // echo -n abc | sha256sum
    expect(await tokenHash("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("a pairing code is 8 characters a person can read off a screen", () => {
    const code = newPairingCode();
    expect(code).toHaveLength(8);
    for (const character of code)
      expect(PAIRING_CODE_ALPHABET).toContain(character);
    expect(PAIRING_CODE_ALPHABET).not.toMatch(/[ILO01]/);
  });

  test("codes are drawn without bias: bytes past the last whole alphabet are skipped", () => {
    // 31 letters: 248 is the first byte that would favour the start of the alphabet.
    const bytes = [255, 248, 0, 1, 2, 3, 4, 5, 6, 30];
    const code = newPairingCode(() => Uint8Array.from(bytes));
    expect(code).toBe("ABCDEFG9");
  });

  test("what a person types is read leniently, and only real codes pass", () => {
    expect(normalisePairingCode("abcd-efgh")).toBe("ABCDEFGH");
    expect(normalisePairingCode(" ABCD EFGH ")).toBe("ABCDEFGH");
    expect(normalisePairingCode("ABCDEFG")).toBeNull();
    expect(normalisePairingCode("ABCDEFGO")).toBeNull();
    expect(normalisePairingCode("ABCDEFG1")).toBeNull();
    expect(formatPairingCode("ABCDEFGH")).toBe("ABCD-EFGH");
  });

  test("the QR code holds the pairing page with the code", () => {
    expect(pairUrl("https://link.example/", "ABCDEFGH")).toBe(
      "https://link.example/_link/pair?code=ABCDEFGH",
    );
  });

  test("a device name is trimmed, kept short and stripped of control characters", () => {
    expect(cleanDeviceName("  Μαρία's Pixel\u0007 ")).toBe("Μαρία's Pixel");
    expect(cleanDeviceName("   ")).toBeNull();
    expect(cleanDeviceName(42)).toBeNull();
    expect(cleanDeviceName("x".repeat(100))).toHaveLength(60);
  });

  test("the device token is read from the ArkLink header, then the cookie", () => {
    const token = newDeviceToken();
    expect(
      deviceTokenFrom(new Headers({ authorization: `ArkLink ${token}` })),
    ).toBe(token);
    expect(
      deviceTokenFrom(new Headers({ cookie: `a=1; ark_link=${token}; b=2` })),
    ).toBe(token);
    expect(
      deviceTokenFrom(new Headers({ authorization: "ArkLink not-a-token" })),
    ).toBeNull();
    // Another scheme is the app's business, and the cookie still counts.
    expect(
      deviceTokenFrom(
        new Headers({ authorization: "Bearer x", cookie: `ark_link=${token}` }),
      ),
    ).toBe(token);
    expect(deviceTokenFrom(new Headers())).toBeNull();
  });

  test("data frames carry kind, stream and payload, without base64", () => {
    const frame = encodeData(DATA_KIND.body, 258, Uint8Array.from([7, 8, 9]));
    expect([...frame]).toEqual([1, 0, 0, 1, 2, 7, 8, 9]);
    const decoded = decodeData(frame);
    expect(decoded?.kind).toBe(1);
    expect(decoded?.stream).toBe(258);
    expect([...(decoded?.payload ?? [])]).toEqual([7, 8, 9]);
    expect(decodeData(Uint8Array.from([9, 0, 0, 0, 1]))).toBeNull();
    expect(decodeData(Uint8Array.from([1, 0]))).toBeNull();
  });

  test("control frames from either side are checked, and unknown ones are dropped", () => {
    const token = newDeviceToken();
    const request = {
      t: "req" as const,
      s: 3,
      method: "GET",
      path: "/api/me",
      headers: [["accept", "application/json"]] as [string, string][],
      device: { id: "dev1", token },
      body: false,
    };
    expect(decodeRelayMessage(encodeControl(request))).toEqual(request);
    expect(
      decodeRelayMessage(JSON.stringify({ ...request, path: "api" })),
    ).toBeNull();
    expect(decodeRelayMessage(JSON.stringify({ ...request, s: 0 }))).toBeNull();
    expect(decodeRelayMessage('{"t":"something-new"}')).toBeNull();
    expect(decodeRelayMessage("not json")).toBeNull();

    const confirm = {
      t: "pair.confirm" as const,
      pairingId: "p1",
      device: { id: "dev1", name: "Pixel", tokenSha256: "a".repeat(64) },
      token,
    };
    expect(decodeDeskMessage(encodeControl(confirm))).toEqual(confirm);
    expect(
      decodeDeskMessage(JSON.stringify({ ...confirm, token: "plain" })),
    ).toBeNull();
    expect(
      decodeDeskMessage(
        JSON.stringify({
          t: "devices",
          devices: [{ id: "x", tokenSha256: "no" }],
        }),
      ),
    ).toBeNull();
    expect(
      decodeDeskMessage(
        JSON.stringify({ t: "res", s: 1, status: 200, headers: [["a", 1]] }),
      ),
    ).toBeNull();
  });

  test("the relay forwards neither the device credential nor forged forwarding headers", () => {
    const token = newDeviceToken();
    const forwarded = forwardableRequestHeaders(
      new Headers({
        authorization: `ArkLink ${token}`,
        cookie: `session=s1; ark_link=${token}; theme=dark`,
        "x-forwarded-host": "evil.example",
        forwarded: "for=1.2.3.4",
        connection: "keep-alive",
        accept: "text/html",
      }),
    );
    expect(forwarded).toEqual([
      ["accept", "text/html"],
      ["cookie", "session=s1; theme=dark"],
    ]);
    expect(
      forwardableRequestHeaders(new Headers({ authorization: "Bearer abc" })),
    ).toEqual([["authorization", "Bearer abc"]]);
  });

  test("a desktop cannot overwrite the phone's device cookie", () => {
    expect(
      forwardableResponseHeaders([
        ["set-cookie", "ark_link=x; Path=/"],
        ["set-cookie", "session=y; Path=/"],
        ["transfer-encoding", "chunked"],
        ["content-type", "text/html"],
      ]),
    ).toEqual([
      ["set-cookie", "session=y; Path=/"],
      ["content-type", "text/html"],
    ]);
  });
});
