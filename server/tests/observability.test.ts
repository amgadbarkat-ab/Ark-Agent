import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { Registry } from "../../shared/metrics";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { runSlots, subscriptions, tenants } from "../src/db/schema";
import { loadConfig } from "../src/config";
import {
  describeError,
  parseRequestLogMode,
  registerBusinessMetrics,
  requestObservability,
  serveMetrics,
  serverMetrics,
  SLOW_REQUEST_MS,
  unhandledError,
} from "../src/observability";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

/**
 * What the server says about itself, and above all what it does not say.
 *
 * A line per failed or slow request, numbers per route pattern, an id to quote, and a few counts of
 * the business. None of it may carry a person's data: not the path with an id in it, not the query,
 * not an error message that quotes a value.
 */

function appWith(
  mode: "errors" | "all" | "off",
  options: { now?: () => number } = {},
) {
  const lines: string[] = [];
  const errors: string[] = [];
  const app = new Hono<{ Variables: AppVariables }>();
  app.use(
    "*",
    requestObservability({
      mode,
      log: (line) => lines.push(line),
      ...(options.now ? { now: options.now } : {}),
    }),
  );
  app.onError(unhandledError((line) => errors.push(line)));
  app.get("/health", (context) => context.json({ status: "ok" }));
  app.get("/api/things/:id", (context) => context.json({ ok: true }));
  app.get("/api/boom/:id", () => {
    throw Object.assign(
      new Error(
        "duplicate key value violates unique constraint (email)=(ann@example.test)",
      ),
      { code: "23505" },
    );
  });
  app.get("/api/refused", () => {
    throw new HTTPException(401, { message: "no" });
  });
  return { app, lines, errors };
}

const parse = (line: string | undefined) =>
  JSON.parse(line ?? "{}") as Record<string, unknown>;

describe("the request id", () => {
  test("is sent on every answer, and is different each time", async () => {
    const { app } = appWith("off");
    const first = await app.request("/api/things/1");
    const second = await app.request("/api/things/1");

    const a = first.headers.get("x-request-id");
    const b = second.headers.get("x-request-id");
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });
});

describe("the log line", () => {
  test("by default only a request that failed gets one, with the route pattern and no data", async () => {
    const { app, lines } = appWith("errors");

    await app.request("/api/things/secret-id-7?token=SECRET");
    expect(lines).toEqual([]);

    const failed = await app.request("/api/boom/secret-id-8?token=SECRET", {
      headers: { authorization: "Bearer SECRET", cookie: "session=SECRET" },
    });

    expect(failed.status).toBe(500);
    expect(lines).toHaveLength(1);
    const line = parse(lines[0]);
    expect(line).toMatchObject({
      type: "request",
      method: "GET",
      route: "/api/boom/:id",
      status: 500,
      cause: "Error",
    });
    expect(line.id).toBe(failed.headers.get("x-request-id"));
    expect(typeof line.ms).toBe("number");
    // Nothing a person supplied: not the id in the path, the query, a header, or a cookie.
    expect(lines[0]).not.toContain("secret-id");
    expect(lines[0]).not.toContain("SECRET");
  });

  test("a slow request is logged though nothing went wrong", async () => {
    let clock = 0;
    const { app, lines } = appWith("errors", { now: () => clock });
    app.get("/api/slow", async (context) => {
      clock += SLOW_REQUEST_MS + 1;
      return context.json({});
    });

    await app.request("/api/slow");

    expect(parse(lines[0])).toMatchObject({ route: "/api/slow", slow: true });
  });

  test("all logs every request but not the health check, and off logs none", async () => {
    const all = appWith("all");
    await all.app.request("/api/things/1");
    await all.app.request("/health");
    expect(all.lines.map((line) => parse(line).route)).toEqual([
      "/api/things/:id",
    ]);

    const off = appWith("off");
    await off.app.request("/api/boom/1");
    expect(off.lines).toEqual([]);
  });

  test("the mode is one of three words and anything else stops the server starting", () => {
    expect(parseRequestLogMode(undefined)).toBe("errors");
    expect(parseRequestLogMode(" ALL ")).toBe("all");
    expect(parseRequestLogMode("off")).toBe("off");
    expect(() => parseRequestLogMode("verbose")).toThrow(/REQUEST_LOG/);
  });
});

