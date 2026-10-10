import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { originGuard } from "../src/origin-guard";

/**
 * A browser request that changes something must come from this site or one named as trusted.
 * This is the second wall behind `SameSite=Lax`; see src/origin-guard.ts for what it is for.
 */

function app(trusted: string[] = []) {
  const server = new Hono();
  server.use("/api/*", originGuard({ trusted }));
  server.all("/api/*", (context) => context.json({ ok: true }));
  server.all("/internal/*", (context) => context.json({ ok: true }));
  return server;
}

const HOST = "ark.example.com";
const post = (
  headers: Record<string, string>,
  path = "/api/agents",
  method = "POST",
) =>
  app(["https://app.example.net"]).request(`http://${HOST}${path}`, {
    method,
    headers: { host: HOST, ...headers },
  });

describe("origin guard", () => {
  test("a write from another website is refused, whatever the cookie says", async () => {
    const response = await post({
      origin: "https://evil.example",
      "sec-fetch-site": "cross-site",
    });
    expect(response.status).toBe(403);
    expect((await response.json()).error).toMatch(/another website/);
  });

  test("a write that says only that it is cross-site, with no Origin, is refused", async () => {
    expect((await post({ "sec-fetch-site": "cross-site" })).status).toBe(403);
  });

  test("a write from a sibling subdomain, which SameSite does not stop, is refused", async () => {
    expect(
      (
        await post({
          origin: "https://hub.example.com",
          "sec-fetch-site": "same-site",
        })
      ).status,
    ).toBe(403);
  });

  test("a sandboxed frame, whose origin is the string null, is refused", async () => {
    expect((await post({ origin: "null" })).status).toBe(403);
  });

  test("the site's own pages may write, over either scheme a proxy hides", async () => {
    for (const origin of [`https://${HOST}`, `http://${HOST}`]) {
      expect(
        (await post({ origin, "sec-fetch-site": "same-origin" })).status,
      ).toBe(200);
    }
  });

  test("an origin named as trusted may write, with or without a trailing slash", async () => {
    for (const origin of [
      "https://app.example.net",
      "https://APP.example.net/",
    ]) {
      expect(
        (await post({ origin, "sec-fetch-site": "cross-site" })).status,
      ).toBe(200);
    }
  });

  test("a client that is not a browser, and so sends neither header, is let through to be authenticated", async () => {
    expect((await post({})).status).toBe(200);
  });

  test("a same-origin request that omits Origin is let through", async () => {
    expect((await post({ "sec-fetch-site": "same-origin" })).status).toBe(200);
  });

  test("reading is never refused: a link from another site may open a page", async () => {
    expect(
      (
        await post(
          { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
          "/api/agents",
          "GET",
        )
      ).status,
    ).toBe(200);
  });

  test("a WebSocket handshake from another site is refused although it is a GET", async () => {
    expect(
      (
        await post(
          {
            upgrade: "websocket",
            origin: "https://evil.example",
            "sec-fetch-site": "cross-site",
          },
          "/api/channels/events",
          "GET",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await post(
          { upgrade: "websocket", origin: `https://${HOST}` },
          "/api/channels/events",
          "GET",
        )
      ).status,
    ).toBe(200);
  });

  test("routes something else authenticates are not asked about the browser", async () => {
    for (const path of [
      "/api/auth/sign-out",
      "/api/billing/webhook/paddle",
      "/api/model-gateway/anthropic/v1/messages",
      "/api/agent-tools/call",
      "/api/host-access/desktop/result",
    ]) {
      expect(
        (await post({ origin: "https://evil.example" }, path)).status,
      ).toBe(200);
    }
    // Outside /api there is nothing to guard here.
    expect(
      (await post({ origin: "https://evil.example" }, "/internal/routines/run"))
        .status,
    ).toBe(200);
  });
});
