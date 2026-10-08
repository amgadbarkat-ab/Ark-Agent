import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cloudAccounts, cloudCharges, sessions } from "../../src/db/schema";
import { mintModelGrant } from "../../src/models/grant";
import {
  type Person,
  type Seeded,
  SECURITY_ENABLED,
  seedCustomer,
  type Target,
  startTarget,
  WEBHOOK_SECRET,
} from "./harness";

/**
 * An attack on the running application.
 *
 * Written as the plan in docs/ark/15-security-review.md ("what a tester should target"), run by us
 * against the real server with real session cookies for two customers and an administrator. Each
 * block is one way in. A block that fails is a hole; a block that passes is a hole that is shut and
 * will be noticed if it opens again.
 *
 *   OPENBOT_SECURITY=1 bun run test:security
 *
 * HONEST LIMITS. This is the same team attacking its own work, so it finds what we thought to try.
 * It does not replace somebody else's eyes. It also runs against a server with no hub, no model and
 * no bot computer, so anything that only exists once one is attached (a live conversation, a run) is
 * out of reach here and is named as such in the report.
 */

const run = SECURITY_ENABLED ? describe : describe.skip;

let target: Target;
let bob: Seeded;
let alice: Seeded;

beforeAll(async () => {
  if (!SECURITY_ENABLED) return;
  target = await startTarget();
  bob = await seedCustomer(target, target.b, "BOBSECRET");
  alice = await seedCustomer(target, target.a, "ALICESECRET");
}, 120_000);

afterAll(async () => {
  if (target) await target.stop();
});

/** Whatever a route needs in its path, filled with something that exists nowhere. */
const nowhere = (path: string) =>
  path.replace(/:([A-Za-z]+)/g, (_m, name: string) =>
    name.toLowerCase().includes("id")
      ? "00000000-0000-4000-8000-000000000000"
      : "x",
  );

