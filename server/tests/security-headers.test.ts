import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { securityHeaders } from "../src/security-headers";
import { testEnvironment } from "./support/environment";

describe("security headers", () => {
  test("every response says it is not to be framed by another site, sniffed, or leaked through the referrer", async () => {
    const app = createApp(loadConfig(testEnvironment()));
    const response = await app.request("http://openbot.local/health");

    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(response.headers.get("content-security-policy")).toBe(
      "frame-ancestors 'self'",
    );
    expect(response.headers.get("permissions-policy")).toContain(
      "microphone=(self)",
    );
  });

  test("an answer to a request nobody may make carries them too", async () => {
    const app = createApp(loadConfig(testEnvironment()));
    const response = await app.request("http://openbot.local/api/nothing-here");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("HSTS only where the site is reached over HTTPS", async () => {
    const plain = new Hono();
    plain.use("*", securityHeaders({ https: false }));
    plain.get("/", (context) => context.text("ok"));
    const secure = new Hono();
    secure.use("*", securityHeaders({ https: true }));
    secure.get("/", (context) => context.text("ok"));

    expect(
      (await plain.request("/")).headers.get("strict-transport-security"),
    ).toBeNull();
    expect(
      (await secure.request("/")).headers.get("strict-transport-security"),
    ).toBe("max-age=31536000; includeSubDomains");
  });

  test("a policy the page set for itself is kept", async () => {
    const app = new Hono();
    app.use("*", securityHeaders({ https: true }));
    app.get("/", (context) => {
      context.header("content-security-policy", "default-src 'none'");
      return context.text("ok");
    });
    expect(
      (await app.request("/")).headers.get("content-security-policy"),
    ).toBe("default-src 'none'");
  });

  test("a response proxied from another server, whose headers cannot be changed, still gets them", async () => {
    const app = new Hono();
    app.use("*", securityHeaders({ https: false }));
    app.get("/", () => {
      const upstream = new Response("from upstream");
      // The shape fetch() hands back: headers that throw when written.
      Object.defineProperty(upstream.headers, "set", {
        value: () => {
          throw new TypeError("immutable");
        },
      });
      return upstream;
    });
    const response = await app.request("/");
    expect(await response.text()).toBe("from upstream");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
