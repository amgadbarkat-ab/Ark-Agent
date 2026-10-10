import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import {
  decryptSecret,
  encryptionKeyId,
  encryptSecret,
  needsResealing,
  useRetiredEncryptionKeys,
} from "../src/credentials";
import { testEnvironment } from "./support/environment";

/**
 * Changing the data-encryption key without losing anything it sealed.
 *
 * The properties that matter: a value sealed under the key you are leaving is still readable while
 * you move; nothing new is ever sealed under it; a value whose key is gone says so rather than
 * returning junk; and the key's public name reveals nothing about the key.
 */

const OLD = Buffer.alloc(32, 1).toString("base64");
const NEW = Buffer.alloc(32, 2).toString("base64");
const OTHER = Buffer.alloc(32, 3).toString("base64");

afterEach(() => useRetiredEncryptionKeys([]));

describe("sealing", () => {
  test("a value names the key that sealed it, and the name is not the key", async () => {
    const sealed = JSON.parse(await encryptSecret(NEW, "secret"));
    expect(sealed.kid).toBe(await encryptionKeyId(NEW));
    expect(sealed.kid).not.toBe(await encryptionKeyId(OLD));
    expect(sealed.kid).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(sealed)).not.toContain(NEW);
  });

  test("a retired key still opens what it sealed, and never seals anything new", async () => {
    const before = await encryptSecret(OLD, "from the old days");
    useRetiredEncryptionKeys([OLD]);

    expect(await decryptSecret(NEW, before)).toBe("from the old days");
    expect(await needsResealing(NEW, before)).toBe(true);

    const after = await encryptSecret(NEW, "from today");
    expect(JSON.parse(after).kid).toBe(await encryptionKeyId(NEW));
    expect(await needsResealing(NEW, after)).toBe(false);
  });

  test("a value sealed before keys had names, which says nothing about which one, is found by trying", async () => {
    // Exactly what the previous version of the server wrote.
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.importKey(
      "raw",
      Buffer.from(OLD, "base64"),
      { name: "AES-GCM" },
      false,
      ["encrypt"],
    );
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode("legacy"),
    );
    const legacy = JSON.stringify({
      version: 1,
      iv: Buffer.from(iv).toString("base64"),
      ciphertext: Buffer.from(ciphertext).toString("base64"),
    });

    expect(await decryptSecret(OLD, legacy)).toBe("legacy");
    expect(await needsResealing(OLD, legacy)).toBe(true);
    useRetiredEncryptionKeys([OLD]);
    expect(await decryptSecret(NEW, legacy)).toBe("legacy");
    useRetiredEncryptionKeys([]);
    await expect(decryptSecret(NEW, legacy)).rejects.toThrow();
  });

  test("a value whose key is no longer held is refused in words, not returned as noise", async () => {
    const sealed = await encryptSecret(OTHER, "lost");
    useRetiredEncryptionKeys([OLD]);
    await expect(decryptSecret(NEW, sealed)).rejects.toThrow(/no longer holds/);
  });

  test("two retired keys are both usable, for a rotation begun before the last one ended", async () => {
    const a = await encryptSecret(OLD, "a");
    const b = await encryptSecret(OTHER, "b");
    useRetiredEncryptionKeys([OLD, OTHER]);
    expect(await decryptSecret(NEW, a)).toBe("a");
    expect(await decryptSecret(NEW, b)).toBe("b");
  });
});

describe("configuration", () => {
  const base = { KEY_ENCRYPTION_KEY: NEW };

  test("none by default", () => {
    expect(loadConfig(testEnvironment(base)).previousKeyEncryptionKeys).toEqual(
      [],
    );
  });

  test("one or several, separated by commas or spaces", () => {
    expect(
      loadConfig(
        testEnvironment({
          ...base,
          KEY_ENCRYPTION_KEY_PREVIOUS: `${OLD}, ${OTHER}`,
        }),
      ).previousKeyEncryptionKeys,
    ).toEqual([OLD, OTHER]);
  });

  test("a key that is not a 32-byte base64 key is refused at start", () => {
    expect(() =>
      loadConfig(
        testEnvironment({ ...base, KEY_ENCRYPTION_KEY_PREVIOUS: "short" }),
      ),
    ).toThrow(/KEY_ENCRYPTION_KEY_PREVIOUS must be/);
  });

  test("naming the current key as the old one is refused: the new key was not put in", () => {
    expect(() =>
      loadConfig(
        testEnvironment({ ...base, KEY_ENCRYPTION_KEY_PREVIOUS: NEW }),
      ),
    ).toThrow(/contains the current KEY_ENCRYPTION_KEY/);
  });
});