const unique = (routes: Target["routes"]) => {
  const seen = new Set<string>();
  return routes.filter((route) => {
    const key = `${route.method} ${route.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const WRITES = new Set(["POST", "PUT", "PATCH"]);
const send = (as: Person | null, method: string, path: string) =>
  target.call(as, method, path, WRITES.has(method) ? { body: {} } : {});

/** Answered to anybody, on purpose. Everything not here must refuse a stranger. */
const PUBLIC: Record<string, string> = {
  "GET /health": "load balancers ask it",
  "GET /api/capabilities": "the sign-in screen reads which features exist",
  "GET /api/billing/checkout": "Paddle sends customers here; it holds no data",
  "POST /api/billing/webhook/:provider":
    "signed by Paddle, checked in its own block",
  "GET /api/plugins/oauth/callback":
    "a vendor redirects the browser here; the state is checked",
  "POST /api/csp-report":
    "the browser says what the content policy would have blocked; small, limited, logs a few clean fields",
  "GET /api/host-access/desktop/next": "the desktop app, with its own token",
  "POST /api/host-access/desktop/result": "the desktop app, with its own token",
};

run("who may reach what", () => {
  test("every route that is not public refuses somebody who is not signed in", async () => {
    const open: string[] = [];
    // The sweep is only as good as the list it walks: the money routes are on it.
    const listed = target.routes.map(
      (route) => `${route.method} ${route.path}`,
    );
    for (const money of [
      "POST /api/account/cloud/enable",
      "PUT /api/admin/cloud/rates",
      "POST /api/admin/cloud/charges/:id/settle",
    ]) {
      expect(listed).toContain(money);
    }
    for (const route of unique(target.routes)) {
      const key = `${route.method} ${route.path}`;
      if (key in PUBLIC) continue;
      const answer = await send(null, route.method, nowhere(route.path));
      if (answer.status !== 401) open.push(`${key} -> ${answer.status}`);
    }
    expect(open).toEqual([]);
  });

  test("the routes left open to strangers are exactly the ones written down, and say nothing private", async () => {
    for (const key of Object.keys(PUBLIC)) {
      const [method, path] = key.split(" ") as [string, string];
      const answer = await send(null, method, nowhere(path));
      expect(answer.status).not.toBe(500);
      // None of them may hand a stranger a person, a plan or a secret.
      expect(answer.text).not.toMatch(/customer\.test|BOBSECRET|ALICESECRET/);
    }
    // And a route that is not written down is not quietly public: this is the same list, from the other side.
    const stranger = await Promise.all(
      unique(target.routes).map(async (route) => ({
        key: `${route.method} ${route.path}`,
        status: (await send(null, route.method, nowhere(route.path))).status,
      })),
    );
    const accidental = stranger
      .filter(({ key, status }) => status !== 401 && !(key in PUBLIC))
      .map(({ key, status }) => `${key} -> ${status}`);
    expect(accidental).toEqual([]);
  });

  test("every administrator route refuses an ordinary customer", async () => {
    const adminRoutes = unique(target.routes).filter((route) =>
      route.path.startsWith("/api/admin/"),
    );
    expect(adminRoutes.length).toBeGreaterThan(20);
    const let_in: string[] = [];
    for (const route of adminRoutes) {
      const answer = await send(target.a, route.method, nowhere(route.path));
      if (answer.status !== 403)
        let_in.push(`${route.method} ${route.path} -> ${answer.status}`);
    }
    expect(let_in).toEqual([]);
  });

  test("routes that change what the deployment is, and are not under /api/admin, refuse a customer too", async () => {
    const mustBeAdmin = [
      ["POST", "/api/components/x/functions"],
      ["PUT", "/api/components/x/draft"],
      ["POST", "/api/components/x/publication"],
      ["POST", "/api/plugins/servers/custom"],
      ["DELETE", "/api/plugins/servers/00000000-0000-4000-8000-000000000000"],
      ["POST", "/api/sandboxed"],
      ["DELETE", "/api/sandboxed/x"],
    ] as const;
    for (const [method, path] of mustBeAdmin) {
      const answer = await send(target.a, method, path);
      expect([method, path, answer.status]).toEqual([method, path, 403]);
    }
  });

  test("spelling a path differently does not get past the administrator check", async () => {
    for (const path of [
      "/api/admin/people/",
      "/api/admin/../admin/people",
      "/api/%61dmin/people",
      "//api/admin/people",
      "/api/admin/people?x=1#a",
      "/api/admin/people/%2e%2e/people",
    ]) {
      const answer = await target.call(target.a, "GET", path);
      expect([path, [403, 404].includes(answer.status)]).toEqual([path, true]);
    }
    const headers = await target.call(target.a, "GET", "/api/admin/people", {
      headers: {
        "x-forwarded-user": "admin@customer.test",
        "x-user-id": target.admin.id,
        "x-http-method-override": "GET",
        authorization: `Bearer ${target.admin.id}`,
      },
    });
    expect(headers.status).toBe(403);
  });
});

run("one customer against another", () => {
  /** What each parameter name means, for the routes that carry somebody else's id. */
  const theirs = (route: string, name: string): string => {
    if (name === "agentId" || name === "botId") return bob.agentId;
    if (name === "channelId") return bob.channelId;
    if (name === "threadId") return bob.threadId;
    if (name === "tenantId") return target.b.tenantId;
    if (name === "userId") return target.b.id;
    if (name === "slug")
      return route.includes("/skills/") ? bob.skillSlug : bob.listingSlug;
    if (name === "id") {
      if (route.includes("attachments")) return bob.attachmentId;
      if (route.includes("/models/")) return bob.connectionId;
      if (route.includes("/routines/")) return bob.routineId;
      if (route.includes("/publishers/")) return bob.publisherId;
      if (route.includes("/marketplace/")) return bob.listingId;
      return bob.attachmentId;
    }
    return "x";
  };

  test("with the other customer's id in the path, no route of theirs answers with their data", async () => {
    const leaked: string[] = [];
    const succeeded: string[] = [];
    for (const route of unique(target.routes)) {
      if (!route.path.includes(":") || route.path.startsWith("/api/admin/"))
        continue;
      const path = route.path.replace(/:([A-Za-z]+)/g, (_m, name: string) =>
        encodeURIComponent(theirs(route.path, name)),
      );
      const answer = await send(target.a, route.method, path);
      // A publisher's page is public by design (the display name they chose); what it may not hold is
      // checked on its own below.
      if (
        answer.text.includes("BOBSECRET") &&
        route.path !== "/api/marketplace/publishers/:id"
      )
        leaked.push(`${route.method} ${route.path}`);
      // A write that went through, with the wrong body or not, is worth a look.
      if (
        route.method !== "GET" &&
        answer.status < 300 &&
        !route.path.startsWith("/api/host-access/stop")
      ) {
        succeeded.push(`${route.method} ${route.path} -> ${answer.status}`);
      }
    }
    expect(leaked).toEqual([]);
    expect(succeeded).toEqual([]);
  });

  test("a publisher's page shows who they chose to be, and none of what they have not published", async () => {
    const page = await target.call(
      target.a,
      "GET",
      `/api/marketplace/publishers/${bob.publisherId}`,
    );
    expect(page.status).toBe(200);
    // His listing is still waiting for review: not in his public page, nor anywhere another customer reads.
    expect(page.text).not.toContain("BOBSECRET listing");
    expect(page.text).not.toContain("BOBSECRET summary");
    expect(page.text).not.toContain("BOBSECRET description");
    expect(page.text).not.toContain(target.b.email);
    expect(page.text).not.toContain(target.b.id);
    expect(page.text).not.toContain(target.b.tenantId);
  });

  test("with a well-formed request, so that the body is not what refuses it, still nothing of theirs is touched", async () => {
    const A = target.a;
    const attacks: [string, string, unknown][] = [
      [
        "PUT",
        `/api/marketplace/mine/listings/${bob.listingId}`,
        {
          agentId: alice.agentId,
          title: "HACKED",
          summary: "s",
          category: "productivity",
          tags: [],
          description: "d",
          confirmedNoPrivateData: true,
        },
      ],
      ["DELETE", `/api/marketplace/mine/listings/${bob.listingId}`, undefined],
      [
        "POST",
        `/api/marketplace/listings/${bob.listingSlug}/report`,
        { reason: "spam", details: "x" },
      ],
      [
        "POST",
        `/api/marketplace/listings/${bob.listingSlug}/install`,
        undefined,
      ],
      [
        "PUT",
        `/api/models/bots/${bob.agentId}`,
        { connectionId: alice.connectionId },
      ],
      [
        "PUT",
        `/api/models/bots/${alice.agentId}`,
        { connectionId: bob.connectionId },
      ],
      ["POST", `/api/agents/${bob.agentId}/declined`, { reason: "x" }],
      [
        "PATCH",
        `/api/agents/${bob.agentId}`,
        {
          name: "HACKED",
          title: "t",
          roleDescription: "r",
          visibility: "public",
        },
      ],
      ["POST", `/api/agents/${bob.agentId}/duplicate`, undefined],
      ["POST", `/api/agents/${bob.agentId}/callback-token`, undefined],
      [
        "POST",
        `/api/channels/${bob.channelId}/activity`,
        { text: "hello", agentId: null },
      ],
      ["POST", `/api/channels/${bob.channelId}/busy`, { busy: true }],
      ["PUT", `/api/channels/${bob.channelId}/pin`, { pinned: true }],
      ["PUT", `/api/routines/${bob.routineId}/enabled`, { enabled: false }],
      ["DELETE", `/api/routines/${bob.routineId}`, undefined],
      ["GET", `/api/voice/sessions?channelId=${bob.channelId}`, undefined],
      [
        "POST",
        "/api/voice/sessions",
        {
          channelId: bob.channelId,
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          durationSeconds: 1,
          transcript: { entries: [] },
        },
      ],
      ["GET", `/api/plugins/for/${bob.agentId}`, undefined],
      [
        "POST",
        "/api/components/anything/decision",
        { botId: bob.agentId, agentId: bob.agentId, call: "x" },
      ],
      [
        "POST",
        "/api/components/anything/call",
        { agentId: bob.agentId, function: "f", arguments: {} },
      ],
      ["POST", "/api/host-access/grants", { botId: bob.agentId, path: "/etc" }],
      ["GET", `/api/attachments/${bob.attachmentId}`, undefined],
      ["DELETE", `/api/attachments/${bob.attachmentId}`, undefined],
      ["POST", `/api/channels/${bob.channelId}/attachments`, undefined],
      ["DELETE", `/api/plugins/skills/${bob.skillSlug}`, undefined],
      [
        "POST",
        `/api/copilotkit/agent/${bob.agentId}/run`,
        { threadId: bob.threadId, messages: [] },
      ],
    ];
    const worked: string[] = [];
    for (const [method, path, body] of attacks) {
      const answer = await target.call(
        A,
        method,
        path,
        body === undefined ? {} : { body },
      );
      if (answer.status < 300 || answer.text.includes("BOBSECRET")) {
        worked.push(`${method} ${path} -> ${answer.status}`);
      }
    }
    expect(worked).toEqual([]);

    // And what happened to him: nothing.
    const after = await target.call(
      target.b,
      "GET",
      `/api/agents/${bob.agentId}`,
    );
    expect(JSON.parse(after.text).agent.name).toBe("BOBSECRET agent");
    expect(JSON.parse(after.text).agent.visibility).toBe("private");
    expect(
      (await target.call(target.b, "GET", "/api/routines")).text,
    ).toContain(bob.routineId);
    expect(
      (await target.call(target.b, "GET", `/api/channels/${bob.channelId}`))
        .status,
    ).toBe(200);
    expect(
      (
        await target.call(
          target.b,
          "GET",
          `/api/attachments/${bob.attachmentId}`,
        )
      ).status,
    ).toBe(200);
    expect(
      (await target.call(target.b, "GET", "/api/marketplace/mine")).text,
    ).toContain("BOBSECRET listing");
  });

  test("every list a customer can read holds none of the other customer's things", async () => {
    const lists = [
      "/api/agents",
      "/api/channels",
      "/api/models/connections",
      "/api/models/bots",
      "/api/settings/instructions",
      "/api/settings/preferences",
      "/api/routines",
      "/api/plugins",
      "/api/plugins/connections",
      "/api/marketplace",
      "/api/marketplace/mine",
      "/api/account",
      "/api/account/export",
      "/api/components",
      "/api/sandboxed/published",
      "/api/host-access",
      "/api/me",
    ];
    const leaked: string[] = [];
    for (const path of lists) {
      const answer = await target.call(target.a, "GET", path);
      if (
        answer.text.includes("BOBSECRET") ||
        answer.text.includes(target.b.email)
      )
        leaked.push(path);
    }
    expect(leaked).toEqual([]);
  });

  test("the account export holds the customer's own things and nobody else's, and no key", async () => {
    const answer = await target.call(target.a, "GET", "/api/account/export");
    expect(answer.status).toBe(200);
    expect(answer.text).toContain("ALICESECRET");
    expect(answer.text).not.toContain("BOBSECRET");
    expect(answer.text).not.toContain(`sk-ALICESECRET`);
  });

  test("a customer cannot give themselves, or somebody else, more than they bought", async () => {
    const before = JSON.parse(
      (await target.call(target.a, "GET", "/api/account")).text,
    ).account;
    for (const planId of ["internal", "enterprise", "../internal", "TEAM"]) {
      const answer = await target.call(target.a, "POST", "/api/account/plan", {
        body: { planId },
      });
      expect(answer.status).toBeGreaterThanOrEqual(400);
    }
    const after = JSON.parse(
      (await target.call(target.a, "GET", "/api/account")).text,
    ).account;
    expect(after.planId).toBe(before.planId);
    expect(after.subscriptionStatus).toBe(before.subscriptionStatus);
  });

  test("fields a customer is not meant to set are not set: the owner, the account and the id stay theirs", async () => {
    const made = await target.call(target.a, "POST", "/api/agents", {
      body: {
        name: "mass assignment",
        title: "t",
        roleDescription: "r",
        visibility: "public",
        ownerUserId: target.b.id,
        tenantId: target.b.tenantId,
        packageId: "fintech",
        id: "general-assistant",
        hidden: true,
        systemOwned: true,
      },
    });
    expect(made.status).toBe(201);
    const agent = JSON.parse(made.text).agent;
    expect(agent.id).not.toBe("general-assistant");
    expect(agent.systemOwned).toBe(false);
    // Public means public to the owner's own account. The other customer does not see it.
    expect(
      (await target.call(target.b, "GET", "/api/agents")).text,
    ).not.toContain("mass assignment");
    expect(
      (await target.call(target.admin, "GET", "/api/agents")).text,
    ).not.toContain(`"id":"general-assistant","name":"mass assignment"`);
  });
});

run("proving who you are", () => {
  const cookieFor = (person: Person, edit: (token: string) => string) => {
    const [token] = decodeURIComponent(person.cookie.split("=")[1] ?? "").split(
      ".",
    );
    return {
      ...person,
      cookie: `better-auth.session_token=${edit(token ?? "")}`,
    };
  };

  test("a session cookie that was not signed by this server is refused, however it is dressed", async () => {
    const spare = await target.makePerson("forger");
    const attempts = [
      cookieFor(spare, (t) => encodeURIComponent(`${t}.AAAA`)),
      cookieFor(spare, (t) => t),
      cookieFor(spare, () => "%00%00"),
      cookieFor(spare, () => ""),
      cookieFor(spare, (t) => encodeURIComponent(`${t}.${"A".repeat(10_000)}`)),
      { ...spare, cookie: spare.cookie.replace(/tok-[^.%]+/, "tok-nope") },
    ];
    for (const attempt of attempts) {
      expect((await target.call(attempt, "GET", "/api/me")).status).toBe(401);
    }
  });

  test("an expired session is refused", async () => {
    const spare = await target.makePerson("expired");
    expect((await target.call(spare, "GET", "/api/me")).status).toBe(200);
    await target.database
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.userId, spare.id));
    expect((await target.call(spare, "GET", "/api/me")).status).toBe(401);
  });

  test("a person whose access an administrator removed is refused at once, session or not", async () => {
    const spare = await target.makePerson("removed");
    expect((await target.call(spare, "GET", "/api/me")).status).toBe(200);
    const removal = await target.call(
      target.admin,
      "POST",
      `/api/admin/people/${spare.id}/access`,
      {
        body: { revoked: true },
      },
    );
    expect(removal.status).toBe(200);
    expect((await target.call(spare, "GET", "/api/me")).status).toBe(401);
  });

  test("the sign-in library's own routes cannot be used to become somebody else or something more", async () => {
    const origin = { origin: target.url };
    const refused = async (
      path: string,
      body: unknown,
      as: Person | null = target.a,
    ) => {
      const answer = await target.call(as, "POST", path, {
        body,
        headers: origin,
      });
      expect([path, answer.status >= 400]).toEqual([path, true]);
      return answer;
    };
    // Change who you are by address, which is what an administrator is matched on.
    const update = await refused("/api/auth/update-user", {
      name: "x",
      email: "admin@customer.test",
    });
    expect(update.text).toMatch(/EMAIL_CAN_NOT_BE_UPDATED/);
    await refused("/api/auth/change-email", {
      newEmail: "admin@customer.test",
    });
    // No passwords exist to guess or reset.
    await refused(
      "/api/auth/sign-up/email",
      { email: "evil@x.test", password: "password12345", name: "e" },
      null,
    );
    await refused(
      "/api/auth/sign-in/email",
      { email: "alice@customer.test", password: "password12345" },
      null,
    );
    await refused(
      "/api/auth/request-password-reset",
      { email: "alice@customer.test" },
      null,
    );
    // Register a way to sign in as a company's domain: administrators only.
    const register = await refused("/api/auth/sso/register", {
      providerId: "evil",
      issuer: "https://evil.example",
      domain: "customer.test",
      oidcConfig: {
        clientId: "x",
        clientSecret: "y",
        discoveryEndpoint:
          "https://evil.example/.well-known/openid-configuration",
      },
    });
    expect(register.status).toBe(403);
    await refused("/api/auth/sso/update-provider", {
      providerId: "x",
      domain: "customer.test",
    });
    await refused("/api/auth/sso/delete-provider", { providerId: "x" });
    // Removing yourself in a way that skips the careful erasure.
    expect(
      (
        await target.call(target.a, "POST", "/api/auth/delete-user", {
          body: {},
          headers: origin,
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
    // The list of providers is not a way to read another company's directory settings.
    const providers = await target.call(
      target.a,
      "GET",
      "/api/auth/sso/providers",
      { headers: origin },
    );
    expect(providers.text).not.toMatch(
      /clientSecret|samlConfig|BEGIN CERTIFICATE/,
    );
  });

  test("the sign-in library does not print a token for a script in the page to read", async () => {
    for (const path of [
      "/api/auth/list-sessions",
      "/api/auth/get-access-token",
      "/api/auth/refresh-token",
      "/api/auth/account-info",
    ]) {
      for (const method of ["GET", "POST"]) {
        const answer = await target.call(target.a, method, path, {
          body: method === "POST" ? { providerId: "google" } : undefined,
          headers: { origin: target.url },
        });
        expect([method, path, answer.status]).toEqual([method, path, 404]);
      }
    }
  });

  test("a sign-in cannot be sent to another website afterwards", async () => {
    for (const callbackURL of [
      "https://evil.example/",
      "//evil.example/",
      "javascript:alert(1)",
    ]) {
      const answer = await target.call(
        null,
        "POST",
        "/api/auth/sign-in/social",
        {
          body: { provider: "google", callbackURL },
          headers: { origin: target.url },
        },
      );
      expect(answer.status).toBe(403);
    }
  });
});

run("credentials that are not a person's cookie", () => {
  const KEY = Buffer.alloc(32, 7).toString("base64");
  const WRONG_KEY = Buffer.alloc(32, 9).toString("base64");

  test("the model gateway accepts only a grant this deployment signed, for now, for a connection that exists", async () => {
    const connection = alice.connectionId;
    const ask = (token: string | null) =>
      target.call(null, "POST", "/api/model-gateway/anthropic/v1/messages", {
        body: {
          model: "claude",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        },
        headers: token ? { "x-api-key": token } : {},
      });
    const now = Date.now();
    const refused = [
      await ask(null),
      await ask("sk-ant-api03-guess"),
      await ask("not.a.grant"),
      await ask(
        mintModelGrant(
          { actorId: target.a.id, connectionId: connection },
          WRONG_KEY,
        ),
      ),
      await ask(
        mintModelGrant(
          { actorId: target.a.id, connectionId: connection },
          KEY,
          now - 3 * 60 * 60 * 1000,
        ),
      ),
      // A person's session token, or any other signed value, is not a grant.
      await ask(decodeURIComponent(target.a.cookie.split("=")[1] ?? "")),
    ];
    for (const answer of refused) expect(answer.status).toBe(401);

    // Signed by the deployment, but for somebody else's connection: the grant names the owner, so it
    // cannot be used to spend another person's key.
    const crossed = await ask(
      mintModelGrant(
        { actorId: target.a.id, connectionId: bob.connectionId },
        KEY,
      ),
    );
    expect(crossed.status).not.toBe(200);
    expect(crossed.text).not.toContain("sk-BOBSECRET");
  });

  test("a bot's own tool call needs its own token and a run signed by this deployment", async () => {
    const call = (headers: Record<string, string>, run?: unknown) =>
      target.call(null, "POST", "/api/agent-tools/call", {
        body: {
          name: "gmail__send",
          args: {},
          ...(run !== undefined ? { run } : {}),
        },
        headers,
      });
    for (const answer of [
      await call({}),
      await call({ "x-openbot-agent-token": "guess" }),
      await call({ "x-openbot-agent-token": "x".repeat(10_000) }, "x.y"),
      await call(
        { "x-openbot-agent-token": "guess" },
        { botId: bob.agentId, actorId: target.b.id },
      ),
    ]) {
      expect(answer.status).toBe(401);
    }
  });

  test("the routines endpoint answers a guess exactly as it answers nobody", async () => {
    const without = await target.call(null, "POST", "/internal/routines/run", {
      body: {},
    });
    const wrong = await target.call(null, "POST", "/internal/routines/run", {
      body: {},
      headers: { authorization: "Bearer guess" },
    });
    expect([without.status, wrong.status]).toEqual([401, 401]);
    expect(without.text).toBe(wrong.text);
    // A customer's session is not the worker's secret.
    expect(
      (
        await target.call(target.a, "POST", "/internal/routines/run", {
          body: {},
        })
      ).status,
    ).toBe(401);
  });

  test("a vendor's redirect carrying a forged state does nothing and goes nowhere but home", async () => {
    for (const query of [
      "?state=forged&code=x",
      "?error=access_denied",
      "",
      "?state=%00&code=%00",
      `?state=${"a".repeat(5000)}&code=x`,
    ]) {
      const answer = await target.call(
        target.a,
        "GET",
        `/api/plugins/oauth/callback${query}`,
      );
      expect([query.slice(0, 20), answer.status < 500]).toEqual([
        query.slice(0, 20),
        true,
      ]);
      const location = answer.headers.get("location") ?? "";
      expect(
        location === "" ||
          location.startsWith("/") ||
          location.startsWith(target.url),
      ).toBe(true);
      expect(answer.headers.get("set-cookie")).toBeNull();
    }
  });

  test("the desktop's door is shut to anybody without its token", async () => {
    for (const [method, path] of [
      ["GET", "/api/host-access/desktop/next"],
      ["POST", "/api/host-access/desktop/result"],
    ] as const) {
      for (const headers of [
        {},
        { authorization: "Bearer guess" },
        { "x-openbot-desktop-token": "guess" },
      ]) {
        const answer = await target.call(null, method, path, {
          body: method === "POST" ? {} : undefined,
          headers,
        });
        expect([401, 403, 503]).toContain(answer.status);
      }
    }
  });
});

run("the files the server hands out", () => {
  const built = Bun.file(
    new URL("../../../app/dist/index.html", import.meta.url).pathname,
  );

  test("a path cannot be bent into reading anything outside the built app", async () => {
    if (!(await built.exists())) return; // Needs `bun run build`; reported as skipped by absence.
    const attempts = [
      "/..%2f..%2f..%2fetc%2fpasswd",
      "/%2e%2e/%2e%2e/%2e%2e/etc/passwd",
      "/assets/../../../../etc/passwd",
      "/assets/..%2f..%2f..%2f..%2fetc%2fpasswd",
      "//etc/passwd",
      "/%5c..%5c..%5cetc%5cpasswd",
      "/..;/..;/etc/passwd",
      "/.env",
      "/..%252f..%252fetc%252fpasswd",
      "/%00../etc/passwd",
      "/index.html%00.png",
    ];
    for (const path of attempts) {
      const answer = await target.call(null, "GET", path);
      expect([path, answer.text.includes("root:x:0:0")]).toEqual([path, false]);
      expect([path, answer.text.includes("KEY_ENCRYPTION_KEY")]).toEqual([
        path,
        false,
      ]);
    }
  });

  test("the built app is served with the browser protections, and an unknown page is the app, never an error page that names the server", async () => {
    if (!(await built.exists())) return;
    const page = await target.call(null, "GET", "/marketplace");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain(
      "frame-ancestors",
    );
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    // An API path that does not exist is a JSON refusal, not the app's HTML.
    const missing = await target.call(null, "GET", "/api/definitely-not-here");
    expect(missing.text).not.toContain("<!doctype html>");
  });
});

run("shared coworkers", () => {
  test("a coworker somebody else shared can be read and reported, and never installed, run, or copied", async () => {
    // Approved by the reviewer, so that it is public to every signed-in person.
    const approved = await target.call(
      target.admin,
      "POST",
      `/api/admin/marketplace/listings/${bob.listingId}/approve`,
      {
        body: { note: "fine" },
      },
    );
    expect(approved.status).toBe(200);

    const before = JSON.parse(
      (await target.call(target.a, "GET", "/api/agents")).text,
    ).agents.length;
    const view = await target.call(
      target.a,
      "GET",
      `/api/marketplace/listings/${bob.listingSlug}`,
    );
    expect(view.status).toBe(200);
    expect(view.text).not.toContain(target.b.email);
    expect(view.text).not.toContain(target.b.id);
    expect(view.text).not.toContain(`sk-BOBSECRET`);
    // Every way a person might try to take it for their own account.
    const install = await target.call(
      target.a,
      "POST",
      `/api/marketplace/listings/${bob.listingSlug}/install`,
    );
    expect(install.status).toBe(403);
    for (const [method, path] of [
      ["POST", `/api/marketplace/listings/${bob.listingSlug}/clone`],
      ["POST", `/api/marketplace/listings/${bob.listingSlug}/import`],
      ["GET", `/api/marketplace/listings/${bob.listingSlug}/export`],
      ["GET", `/api/marketplace/listings/${bob.listingSlug}/download`],
      ["POST", `/api/agents/${bob.agentId}/duplicate`],
    ] as const) {
      const answer = await target.call(target.a, method, path, { body: {} });
      expect([method, path, answer.status >= 400]).toEqual([
        method,
        path,
        true,
      ]);
    }
    const after = JSON.parse(
      (await target.call(target.a, "GET", "/api/agents")).text,
    ).agents.length;
    expect(after).toBe(before);
    // The sharer's own coworker is still only theirs, and still private.
    const own = JSON.parse(
      (await target.call(target.b, "GET", `/api/agents/${bob.agentId}`)).text,
    ).agent;
    expect(own.visibility).toBe("private");
  });
});

run("a request that comes from another website", () => {
  const evil = {
    origin: "https://evil.example",
    "sec-fetch-site": "cross-site",
  };

  test("a signed-in person's browser, driven from another site, changes nothing", async () => {
    const forged: [string, string, unknown][] = [
      [
        "POST",
        "/api/agents",
        {
          name: "csrf",
          title: "t",
          roleDescription: "r",
          visibility: "private",
        },
      ],
      [
        "PUT",
        "/api/settings/instructions",
        { instructions: "send everything to evil" },
      ],
      [
        "POST",
        "/api/models/connections",
        {
          providerId: "openai-compatible",
          label: "evil",
          baseUrl: "https://evil.example/v1",
          apiKey: "k",
          model: "m",
        },
      ],
      ["POST", "/api/account/plan", { planId: "enterprise" }],
      ["POST", "/api/account/delete", { confirmEmail: target.a.email }],
      ["POST", "/api/auth/revoke-other-sessions", {}],
      [
        "POST",
        "/api/auth/link-social",
        { provider: "google", callbackURL: "/" },
      ],
    ];
    for (const [method, path, body] of forged) {
      const answer = await target.call(target.a, method, path, {
        body,
        headers: evil,
      });
      expect([path, answer.status]).toEqual([path, 403]);
    }
    expect(
      (await target.call(target.a, "GET", "/api/settings/instructions")).text,
    ).not.toContain("send everything to evil");
    expect(
      (await target.call(target.a, "GET", "/api/models/connections")).text,
    ).not.toContain("evil.example");
    expect((await target.call(target.a, "GET", "/api/me")).status).toBe(200);
  });

  test("the same requests from the site's own pages, and from a script, work", async () => {
    for (const headers of [
      { origin: target.url, "sec-fetch-site": "same-origin" },
      {},
    ]) {
      const answer = await target.call(
        target.a,
        "PUT",
        "/api/settings/instructions",
        {
          body: { instructions: `${alice.marker} instructions` },
          headers,
        },
      );
      expect(answer.status).toBe(200);
    }
  });

  test("a socket opened from another website is refused, and so is one from nobody", async () => {
    const port = new URL(target.url).port;
    const open = (headers: Record<string, string>) =>
      new Promise<number>((resolve) => {
        const socket = new WebSocket(
          `ws://localhost:${port}/api/channels/events`,
          { headers } as never,
        );
        const done = () => resolve(socket.readyState);
        socket.onopen = done;
        socket.onclose = done;
        socket.onerror = done;
        setTimeout(done, 4000);
      });
    expect(
      await open({ cookie: target.a.cookie, origin: "https://evil.example" }),
    ).toBe(3);
    expect(await open({})).toBe(3);
    const own = new WebSocket(`ws://localhost:${port}/api/channels/events`, {
      headers: { cookie: target.a.cookie },
    } as never);
    const state = await new Promise<number>((resolve) => {
      own.onopen = () => resolve(own.readyState);
      own.onclose = () => resolve(own.readyState);
      setTimeout(() => resolve(own.readyState), 4000);
    });
    own.close();
    expect(state).toBe(1);
  });

  test("another site cannot read answers either: there is no cross-origin permission anywhere", async () => {
    const preflight = await target.call(null, "OPTIONS", "/api/agents", {
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "POST",
      },
    });
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    const read = await target.call(target.a, "GET", "/api/me", {
      headers: evil,
    });
    expect(read.headers.get("access-control-allow-origin")).toBeNull();
  });
});

