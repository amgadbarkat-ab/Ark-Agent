import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import {
  appPolicy,
  checkoutPolicy,
  CSP_REPORT_PATH,
  cspReportRoutes,
  parseCspMode,
  readReports,
  type Violation,
} from "../src/csp";
import { securityHeaders } from "../src/security-headers";
import { testEnvironment } from "./support/environment";

const POLICY = appPolicy({
  selfOrigins: ["https://ark.example.com"],
  hubAddress: "wss://hub.ark.example.com",
  reportUri: CSP_REPORT_PATH,
});

describe("the policy", () => {
  test("allows only the application's own script, nothing inline and no eval", () => {
    const directive = (name: string) =>
      POLICY.split("; ")
        .find((part) => part.startsWith(`${name} `))
        ?.split(" ")
        .slice(1);
    expect(directive("script-src")).toEqual(["'self'"]);
    expect(POLICY).not.toContain("unsafe-eval");
    // Inline style is allowed (React sets style attributes); inline script is not.
    expect(directive("style-src")).toContain("'unsafe-inline'");
    expect(directive("script-src")).not.toContain("'unsafe-inline'");
  });

  test("shuts the doors that cost nothing to shut", () => {
    for (const part of [
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'self'",
      `report-uri ${CSP_REPORT_PATH}`,
    ]) {
      expect(POLICY).toContain(part);
    }
  });

  test("lets the page talk to itself and to the conversation hub, as sockets too, and to nobody else", () => {
    const connect = POLICY.split("; ")
      .find((part) => part.startsWith("connect-src "))
      ?.split(" ")
      .slice(1);
    expect(connect).toEqual([
      "'self'",
      "wss://ark.example.com",
      "wss://hub.ark.example.com",
    ]);
  });

  test("a plain-http deployment gets plain sockets", () => {
    const policy = appPolicy({
      selfOrigins: ["http://localhost:3001"],
      hubAddress: "ws://127.0.0.1:4401",
    });
    expect(policy).toContain("ws://localhost:3001");
    expect(policy).toContain("ws://127.0.0.1:4401");
    expect(policy).not.toContain("wss:");
  });

  test("an address that is not one adds nothing", () => {
    const policy = appPolicy({
      selfOrigins: ["not a url", undefined, "javascript:alert(1)"],
      hubAddress: "ftp://x.example.com",
    });
    expect(policy).toContain("connect-src 'self';");
  });

  test("the payment page's own policy is Paddle's, and not the application's", () => {
    const policy = checkoutPolicy({ reportUri: CSP_REPORT_PATH });
    expect(policy).toContain("https://cdn.paddle.com");
    expect(policy).toContain("frame-src https://*.paddle.com");
    expect(policy).toContain("form-action 'none'");
  });

  test("the mode is one of three words, and anything else stops the server starting", () => {
    expect(parseCspMode(undefined)).toBe("report-only");
    expect(parseCspMode(" Enforce ")).toBe("enforce");
    expect(parseCspMode("off")).toBe("off");
    expect(() => parseCspMode("strict")).toThrow(/CSP_MODE/);
  });
});

describe("what is sent", () => {
  const appWith = (mode: "off" | "report-only" | "enforce") => {
    const app = new Hono();
    app.use(
      "*",
      securityHeaders({ https: true, csp: { mode, policy: POLICY } }),
    );
    app.get("/", (context) => context.text("ok"));
    app.get("/own", (context) => {
      context.header("content-security-policy", "default-src 'none'");
      return context.text("ok");
    });
    app.get("/own-watched", (context) => {
      context.header(
        "content-security-policy-report-only",
        "default-src 'none'",
      );
      return context.text("ok");
    });
    return app;
  };
  const headers = async (app: Hono, path = "/") => {
    const response = await app.request(path);
    return {
      enforced: response.headers.get("content-security-policy"),
      watched: response.headers.get("content-security-policy-report-only"),
    };
  };

  test("report-only watches the whole policy and enforces only frame-ancestors", async () => {
    expect(await headers(appWith("report-only"))).toEqual({
      enforced: "frame-ancestors 'self'",
      watched: POLICY,
    });
  });

  test("enforce enforces the whole policy and sends nothing to watch", async () => {
    expect(await headers(appWith("enforce"))).toEqual({
      enforced: POLICY,
      watched: null,
    });
  });

  test("off is what it always was", async () => {
    expect(await headers(appWith("off"))).toEqual({
      enforced: "frame-ancestors 'self'",
      watched: null,
    });
  });

  test("a page that set its own policy, in either header, is left alone in every mode", async () => {
    for (const mode of ["off", "report-only", "enforce"] as const) {
      expect(await headers(appWith(mode), "/own")).toEqual({
        enforced: "default-src 'none'",
        watched: null,
      });
      const watching = await headers(appWith(mode), "/own-watched");
      expect(watching.watched).toBe("default-src 'none'");
      // Nothing is added beside it that could be enforced on that page.
      expect(watching.enforced).toBeNull();
    }
  });

  test("the whole application, started by default, watches the policy and the payment page is never enforced", async () => {
    const app = createApp(loadConfig(testEnvironment()));
    const home = await app.request("http://openbot.local/health");
    expect(home.headers.get("content-security-policy")).toBe(
      "frame-ancestors 'self'",
    );
    expect(home.headers.get("content-security-policy-report-only")).toContain(
      "script-src 'self'",
    );
  });

  test("enforcing it is refused while generated interfaces are on, because they would silently stop drawing", () => {
    expect(() => loadConfig(testEnvironment({ CSP_MODE: "enforce" }))).toThrow(
      /OPENBOT_GENERATIVE_UI=false/,
    );
    // Watching is fine with them on, and so is not asking.
    expect(() =>
      loadConfig(testEnvironment({ CSP_MODE: "report-only" })),
    ).not.toThrow();
    expect(() =>
      loadConfig(testEnvironment({ CSP_MODE: "off" })),
    ).not.toThrow();
  });

  test("a deployment can enforce it, with generated interfaces off", async () => {
    const app = createApp(
      loadConfig(
        testEnvironment({
          CSP_MODE: "enforce",
          OPENBOT_GENERATIVE_UI: "false",
        }),
      ),
    );
    const home = await app.request("http://openbot.local/health");
    expect(home.headers.get("content-security-policy")).toContain(
      "script-src 'self'",
    );
    expect(home.headers.get("content-security-policy-report-only")).toBeNull();
  });
});

