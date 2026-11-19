/**
 * The Workers relay's line CLI against the relay itself (over stand-ins): the token is made here,
 * printed once to the terminal (stderr), and only its SHA-256 reaches the relay.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { sha256Hex } from "../relay";
import { runCli } from "./cli";
import { adminToken, base, setup, until } from "./harness";
import type { FakeSocket } from "./stand-ins";

const made: ReturnType<typeof setup>[] = [];
afterEach(() => {
  for (const t of made.splice(0)) t.stop();
});

function cli(t: ReturnType<typeof setup>, token = adminToken) {
  return async (...args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(
      args,
      { out: (line) => out.push(line), err: (line) => err.push(line) },
      {
        relayUrl: base,
        adminToken: token,
        fetch: (input, init) => t.worker.fetch(new Request(input, init), t.env),
      },
    );
    return { code, out, err };
  };
}

describe("the line CLI", () => {
  test("add-line prints the token once, on stderr; the relay keeps only its SHA-256, and the install connects with it", async () => {
    const t = setup({ billing: false });
    made.push(t);
    const run = cli(t);
    const added = await run(
      "add-line",
      "demo-shop",
      "+302101234567",
      "+306900000000",
    );
    expect(added.code).toBe(0);
    const token =
      added.err
        .find((line) => /^[A-Za-z0-9_-]{40,}$/.test(line.trim()))
        ?.trim() ?? "";
    expect(token.length).toBeGreaterThan(40);
    expect(added.out.join("\n")).not.toContain(token);
    const listed = await run("lines");
    expect(listed.out.join("\n")).toContain(
      "demo-shop\t+302101234567\tfallback +306900000000\tnot billed",
    );
    expect(listed.out.join("\n")).not.toContain(token);
    expect(listed.out.join("\n")).not.toContain(sha256Hex(token));
    const desk = (await t.desk(token)) as FakeSocket;
    await until(() => desk.messages().some((m) => m.type === "hello"));
  });

  test("bill-line, a second billed line refused, remove-line, and the checks before anything is sent", async () => {
    const t = setup();
    made.push(t);
    const run = cli(t);
    await run("add-line", "demo-shop", "+302101234567");
    await run("add-line", "other-shop", "+302107654321");
    expect((await run("bill-line", "demo-shop", "demo-phone")).code).toBe(0);
    expect((await run("lines")).out.join("\n")).toContain(
      "billed to demo-phone",
    );
    const twice = await run("bill-line", "other-shop", "demo-phone");
    expect(twice.code).toBe(1);
    expect(twice.err.join("\n")).toContain("already billed");
    expect((await run("remove-line", "other-shop")).code).toBe(0);
    expect((await run("lines")).out.join("\n")).not.toContain("other-shop");
    expect((await run("add-line", "Bad Name", "+302101234567")).code).toBe(1);
    expect((await run("add-line", "ok-name", "2101234567")).code).toBe(1);
    expect((await run("remove-line", "nobody")).code).toBe(1);
  });

  test("a wrong admin token is refused, with no token printed", async () => {
    const t = setup({ billing: false });
    made.push(t);
    const refused = await cli(t, "wrong")(
      "add-line",
      "demo-shop",
      "+302101234567",
    );
    expect(refused.code).toBe(1);
    expect(refused.err.join("\n")).toContain("ADMIN_TOKEN");
    expect(
      refused.err.some((line) => /^[A-Za-z0-9_-]{40,}$/.test(line.trim())),
    ).toBe(false);
  });
});