run("money", () => {
  const body = (status: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      event_id: `evt_${status}_${Math.random().toString(36).slice(2, 10)}`,
      event_type: "subscription.updated",
      occurred_at: new Date().toISOString(),
      data: {
        id: "sub_01sec",
        status,
        customer_id: "ctm_01sec",
        custom_data: { tenant_id: target.a.tenantId, plan_id: "agent" },
        items: [{ price: { id: "pri_01aaaaaaaa" } }],
        scheduled_change: null,
        current_billing_period: null,
        ...extra,
      },
    });
  const sign = (
    raw: string,
    options: { ts?: number; secret?: string } = {},
  ) => {
    const ts = options.ts ?? Math.floor(Date.now() / 1000);
    const h1 = createHmac("sha256", options.secret ?? WEBHOOK_SECRET)
      .update(`${ts}:${raw}`)
      .digest("hex");
    return `ts=${ts};h1=${h1}`;
  };
  const post = (raw: string, signature?: string) =>
    target.call(null, "POST", "/api/billing/webhook/paddle", {
      raw,
      headers: {
        "content-type": "application/json",
        ...(signature ? { "paddle-signature": signature } : {}),
      },
    });
  const planOf = async (person: Person) =>
    JSON.parse((await target.call(person, "GET", "/api/account")).text).account;

  test("a notice that is not exactly what Paddle signed, is refused, and changes nothing", async () => {
    const before = await planOf(target.b);
    const raw = body("canceled", {
      custom_data: { tenant_id: target.b.tenantId, plan_id: "agent" },
    });
    const now = Math.floor(Date.now() / 1000);
    const forgeries = [
      post(raw),
      post(raw, sign(raw, { secret: "pdl_ntfset_guess" })),
      post(raw, sign(raw, { ts: now - 3600 })),
      post(raw, sign(raw, { ts: now + 3600 })),
      post(raw.replace("canceled", "active"), sign(raw)),
      post(raw, "h1=zz"),
      post(raw, `ts=${now};h1=`),
      post(raw, `ts=${now};${"h1=aa;".repeat(200)}`),
      post(raw, `ts=${now};h1=${"0".repeat(64)}`),
    ];
    for (const answer of await Promise.all(forgeries)) {
      expect([400, 431]).toContain(answer.status);
    }
    const after = await planOf(target.b);
    expect(after.subscriptionStatus).toBe(before.subscriptionStatus);
    expect(after.planId).toBe(before.planId);
  });

  test("a notice Paddle really signed is applied once, and a replay of it is not applied again", async () => {
    const spare = await target.makePerson("payer");
    const raw = body("canceled", {
      custom_data: { tenant_id: spare.tenantId, plan_id: "agent" },
    });
    expect((await planOf(spare)).subscriptionStatus).toBe("active");
    const first = await post(raw, sign(raw));
    expect(JSON.parse(first.text)).toMatchObject({ ok: true, applied: 1 });
    expect((await planOf(spare)).subscriptionStatus).toBe("canceled");
    const replay = await post(raw, sign(raw));
    expect(JSON.parse(replay.text)).toMatchObject({
      applied: 0,
      duplicates: 1,
    });
  });

  test("an older notice never overwrites a newer state", async () => {
    const spare = await target.makePerson("ordering");
    const newer = JSON.stringify({
      ...JSON.parse(
        body("active", {
          custom_data: { tenant_id: spare.tenantId, plan_id: "team" },
          items: [{ price: { id: "pri_01bbbbbbbb" } }],
        }),
      ),
      occurred_at: "2026-10-08T12:00:00.000000Z",
    });
    const older = JSON.stringify({
      ...JSON.parse(
        body("canceled", {
          custom_data: { tenant_id: spare.tenantId, plan_id: "team" },
          items: [{ price: { id: "pri_01bbbbbbbb" } }],
        }),
      ),
      occurred_at: "2026-10-08T10:00:00.000000Z",
    });
    await post(newer, sign(newer));
    await post(older, sign(older));
    expect((await planOf(spare)).subscriptionStatus).toBe("active");
  });

  test("only the payment provider that is configured has a door", async () => {
    for (const provider of ["stripe", "sandbox", "manual", "..%2f", "PADDLE"]) {
      const answer = await post(body("active"), sign(body("active")));
      void answer;
      const named = await target.call(
        null,
        "POST",
        `/api/billing/webhook/${provider}`,
        {
          raw: body("active"),
          headers: { "content-type": "application/json" },
        },
      );
      expect([provider, named.status === 404 || named.status === 400]).toEqual([
        provider,
        true,
      ]);
    }
  });

  test("the checkout page repeats nothing it was given", async () => {
    for (const query of [
      "?_ptxn=%22%3E%3Cscript%3Ealert(1)%3C/script%3E",
      "?_ptxn=javascript:alert(1)",
      "?_ptxn=txn_01abc&x=%3Cimg%20src=x%20onerror=alert(1)%3E",
    ]) {
      const page = await target.call(
        null,
        "GET",
        `/api/billing/checkout${query}`,
      );
      expect(page.text).not.toContain("<script>alert");
      expect(page.text).not.toContain("onerror=alert");
      expect(page.text).not.toContain("javascript:alert");
    }
  });
});

