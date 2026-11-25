import { expect, test } from "bun:test";
import {
  captureSetupSecret,
  SETUP_TOKEN_HEADER,
  setupSecretHeaders,
} from "../src/lib/auth/setup-secret";

/**
 * The desktop's set-up secret (security review of v0.1.54): taken from the address before anything
 * else, kept for the window's session, and gone from the address at once.
 */
function store() {
  const values = new Map<string, string>();
  return {
    setItem: (key: string, value: string) => void values.set(key, value),
    getItem: (key: string) => values.get(key) ?? null,
  };
}

test("the secret leaves the address, stays with the window, and goes with the set-up request", () => {
  const storage = store();
  const replaced: string[] = [];
  captureSetupSecret(
    { hash: "#ark-setup=ab%2Bc%2Fd%3D", pathname: "/", search: "?lang=el" },
    { replaceState: (_state, _title, url) => void replaced.push(String(url)) },
    storage,
  );
  expect(replaced).toEqual(["/?lang=el"]);
  expect(setupSecretHeaders(storage)).toEqual({
    [SETUP_TOKEN_HEADER]: "ab+c/d=",
  });
});

test("a window the desktop gave no secret sends none, and its address is left alone", () => {
  const storage = store();
  const replaced: string[] = [];
  captureSetupSecret(
    { hash: "#section", pathname: "/sign", search: "" },
    { replaceState: (_state, _title, url) => void replaced.push(String(url)) },
    storage,
  );
  expect(replaced).toEqual([]);
  expect(setupSecretHeaders(storage)).toEqual({});
});
