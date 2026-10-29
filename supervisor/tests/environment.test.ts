import { describe, expect, test } from "bun:test";
import { environmentFor } from "../src/environment";

describe("what the supervisor tells a computer about its browser", () => {
  test("passes the deployment's browser mode to every per-Bot computer", () => {
    expect(
      environmentFor("invoice-collector", {
        COMPUTER_TOKEN: "secret",
        COMPUTER_BROWSER_MODE: "headed",
      }),
    ).toEqual([
      "COMPUTER_BOT_ID=invoice-collector",
      "COMPUTER_TOKEN=secret",
      "COMPUTER_BROWSER_MODE=headed",
    ]);
  });

  test("does not invent a browser mode when the deployment left it unset", () => {
    expect(
      environmentFor("invoice-collector", { COMPUTER_TOKEN: "secret" }),
    ).toEqual(["COMPUTER_BOT_ID=invoice-collector", "COMPUTER_TOKEN=secret"]);
  });

  test("tells every computer when the private network is closed to its browser, and only then", () => {
    expect(
      environmentFor("invoice-collector", {
        COMPUTER_BLOCK_PRIVATE_NETWORK: "true",
      }),
    ).toEqual([
      "COMPUTER_BOT_ID=invoice-collector",
      "COMPUTER_BLOCK_PRIVATE_NETWORK=true",
    ]);
    expect(
      environmentFor("invoice-collector", {
        COMPUTER_BLOCK_PRIVATE_NETWORK: "false",
      }),
    ).toEqual(["COMPUTER_BOT_ID=invoice-collector"]);
    expect(() =>
      environmentFor("invoice-collector", {
        COMPUTER_BLOCK_PRIVATE_NETWORK: "yes",
      }),
    ).toThrow("must be true or false");
  });
});