describe("what a person is told when something throws", () => {
  test("that it happened and the id to quote, and not why", async () => {
    const { app } = appWith("off");

    const response = await app.request("/api/boom/secret-id-9");

    expect(response.status).toBe(500);
    const body = (await response.json()) as {
      error: string;
      requestId: string;
    };
    expect(body.requestId).toBe(response.headers.get("x-request-id"));
    expect(body.error).toBe("Something went wrong on our side.");
    expect(JSON.stringify(body)).not.toContain("duplicate");
  });

  test("the log has the error's name, code and place, and not its message", async () => {
    const { app, errors } = appWith("off");

    await app.request("/api/boom/secret-id-9");

    expect(errors).toHaveLength(1);
    const line = parse(errors[0]);
    expect(line).toMatchObject({
      type: "request-failed",
      route: "/api/boom/:id",
      error: "Error",
      code: "23505",
    });
    // The message quoted the value that clashed: an email.
    expect(errors[0]).not.toContain("ann@example.test");
    expect(errors[0]).not.toContain("duplicate key");
    expect(errors[0]).not.toContain("secret-id");
  });

  test("a refusal thrown on purpose keeps its own answer", async () => {
    const { app, errors } = appWith("off");

    const response = await app.request("/api/refused");

    expect(response.status).toBe(401);
    expect(errors).toEqual([]);
  });

  test("describeError names where to look without the data", () => {
    const error = Object.assign(
      new TypeError("cannot read x of ann@example.test"),
      {
        code: "ERR_X",
      },
    );
    const described = describeError(error);
    expect(described.error).toBe("TypeError");
    expect(described.code).toBe("ERR_X");
    expect(JSON.stringify(described)).not.toContain("ann@example.test");
    expect(describeError("a string")).toEqual({ error: "string" });
  });
});

describe("the numbers per request", () => {
  test("count by route pattern, never by path, and time it", async () => {
    const { app } = appWith("off");
    await app.request("/api/things/user-aaa");
    await app.request("/api/things/user-bbb");
    await app.request("/api/nothing-here/user-ccc");
    await app.request("/some/page/user-ddd");

    const text = await serverMetrics.render();

    expect(text).toMatch(
      /ark_http_requests_total\{method="GET",route="\/api\/things\/:id",status="200"\} [2-9]/,
    );
    expect(text).toContain('route="unmatched",status="404"');
    expect(text).toContain('route="static",status="404"');
    expect(text).toContain("ark_http_request_duration_seconds_bucket");
    expect(text).toContain("ark_http_requests_in_flight 0");
    expect(text).not.toContain("user-aaa");
    expect(text).not.toContain("user-ccc");
  });

  test("the whole application records them and sends the id", async () => {
    const { createApp } = await import("../src/app");
    const app = createApp(loadConfig(testEnvironment()));

    const response = await app.request("http://openbot.local/health");

    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(await serverMetrics.render()).toContain(
      'ark_http_requests_total{method="GET",route="/health",status="200"}',
    );
  });
});

describe("the settings", () => {
  test("the metrics port is optional, a real port, and not the API's", () => {
    expect(loadConfig(testEnvironment()).metricsPort).toBeUndefined();
    expect(
      loadConfig(testEnvironment({ METRICS_PORT: "9464" })).metricsPort,
    ).toBe(9464);
    for (const bad of ["0", "70000", "x", "3.5"]) {
      expect(() => loadConfig(testEnvironment({ METRICS_PORT: bad }))).toThrow(
        /METRICS_PORT/,
      );
    }
    expect(() =>
      loadConfig(testEnvironment({ PORT: "3001", METRICS_PORT: "3001" })),
    ).toThrow(/must not be the port the API/);
    expect(loadConfig(testEnvironment()).requestLog).toBe("errors");
    expect(loadConfig(testEnvironment({ REQUEST_LOG: "all" })).requestLog).toBe(
      "all",
    );
  });
});