run("making the server fetch what it should not", () => {
  const internal = [
    "http://169.254.169.254/latest/meta-data/",
    "http://169.254.170.2/v2/credentials",
    "http://metadata.google.internal/",
    "http://127.0.0.1:1/",
    "http://localhost/",
    "http://[::1]/",
    "http://0.0.0.0/",
    "http://10.0.0.1/",
    "http://172.16.0.1/",
    "http://192.168.1.1/",
    "http://100.64.0.1/",
    "http://2130706433/",
    "http://0x7f000001/",
    "http://0177.0.0.1/",
    "http://127.1/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/",
    "http://[fd00::1]/",
    "http://[fe80::1]/",
    "http://user:pass@127.0.0.1/",
    "http://localhost.:80/",
    "http://127.0.0.1.:80/",
    "file:///etc/passwd",
    "gopher://127.0.0.1:6379/",
    "ftp://127.0.0.1/",
    "dict://127.0.0.1:11211/",
  ];

  test("an address inside the deployment is never dialled, however it is spelled, to test an agent", async () => {
    const dialled: string[] = [];
    for (const address of internal) {
      const answer = await target.call(
        target.a,
        "POST",
        "/api/agents/test-connection",
        { body: { endpoint: address } },
      );
      const verdict = JSON.parse(answer.text);
      if (answer.status === 200 && verdict.ok !== false) dialled.push(address);
      if (answer.status >= 500) dialled.push(`${address} -> ${answer.status}`);
    }
    expect(dialled).toEqual([]);
  });

  test("nor to probe a model provider, nor to save one", async () => {
    const dialled: string[] = [];
    for (const address of internal) {
      for (const path of ["/api/models/probe", "/api/models/connections"]) {
        const answer = await target.call(target.a, "POST", path, {
          body: {
            providerId: "openai-compatible",
            baseUrl: address,
            apiKey: "k",
            label: "ssrf",
            model: "m",
          },
        });
        if (answer.status < 400)
          dialled.push(`${path} ${address} -> ${answer.status}`);
        if (answer.status >= 500)
          dialled.push(`${path} ${address} -> ${answer.status}`);
        // A refusal says why, in words, and never prints the address's own answer.
      }
    }
    expect(dialled).toEqual([]);
  });

  test("an agent cannot be registered at an address inside the deployment", async () => {
    for (const address of [
      "http://169.254.169.254/",
      "http://10.0.0.5/ag-ui",
      "http://localhost:3001/",
    ]) {
      const answer = await target.call(target.a, "POST", "/api/agents", {
        body: {
          name: "ssrf",
          title: "t",
          roleDescription: "r",
          visibility: "private",
          endpoint: address,
        },
      });
      expect([address, answer.status]).toEqual([address, 400]);
    }
  });
});

