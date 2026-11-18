import { afterEach, describe, expect, test } from "bun:test";
import {
  checkinExport,
  githubIssues,
  relayHealth,
  remembered,
  signExport,
} from "./sources";
import { demoExport } from "./standins";

const SECRET = "export-secret-for-tests-0123456789abcdef";
const servers: Array<{ stop: () => void }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
});

/** A stand-in for blackark.uk/checkin/export/, checking requests the way export/index.php does. */
function exportServer(
  answer: (
    nonce: string,
    body: string,
  ) => { time?: string; signature?: string; body?: string },
) {
  const seen = new Set<string>();
  const requests: Array<Record<string, string>> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.text();
      const time = request.headers.get("x-ark-time") ?? "";
      const nonce = request.headers.get("x-ark-nonce") ?? "";
      const signature = request.headers.get("x-ark-signature") ?? "";
      requests.push({ time, nonce, signature, body });
      if (signExport(SECRET, time, nonce, body) !== signature)
        return new Response("{}", { status: 403 });
      if (Math.abs(Number(time) - Date.now() / 1000) > 300)
        return new Response("{}", { status: 403 });
      if (seen.has(nonce)) return new Response("{}", { status: 409 });
      seen.add(nonce);
      const reply = answer(nonce, body);
      const text = reply.body ?? JSON.stringify(demoExport(Date.now()));
      const at = reply.time ?? String(Math.floor(Date.now() / 1000));
      return new Response(text, {
        headers: {
          "x-ark-time": at,
          "x-ark-signature":
            reply.signature ?? signExport(SECRET, at, nonce, text),
        },
      });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}/checkin/export/`, requests };
}

describe("the check-in export client", () => {
  test("signs each request with a new nonce and reads a signed answer", async () => {
    const server = exportServer(() => ({}));
    const source = checkinExport({ url: server.url, secret: SECRET });
    const first = await source.load();
    await source.load();
    expect(first.installs.map((install) => install.customerId)).toContain(
      "demo-shop",
    );
    expect(server.requests).toHaveLength(2);
    expect(server.requests[0]?.nonce).not.toBe(server.requests[1]?.nonce);
    expect(server.requests[0]?.body).toBe('{"want":"export"}');
  });

  test("refuses an answer signed with another secret", async () => {
    const server = exportServer((nonce) => {
      const body = JSON.stringify(demoExport(Date.now()));
      const time = String(Math.floor(Date.now() / 1000));
      return {
        body,
        signature: signExport(
          "another-secret-0123456789abcdef01234",
          time,
          nonce,
          body,
        ),
      };
    });
    await expect(
      checkinExport({ url: server.url, secret: SECRET }).load(),
    ).rejects.toThrow("not signed for us");
  });

  test("refuses an answer signed for another request's nonce (a replayed answer)", async () => {
    const server = exportServer(() => {
      const body = JSON.stringify(demoExport(Date.now()));
      const time = String(Math.floor(Date.now() / 1000));
      return {
        body,
        signature: signExport(SECRET, time, "some-earlier-nonce-0000", body),
      };
    });
    await expect(
      checkinExport({ url: server.url, secret: SECRET }).load(),
    ).rejects.toThrow("not signed for us");
  });

  test("refuses a stale answer", async () => {
    const server = exportServer(() => ({
      time: String(Math.floor(Date.now() / 1000) - 600),
    }));
    await expect(
      checkinExport({ url: server.url, secret: SECRET }).load(),
    ).rejects.toThrow("not signed for us");
  });

  test("a wrong secret is refused by the service", async () => {
    const server = exportServer(() => ({}));
    await expect(
      checkinExport({
        url: server.url,
        secret: "wrong-secret-0123456789abcdefghijk",
      }).load(),
    ).rejects.toThrow("answered 403");
  });

  test("its own clock far off is refused by the service", async () => {
    const server = exportServer(() => ({}));
    const source = checkinExport({
      url: server.url,
      secret: SECRET,
      now: () => Date.now() - 10 * 60_000,
    });
    await expect(source.load()).rejects.toThrow("answered 403");
  });
});

describe("the relay's health", () => {
  test("up when /health answers ok, down otherwise", async () => {
    let healthy = true;
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        healthy ? new Response("ok") : new Response("no", { status: 502 }),
    });
    servers.push(server);
    const health = relayHealth({
      url: `http://127.0.0.1:${server.port}/health`,
    });
    expect((await health.check()).up).toBe(true);
    healthy = false;
    expect(await health.check()).toMatchObject({
      up: false,
      detail: "HTTP 502",
    });
    server.stop(true);
    expect((await health.check()).up).toBe(false);
  });
});

describe("GitHub", () => {
  test("without a token sends nothing and is not connected", async () => {
    let calls = 0;
    const source = githubIssues({
      repo: "example/repo",
      fetch: (async () => {
        calls += 1;
        return new Response("[]");
      }) as unknown as typeof fetch,
    });
    expect(await source.list()).toBe(null);
    expect(calls).toBe(0);
  });

  test("with a token reads issues and PRs, merged PRs as merged", async () => {
    const seen: string[] = [];
    const source = githubIssues({
      repo: "example/repo",
      token: "test-token",
      fetch: (async (url: string, init: RequestInit) => {
        seen.push(
          `${url} ${(init.headers as Record<string, string>).authorization}`,
        );
        return Response.json([
          {
            number: 1,
            title: "A bug",
            state: "open",
            html_url: "https://github.example/1",
            updated_at: "2026-11-18T00:00:00Z",
            labels: [{ name: "bug" }],
          },
          {
            number: 2,
            title: "Its fix",
            state: "closed",
            html_url: "https://github.example/2",
            updated_at: "2026-11-18T00:00:00Z",
            labels: ["bug"],
            pull_request: { merged_at: "2026-11-18T00:00:00Z" },
          },
          {
            number: 3,
            title: "Not merged",
            state: "closed",
            html_url: "https://github.example/3",
            updated_at: "2026-11-18T00:00:00Z",
            labels: [],
            pull_request: { merged_at: null },
          },
        ]);
      }) as unknown as typeof fetch,
    });
    expect(
      (await source.list())?.map(
        (item) =>
          `${item.number} ${item.kind} ${item.state} ${item.labels.join()}`,
      ),
    ).toEqual(["1 issue open bug", "2 pr merged bug", "3 pr closed "]);
    expect(seen[0]).toBe(
      "https://api.github.com/repos/example/repo/issues?state=all&per_page=100&sort=updated Bearer test-token",
    );
  });
});

describe("a minute's memory", () => {
  test("keeps the last good answer and the error when a later call fails", async () => {
    let clock = 0;
    let fail = false;
    let calls = 0;
    const get = remembered(
      async () => {
        calls += 1;
        if (fail) throw new Error("down");
        return calls;
      },
      60_000,
      () => clock,
    );
    expect(await get()).toEqual({ value: 1, fetchedAt: 0 });
    expect(await get()).toEqual({ value: 1, fetchedAt: 0 });
    clock = 61_000;
    fail = true;
    expect(await get()).toEqual({ value: 1, fetchedAt: 0, error: "down" });
    expect(calls).toBe(2);
    clock = 62_000;
    await get();
    expect(calls).toBe(2);
  });
});
