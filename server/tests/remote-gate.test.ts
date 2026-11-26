import { describe, expect, test } from "bun:test";
import { createOwnBrowser, withOwnBrowser } from "../src/computer/own-browser";
import type { ComputerProvider } from "../src/computer/provider";
import {
  APPROVAL_MS,
  createRemoteGate,
  DENIED_QUIET_MS,
  PROMPTS_PER_WINDOW,
  REMOTE_QUIET,
  REMOTE_RECENT_MS,
  REMOTE_REFUSED,
  REMOTE_TOO_MANY,
  type RemoteGatePrompt,
  viaOf,
} from "../src/host-access/remote-gate";

/**
 * Device control while the administrator's account is used from another computer (the Security
 * Engineer's review of v0.1.57, F-B and F-C): every action on their own browser waits for a yes on
 * this computer, which lasts 10 minutes, and the prompts cannot be raised at will.
 */
function gate(answer: (prompt: RemoteGatePrompt) => boolean) {
  let clock = 1_000_000;
  const asked: RemoteGatePrompt[] = [];
  const remote = createRemoteGate({
    now: () => clock,
    confirm: async (prompt) => {
      asked.push(prompt);
      if (!answer(prompt)) throw new Error("denied");
    },
    describe: async () => "maria@shop.example",
    botName: async () => "Sales",
  });
  return {
    remote,
    asked,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("the own browser while the account is used from another computer", () => {
  test("at this computer alone, nothing is asked", async () => {
    const { remote, asked } = gate(() => false);
    await remote.require({ botId: "sales", actorId: "admin" });
    expect(asked).toEqual([]);
  });

  test("used from another computer, it asks once, names who, how and how long, and the yes lasts 10 minutes", async () => {
    const { remote, asked, advance } = gate(() => true);
    remote.noteRemote("admin", "relay");
    await remote.require({ botId: "sales", actorId: "admin" });
    expect(asked).toEqual([
      {
        botId: "sales",
        botName: "Sales",
        actorId: "admin",
        account: "maria@shop.example",
        via: "relay",
        minutes: 10,
      },
    ]);
    advance(APPROVAL_MS - 1_000);
    await remote.require({ botId: "sales", actorId: "admin" });
    expect(asked).toHaveLength(1);
    // After 10 minutes, while still used from there, it asks again.
    remote.noteRemote("admin", "relay");
    advance(2_000);
    await remote.require({ botId: "sales", actorId: "admin" });
    expect(asked).toHaveLength(2);
  });

  test("a yes for one employee is not a yes for another", async () => {
    const { remote, asked } = gate(() => true);
    remote.noteRemote("admin", "office network");
    await remote.require({ botId: "sales", actorId: "admin" });
    await remote.require({ botId: "support", actorId: "admin" });
    expect(asked.map((one) => one.botId)).toEqual(["sales", "support"]);
  });

  test("a no refuses, and nothing is asked again for 2 minutes", async () => {
    const { remote, asked, advance } = gate(() => false);
    remote.noteRemote("admin", "relay");
    await expect(
      remote.require({ botId: "sales", actorId: "admin" }),
    ).rejects.toThrow(REMOTE_REFUSED);
    await expect(
      remote.require({ botId: "sales", actorId: "admin" }),
    ).rejects.toThrow(REMOTE_QUIET);
    expect(asked).toHaveLength(1);
    advance(DENIED_QUIET_MS + 1);
    await expect(
      remote.require({ botId: "sales", actorId: "admin" }),
    ).rejects.toThrow(REMOTE_REFUSED);
    expect(asked).toHaveLength(2);
  });

  test("many actions at once share one question", async () => {
    let release: (() => void) | undefined;
    const asked: string[] = [];
    const remote = createRemoteGate({
      confirm: (prompt) =>
        new Promise<void>((resolve) => {
          asked.push(prompt.botId);
          release = resolve;
        }),
    });
    remote.noteRemote("admin", "relay");
    const all = Promise.all(
      [1, 2, 3].map(() => remote.require({ botId: "sales", actorId: "admin" })),
    );
    await Bun.sleep(5);
    release?.();
    await all;
    expect(asked).toEqual(["sales"]);
  });

  test("the window cannot be raised over and over: at most a few questions in 10 minutes", async () => {
    const { remote, asked } = gate(() => false);
    remote.noteRemote("admin", "relay");
    for (let n = 0; n < PROMPTS_PER_WINDOW; n += 1)
      await expect(
        remote.require({ botId: `bot-${n}`, actorId: "admin" }),
      ).rejects.toThrow(REMOTE_REFUSED);
    await expect(
      remote.require({ botId: "one-more", actorId: "admin" }),
    ).rejects.toThrow(REMOTE_TOO_MANY);
    expect(asked).toHaveLength(PROMPTS_PER_WINDOW);
  });

  test("15 minutes after the last request from another computer, it stops asking", async () => {
    const { remote, asked, advance } = gate(() => false);
    remote.noteRemote("admin", "relay");
    advance(REMOTE_RECENT_MS + 1);
    await remote.require({ botId: "sales", actorId: "admin" });
    expect(asked).toEqual([]);
  });

  test("a request that itself came from another computer is asked even before any other was seen", async () => {
    const { remote, asked } = gate(() => true);
    await remote.require({ botId: "sales", actorId: "admin", via: "relay" });
    expect(asked).toHaveLength(1);
  });

  test("the relay arrives from this computer itself; the office network from another one", () => {
    const server = (address: string) => ({
      requestIP: () => ({ address }),
    });
    const request = new Request("https://office/");
    expect(viaOf(server("127.0.0.1"), request)).toBe("relay");
    expect(viaOf(server("::ffff:127.0.0.1"), request)).toBe("relay");
    expect(viaOf(server("192.168.1.20"), request)).toBe("office network");
    expect(viaOf(undefined, request)).toBe("office network");
  });
});

describe("every action on the own browser passes the gate (F-B)", () => {
  const base = {
    name: "test",
    isolation: "process",
    locate: async () => "http://sandbox.invalid",
    status: async (botId: string) => ({ botId, state: "ready" as const }),
    stop: async () => ({ wasRunning: false }),
    reset: async () => ({ wasRunning: false }),
    list: async () => [],
  } as unknown as ComputerProvider;

  test("screenshots, clicks and chat runs all locate the browser here, so all of them wait for the yes", async () => {
    const own = createOwnBrowser();
    own.announce("http://127.0.0.1:41234");
    own.choose("sales", "admin");
    const { remote, asked } = gate(() => false);
    const provider = withOwnBrowser(base, own, {
      gate: (input) => remote.require(input),
    });
    // At this computer alone: straight through.
    expect(await provider.locate("sales")).toBe("http://127.0.0.1:41234");
    // Now the account is used from another computer: refused until allowed here.
    remote.noteRemote("admin", "relay");
    await expect(provider.locate("sales")).rejects.toThrow(REMOTE_REFUSED);
    expect(asked).toHaveLength(1);
    // An employee in the sandbox is not the administrator's browser: never asked.
    expect(await provider.locate("support")).toBe("http://sandbox.invalid");
    expect(asked).toHaveLength(1);
  });
});