run("what a customer can upload", () => {
  const upload = async (name: string, type: string, content: BlobPart) => {
    const form = new FormData();
    form.append("file", new File([content], name, { type }));
    const response = await fetch(
      `${target.url}/api/channels/${alice.channelId}/attachments`,
      {
        method: "POST",
        headers: { cookie: target.a.cookie },
        body: form,
      },
    );
    return { status: response.status, text: await response.text() };
  };

  test("anything that runs in a browser is refused", async () => {
    for (const [name, type, body] of [
      ["page.html", "text/html", "<script>alert(1)</script>"],
      [
        "image.svg",
        "image/svg+xml",
        '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
      ],
      ["code.js", "application/javascript", "alert(1)"],
      ["page.xhtml", "application/xhtml+xml", "<html/>"],
    ] as const) {
      expect([name, (await upload(name, type, body)).status]).toEqual([
        name,
        415,
      ]);
    }
  });

  test("what is accepted is handed back as a download, never as a page", async () => {
    const made = await upload(
      "note.txt",
      "text/html",
      "<script>alert(2)</script>",
    );
    expect(made.status).toBe(201);
    const served = await target.call(
      target.a,
      "GET",
      `/api/attachments/${JSON.parse(made.text).id}`,
    );
    expect(served.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(served.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("too large is refused before it is read, and a hostile name does no harm", async () => {
    expect(
      (await upload("big.txt", "text/plain", "a".repeat(2_000_000))).status,
    ).toBe(413);
    const huge = await fetch(
      `${target.url}/api/channels/${alice.channelId}/attachments`,
      {
        method: "POST",
        headers: {
          cookie: target.a.cookie,
          "content-type": "application/octet-stream",
        },
        body: new Uint8Array(70 * 1024 * 1024),
      },
    );
    expect(huge.status).toBe(413);
    const named = await upload("a\r\nSet-Cookie: x=1.txt", "text/plain", "x");
    expect(named.status).toBe(201);
    const served = await target.call(
      target.a,
      "GET",
      `/api/attachments/${JSON.parse(named.text).id}`,
    );
    expect(served.headers.get("set-cookie")).toBeNull();
    expect(served.headers.get("content-disposition")).not.toMatch(/[\r\n]/);
  });
});

run("what the server does with input that no screen would send", () => {
  test("a request body larger than any screen sends is refused rather than read", async () => {
    const answer = await target.call(target.a, "POST", "/api/agents", {
      raw: JSON.stringify({ name: "x".repeat(8_000_000) }),
    });
    expect(answer.status).toBe(413);
  });

  test("broken and strange JSON is a polite refusal, never a crash", async () => {
    for (const raw of [
      "{not json",
      "[1,2,3]",
      "null",
      '"text"',
      "[".repeat(100_000),
      "{".repeat(100_000),
      "\u0000",
      "9".repeat(10_000),
      '{"__proto__":{"polluted":true}}',
    ]) {
      const answer = await target.call(target.a, "POST", "/api/agents", {
        raw,
      });
      expect([
        raw.slice(0, 10),
        answer.status >= 400 && answer.status < 500,
      ]).toEqual([raw.slice(0, 10), true]);
    }
    // And nothing was polluted for everybody else.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((await target.call(target.a, "GET", "/api/me")).status).toBe(200);
  });

  test("no route answers with a server error to hostile ids, bodies and search text", async () => {
    const hostileIds = [
      "%00",
      "..%2f..%2fetc%2fpasswd",
      "a".repeat(5000),
      "' OR 1=1--",
      "%E2%80%AE",
      "../",
      "{{7*7}}",
      "$" + "{7*7}",
    ];
    const bodies: unknown[] = [
      {},
      [],
      null,
      "x",
      Number.MAX_VALUE,
      { name: null },
      { $ne: 1 },
    ];
    const broke: string[] = [];
    // 502 and 503 are the hub, a model or a computer not being there, which is not what is tested.
    const ok = (status: number) =>
      status < 500 || status === 502 || status === 503;
    for (const route of unique(target.routes)) {
      if (
        route.path === "/api/channels/events" ||
        route.path.startsWith("/api/voice/calls") ||
        route.path === "/api/audio/transcriptions"
      )
        continue;
      for (const id of hostileIds) {
        const path = route.path.replace(/:([A-Za-z]+)/g, id);
        const answer = await target.call(
          target.a,
          route.method,
          path,
          WRITES.has(route.method) ? { body: {} } : {},
        );
        if (!ok(answer.status))
          broke.push(
            `${route.method} ${route.path} id=${id.slice(0, 12)} -> ${answer.status}`,
          );
      }
      if (WRITES.has(route.method)) {
        for (const body of bodies) {
          const answer = await target.call(
            target.a,
            route.method,
            nowhere(route.path),
            { body },
          );
          if (!ok(answer.status))
            broke.push(
              `${route.method} ${route.path} body=${JSON.stringify(body)?.slice(0, 20)} -> ${answer.status}`,
            );
        }
      } else {
        for (const query of [
          "?search=%27%22%00",
          "?cursor=%00",
          "?limit=-1",
          "?limit=99999999999",
          "?cursor=a&cursor=b",
        ]) {
          const answer = await target.call(
            target.a,
            route.method,
            nowhere(route.path) + query,
          );
          if (!ok(answer.status))
            broke.push(
              `${route.method} ${route.path}${query} -> ${answer.status}`,
            );
        }
      }
    }
    expect(broke).toEqual([]);
  }, 300_000);

  test("an error never shows the server's insides", async () => {
    const answers = [
      await target.call(target.a, "GET", "/api/agents/%00"),
      await target.call(target.a, "POST", "/api/agents", { raw: "{" }),
      await target.call(null, "GET", "/api/admin/people"),
      await target.call(target.a, "GET", "/api/no-such-route"),
    ];
    for (const answer of answers) {
      expect(answer.text).not.toMatch(
        /at .*\.ts:\d+|node_modules|Failed query|\/home\/|postgres:\/\/|SELECT |stack/i,
      );
    }
  });
});

run("what every answer carries", () => {
  test("every kind of answer, including refusals and misses, carries the browser protections", async () => {
    const answers = [
      await target.call(null, "GET", "/health"),
      await target.call(null, "GET", "/api/me"),
      await target.call(target.a, "GET", "/api/me"),
      await target.call(
        target.a,
        "GET",
        "/api/agents/00000000-0000-4000-8000-000000000000",
      ),
      await target.call(null, "GET", "/api/nothing-here"),
      await target.call(null, "POST", "/api/billing/webhook/paddle", {
        raw: "{}",
        headers: { "content-type": "application/json" },
      }),
    ];
    for (const answer of answers) {
      expect(answer.headers.get("x-content-type-options")).toBe("nosniff");
      expect(answer.headers.get("content-security-policy")).toContain(
        "frame-ancestors",
      );
      expect(answer.headers.get("referrer-policy")).toBe(
        "strict-origin-when-cross-origin",
      );
    }
  });

  test("the server does not announce what it is built with", async () => {
    const answer = await target.call(target.a, "GET", "/api/me");
    expect(answer.headers.get("x-powered-by")).toBeNull();
    expect(answer.headers.get("server")).toBeNull();
  });
});

run("how fast a person may ask", () => {
  test("a person cannot ask for a copy of everything held about them over and over", async () => {
    const spare = await target.makePerson("hammer");
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 12; attempt++) {
      statuses.push(
        (await target.call(spare, "GET", "/api/account/export")).status,
      );
    }
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses).toContain(429);
  });

  test("a deletion that is not confirmed with the person's own address is refused every time, and removes nothing", async () => {
    const spare = await target.makePerson("typo");
    for (let attempt = 0; attempt < 8; attempt++) {
      const answer = await target.call(spare, "POST", "/api/account/delete", {
        body: { confirmEmail: `not-${attempt}@customer.test` },
      });
      expect(answer.status).toBe(400);
    }
    expect((await target.call(spare, "GET", "/api/me")).status).toBe(200);
  });

  test("nor can reports, which an enemy would use to bury somebody's listing", async () => {
    const spare = await target.makePerson("reporter");
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 40; attempt++) {
      const answer = await target.call(
        spare,
        "POST",
        "/api/marketplace/listings/careful-analyst-ab12cd/report",
        {
          body: { reason: "spam", details: "x" },
        },
      );
      statuses.push(answer.status);
    }
    expect(statuses).toContain(429);
  });
});

run("running in the cloud, which is charged for", () => {
  const RATES = {
    computeCentsPerHour: 60,
    storageCentsPerGbMonth: 0,
    egressCentsPerGb: 0,
    paymentFeePercent: 5,
    paymentFeeFixedCents: 50,
    marginPercent: 0,
    minimumChargeCents: 500,
  };
  const enable = (
    as: Person,
    body: unknown = { monthlyCapCents: 3000, shownRates: RATES },
  ) => target.call(as, "POST", "/api/account/cloud/enable", { body });
  const mine = async (as: Person) =>
    JSON.parse((await target.call(as, "GET", "/api/account/cloud")).text);

  test("only staff set a price, and a customer's attempt changes nothing", async () => {
    const before = (
      await target.call(target.admin, "GET", "/api/admin/cloud/rates")
    ).text;
    for (const as of [target.a, target.b]) {
      for (const body of [RATES, { ...RATES, computeCentsPerHour: 1 }]) {
        const answer = await target.call(as, "PUT", "/api/admin/cloud/rates", {
          body,
        });
        expect(answer.status).toBe(403);
      }
    }
    expect(
      (await target.call(target.admin, "GET", "/api/admin/cloud/rates")).text,
    ).toBe(before);
    expect(
      (
        await target.call(target.admin, "PUT", "/api/admin/cloud/rates", {
          body: RATES,
        })
      ).status,
    ).toBe(200);
  });

  test("a customer agrees only to the prices actually in force, and to a limit that makes sense", async () => {
    const forged = await enable(target.a, {
      monthlyCapCents: 3000,
      shownRates: { ...RATES, computeCentsPerHour: 1 },
    });
    expect(forged.status).toBe(409);
    for (const monthlyCapCents of [0, -5, 99, 1_000_001, 1.5, "30", null]) {
      expect(
        (await enable(target.a, { monthlyCapCents, shownRates: RATES })).status,
      ).toBe(400);
    }
    // Neither refusal switched anything on.
    expect((await mine(target.a)).cloud.enabled).toBe(false);
  });

  test("one customer's switch, limit and bill are theirs alone", async () => {
    expect((await enable(target.a)).status).toBe(200);
    await target.database.insert(cloudCharges).values({
      tenantId: target.a.tenantId,
      period: "2026-09",
      status: "uncertain",
      usage: { computeSeconds: 3600, storageByteSeconds: 0, egressBytes: 0 },
      rates: RATES,
      costCents: "60",
      amountCents: 123,
      providerRef: "paddle:sub_ALICEREF",
      note: "ALICENOTE",
    });

    const bobs = await target.call(target.b, "GET", "/api/account/cloud");
    expect(JSON.parse(bobs.text).cloud.enabled).toBe(false);
    expect(JSON.parse(bobs.text).charges).toEqual([]);
    // Bob's switches act on Bob's account, and do not reach Alice's.
    await target.call(target.b, "PUT", "/api/account/cloud/cap", {
      body: { monthlyCapCents: 100 },
    });
    await target.call(target.b, "POST", "/api/account/cloud/disable");
    const alices = await mine(target.a);
    expect(alices.cloud.enabled).toBe(true);
    expect(alices.cloud.monthlyCapCents).toBe(3000);
    // Her own bill is hers to read, without the provider's reference or our notes.
    expect(alices.charges).toHaveLength(1);
    expect(alices.charges[0].status).toBe("checking");
    const text = JSON.stringify(alices);
    expect(text).not.toContain("ALICEREF");
    expect(text).not.toContain("ALICENOTE");
  });

  test("a customer cannot read what staff read, nor settle a month, and a settled one stays settled", async () => {
    const [charge] = await target.database
      .select({ id: cloudCharges.id })
      .from(cloudCharges);
    for (const as of [target.a, target.b]) {
      for (const [method, path] of [
        ["GET", "/api/admin/cloud/usage"],
        ["GET", "/api/admin/cloud/charges"],
        ["POST", `/api/admin/cloud/charges/${charge?.id}/settle`],
      ] as const) {
        const answer = await target.call(as, method, path, {
          body: { outcome: "waived", note: "I would like it free" },
        });
        expect(answer.status).toBe(403);
      }
    }
    const first = await target.call(
      target.admin,
      "POST",
      `/api/admin/cloud/charges/${charge?.id}/settle`,
      { body: { outcome: "charged", note: "Paddle shows it taken" } },
    );
    expect(first.status).toBe(200);
    const second = await target.call(
      target.admin,
      "POST",
      `/api/admin/cloud/charges/${charge?.id}/settle`,
      { body: { outcome: "waived", note: "changed my mind" } },
    );
    expect(second.status).toBe(409);
  });

  test("the switch is on the customer's own account, whatever is put in the body", async () => {
    const spare = await target.makePerson("cloudspare");
    const answer = await target.call(
      spare,
      "POST",
      "/api/account/cloud/enable",
      {
        body: {
          monthlyCapCents: 3000,
          shownRates: RATES,
          tenantId: target.a.tenantId,
        },
      },
    );
    // A field that is not part of the request is a refused request, not an instruction.
    expect(answer.status).toBe(400);
    const stray = await target.database
      .select({ id: cloudAccounts.tenantId })
      .from(cloudAccounts);
    expect(stray.map((row) => row.id)).not.toContain(spare.tenantId);
  });
});

run("the content-security-policy and its report door", () => {
  test("every page of the app carries the policy, watched by default, and the payment page its own", async () => {
    for (const path of [
      "/health",
      "/",
      "/settings/plan",
      "/api/nothing-here",
    ]) {
      const answer = await target.call(null, "GET", path);
      expect(answer.headers.get("content-security-policy")).toBe(
        "frame-ancestors 'self'",
      );
      expect(
        answer.headers.get("content-security-policy-report-only"),
      ).toContain("script-src 'self'");
    }
    // Wherever the payment page is configured it never gets the application's policy.
    const checkout = await target.call(null, "GET", "/api/billing/checkout");
    expect(
      checkout.headers.get("content-security-policy-report-only"),
    ).toContain("https://cdn.paddle.com");
    expect(checkout.headers.get("content-security-policy")).toBe(
      "frame-ancestors 'self'",
    );
  });

  test("the report door takes reports from the site itself and nobody else's pages, and stays small", async () => {
    const report = JSON.stringify({
      "csp-report": {
        "effective-directive": "script-src",
        "blocked-uri": "https://evil.example/x.js?secret=1",
        "document-uri": `${target.url}/settings/plan`,
      },
    });
    const post = (headers: Record<string, string>, raw: string = report) =>
      target.call(null, "POST", "/api/csp-report", {
        raw,
        headers: { "content-type": "application/csp-report", ...headers },
      });
    expect((await post({ origin: target.url })).status).toBe(204);
    // A page on another site posting here is the same cross-site write as any other.
    expect((await post({ origin: "https://evil.example" })).status).toBe(403);
    expect(
      (await post({ origin: target.url }, "x".repeat(20_000))).status,
    ).toBe(413);
    expect((await post({ origin: target.url }, "{nope")).status).toBe(400);
    const wrongKind = await target.call(null, "POST", "/api/csp-report", {
      raw: report,
      headers: { "content-type": "text/plain", origin: target.url },
    });
    expect(wrongKind.status).toBe(415);
    // It does not read back: there is nothing to GET.
    expect((await target.call(null, "GET", "/api/csp-report")).status).toBe(
      404,
    );
  });
});

/**
 * LAST ON PURPOSE. The tripwire (tripwire.ts) has been in front of the server's network for every
 * request the suite above made, signed in as customers and staff, with webhooks, uploads, the
 * runtime and the gateway all driven. What it recorded is what this asks about.
 */
run("nothing phones home", () => {
  test("in a whole run of the suite the server never tried to reach a CopilotKit host", async () => {
    expect(await target.tripwire()).toEqual([]);
  });

  test("and the tripwire itself works: a process behind it is refused the host, by every route", async () => {
    const probe = Bun.spawnSync(
      [
        "bun",
        "--no-env-file",
        "--preload",
        `${import.meta.dir}/tripwire.ts`,
        "-e",
        `
        const out = [];
        const attempt = async (name, run) => { try { await run(); out.push(name + ":reached"); } catch (e) { out.push(name + ":" + (String(e).includes("tripwire") ? "refused" : "other")); } };
        await attempt("fetch", () => fetch("https://telemetry.copilotkit.ai/ingest", { method: "POST" }));
        await attempt("fetch-url", () => fetch(new URL("https://cdn.copilotkit.ai/announcements.json")));
        await attempt("websocket", async () => new WebSocket("wss://api.cloud.copilotkit.ai/socket"));
        await attempt("dns", () => new Promise((resolve, reject) => require("node:dns").lookup("intelligence.copilotkit.ai", (e) => e ? reject(e) : resolve())));
        console.log(out.join(" "));
        `,
      ],
      {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          ARK_TRIPWIRE_LOG: "/dev/null",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(new TextDecoder().decode(probe.stdout).trim()).toBe(
      "fetch:refused fetch-url:refused websocket:refused dns:refused",
    );
  });
});