describe("counts of the business", () => {
  const database = createDatabase(testDatabaseUrl(), TEST_POOL);
  const made: string[] = [];
  afterAll(async () => {
    for (const id of made) {
      await database.delete(tenants).where(eq(tenants.id, id));
    }
  });

  const scrape = async (registry: Registry) => registry.render();
  const gauge = (text: string, name: string, labels = "") =>
    Number(
      text.match(new RegExp(`^${name}${labels} (\\d+)$`, "m"))?.[1] ??
        Number.NaN,
    );

  test("say how many accounts are in each state and how many runs are going, and are not re-read every scrape", async () => {
    const registry = new Registry();
    let clock = 1_000_000;
    registerBusinessMetrics(registry, database, {
      cacheMs: 10_000,
      now: () => clock,
    });
    const before = await scrape(registry);
    const pastDue =
      gauge(before, "ark_accounts", '\\{status="past_due"\\}') || 0;
    const running = gauge(before, "ark_runs_in_progress");

    const [tenant] = await database
      .insert(tenants)
      .values({ name: `metrics-${randomUUID()}` })
      .returning({ id: tenants.id });
    const tenantId = tenant?.id as string;
    made.push(tenantId);
    await database.insert(subscriptions).values({
      tenantId,
      planId: "agent",
      status: "past_due",
      provider: "manual",
    });
    await database.insert(runSlots).values({
      tenantId,
      botId: "bot",
      runId: `run-${randomUUID()}`,
      userId: "nobody",
      expiresAt: new Date(Date.now() + 60_000),
    });

    // Inside the cache window: the same answer, without asking the database again.
    expect(gauge(await scrape(registry), "ark_runs_in_progress")).toBe(running);

    clock += 10_001;
    const after = await scrape(registry);
    expect(gauge(after, "ark_runs_in_progress")).toBe(running + 1);
    expect(gauge(after, "ark_accounts", '\\{status="past_due"\\}')).toBe(
      pastDue + 1,
    );
  });

  test("a database that cannot be read leaves the page up and counts the failure", async () => {
    const registry = new Registry();
    registerBusinessMetrics(
      registry,
      {
        select: () => {
          throw new Error("connection refused");
        },
      } as never,
      { cacheMs: 0 },
    );

    const text = await scrape(registry);

    expect(text).toContain("ark_metrics_collector_failures_total 1");
    expect(text).not.toContain("connection refused");
  });
});

describe("where the numbers are served", () => {
  test("on a port of their own, as text, and nothing else is served there", async () => {
    const registry = new Registry();
    registry.counter("ark_probe_total", "p").inc();
    const server = serveMetrics(registry, 0);
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const metrics = await fetch(`${base}/metrics`);
      expect(metrics.status).toBe(200);
      expect(metrics.headers.get("content-type")).toContain("text/plain");
      expect(await metrics.text()).toContain("ark_probe_total 1");

      expect((await fetch(`${base}/`)).status).toBe(404);
      expect((await fetch(`${base}/api/me`)).status).toBe(404);
      expect((await fetch(`${base}/metrics`, { method: "POST" })).status).toBe(
        404,
      );
    } finally {
      await server.stop(true);
    }
  });

  test("and not on the port the API is served on, where customers can reach it", async () => {
    const { createApp } = await import("../src/app");
    const app = createApp(loadConfig(testEnvironment()));

    const response = await app.request("http://openbot.local/metrics");

    expect(await response.text()).not.toContain("ark_http_requests_total");
  });
});