describe("reading what a browser says it blocked", () => {
  test("understands the older report shape and the reporting API's", () => {
    const older = readReports({
      "csp-report": {
        "document-uri": "https://ark.example.com/settings/plan?token=SECRET#x",
        "violated-directive": "script-src-elem",
        "effective-directive": "script-src-elem",
        "blocked-uri": "https://evil.example/x.js?cookie=SECRET",
        disposition: "report",
        "source-file": "https://ark.example.com/assets/index-abc.js",
      },
    });
    expect(older).toEqual([
      {
        type: "csp-violation",
        directive: "script-src-elem",
        blocked: "https://evil.example/x.js",
        page: "https://ark.example.com/settings/plan",
        source: "https://ark.example.com/assets/index-abc.js",
        disposition: "report",
      },
    ]);
    const newer = readReports([
      {
        type: "csp-violation",
        body: {
          documentURL: "https://ark.example.com/",
          effectiveDirective: "img-src",
          blockedURL: "data",
          disposition: "enforce",
        },
      },
      { type: "network-error", body: {} },
    ]);
    expect(newer).toHaveLength(1);
    expect(newer[0]).toMatchObject({ directive: "img-src", blocked: "data" });
  });

  test("keeps no query, fragment or oversized text, and nothing it was not asked to keep", () => {
    const [violation] = readReports({
      "csp-report": {
        "document-uri": `https://ark.example.com/${"a".repeat(1000)}?secret=1`,
        "blocked-uri": "inline",
        "effective-directive": "script-src",
        "original-policy": "default-src 'self'; SECRET",
        referrer: "https://ark.example.com/private?token=1",
        "script-sample": "alert('SECRET')",
      },
    });
    expect(violation?.page.length).toBeLessThanOrEqual(200);
    expect(JSON.stringify(violation)).not.toContain("SECRET");
    expect(JSON.stringify(violation)).not.toContain("token");
    expect(violation?.blocked).toBe("inline");
  });

  test("anything that is not a report is nothing", () => {
    for (const junk of [null, 1, "x", [], {}, [1, null], { "csp-report": 5 }]) {
      expect(readReports(junk)).toEqual([]);
    }
  });
});

describe("the door the browser posts to", () => {
  const door = (perMinute = 60) => {
    const logged: Violation[] = [];
    const app = new Hono().route(
      "/r",
      cspReportRoutes({ log: (v) => logged.push(v), perMinute }),
    );
    const post = (
      body: string,
      headers: Record<string, string> = {
        "content-type": "application/csp-report",
      },
    ) => app.request("/r", { method: "POST", headers, body });
    return { logged, post };
  };
  const report = (blocked = "https://evil.example/x.js", page = "/") =>
    JSON.stringify({
      "csp-report": {
        "effective-directive": "script-src",
        "blocked-uri": blocked,
        "document-uri": `https://ark.example.com${page}`,
      },
    });

  test("takes a report, writes one clean line, and says nothing back", async () => {
    const { logged, post } = door();
    const response = await post(report());
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(logged).toHaveLength(1);
  });

  test("the same violation over and over is one line", async () => {
    const { logged, post } = door();
    for (let i = 0; i < 20; i++) await post(report());
    await post(report("https://other.example/y.js"));
    expect(logged).toHaveLength(2);
  });

  test("refuses what is too big, the wrong kind, or not JSON, and logs none of it", async () => {
    const { logged, post } = door();
    expect((await post("x".repeat(20_000))).status).toBe(413);
    expect(
      (
        await post(report(), {
          "content-type": "application/csp-report",
          "content-length": "999999",
        })
      ).status,
    ).toBe(413);
    expect((await post(report(), { "content-type": "text/html" })).status).toBe(
      415,
    );
    expect((await post("{not json")).status).toBe(400);
    expect(logged).toEqual([]);
  });

  test("an address that sends too many is told to stop, and another is not", async () => {
    const { post } = door(3);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push(
        (
          await post(report(`https://e${i}.example/x.js`), {
            "content-type": "application/csp-report",
            "x-forwarded-for": "198.51.100.7",
          })
        ).status,
      );
    }
    expect(statuses).toEqual([204, 204, 204, 429, 429, 429]);
    expect(
      (
        await post(report("https://fresh.example/x.js"), {
          "content-type": "application/csp-report",
          "x-forwarded-for": "203.0.113.9",
        })
      ).status,
    ).toBe(204);
  });

  test("a client that writes its own forwarded address cannot dodge the limit", async () => {
    const { post } = door(2);
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push(
        (
          await post(report(`https://e${i}.example/x.js`), {
            "content-type": "application/csp-report",
            // The first entries are whatever the client wrote; the last is the ingress's own.
            "x-forwarded-for": `10.0.0.${i}, 198.51.100.7`,
          })
        ).status,
      );
    }
    expect(statuses).toEqual([204, 204, 429, 429]);
  });
});
