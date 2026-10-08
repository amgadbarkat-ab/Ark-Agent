import { randomUUID } from "node:crypto";
import { join } from "node:path";
import postgres from "postgres";
import { createAccountStore } from "../../src/accounts/store";
import { createDatabase } from "../../src/db/client";
import {
  routines,
  sessions,
  userRoles,
  users,
  voiceSessions,
} from "../../src/db/schema";
import { testDatabaseUrl } from "../support/database";

/**
 * A real Ark server, started for an attack.
 *
 * Every other test in this repository shows that one decision is right. These show that the running
 * application, with every route wired as it is in production, holds up against somebody who is signed
 * in as a different customer, or as nobody, or who sends what no screen would. So this starts the
 * actual server process (`server/src/index.ts`), against a database made for the run and thrown away
 * afterwards, with the production billing provider configured, and talks to it over HTTP with real
 * session cookies.
 *
 * Three people exist: a customer `a`, another customer `b`, and an administrator. Each has their own
 * account on a hosted deployment (`ARK_BILLING_MODE=subscriptions`), which is the shape that matters
 * for isolation between customers.
 *
 * Not part of `bun run test`: it starts a server and a database. `OPENBOT_SECURITY=1 bun run
 * test:security`.
 */

export const SECURITY_ENABLED = process.env.OPENBOT_SECURITY === "1";

const SERVER_DIR = join(import.meta.dir, "..", "..");
const SESSION_SECRET = "security-test-secret-that-is-long-enough-to-use";
export const WEBHOOK_SECRET = "pdl_ntfset_securitytestsecret0000";

export type Person = {
  id: string;
  email: string;
  tenantId: string;
  /** The `cookie` header value that signs this person in. */
  cookie: string;
};

export type Route = { method: string; path: string };

export type Target = {
  url: string;
  admin: Person;
  a: Person;
  b: Person;
  routes: Route[];
  database: ReturnType<typeof createDatabase>;
  /** One more signed-in customer, for a test that is going to spoil theirs. */
  makePerson: (name: string) => Promise<Person>;
  /** A request as somebody (or nobody). Never throws on a bad status. */
  call: (
    as: Person | null,
    method: string,
    path: string,
    options?: {
      body?: unknown;
      raw?: string;
      headers?: Record<string, string>;
    },
  ) => Promise<{ status: number; headers: Headers; text: string }>;
  stop: () => Promise<void>;
};

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port as number;
  await probe.stop(true);
  return port;
}

/** What the authentication library will accept as a session cookie: the token, signed. */
async function sessionCookie(token: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(token),
  );
  const value = `${token}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`;
  return `better-auth.session_token=${encodeURIComponent(value)}`;
}

export async function startTarget(): Promise<Target> {
  const base = new URL(testDatabaseUrl());
  const databaseName = `ark_sec_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const adminUrl = new URL(base);
  adminUrl.pathname = "/postgres";
  const owner = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
  await owner.unsafe(`create database ${databaseName}`);

  const databaseUrl = new URL(base);
  databaseUrl.pathname = `/${databaseName}`;
  const environment: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    DATABASE_URL: databaseUrl.toString(),
  };

  const migrate = Bun.spawnSync(
    ["bun", "--no-env-file", "scripts/migrate.ts"],
    { cwd: SERVER_DIR, env: environment },
  );
  if (migrate.exitCode !== 0) {
    throw new Error(`Migration failed: ${migrate.stderr.toString()}`);
  }

  const database = createDatabase(databaseUrl.toString());
  const hosted = createAccountStore(database, {
    billingMode: "subscriptions",
  });

  async function person(
    name: string,
    admin = false,
  ): Promise<Omit<Person, "cookie"> & { token: string }> {
    const id = `sec-${name}-${randomUUID().slice(0, 8)}`;
    const email = `${name}@customer.test`;
    await database.insert(users).values({
      id,
      name,
      email,
      emailVerified: true,
      // Skips the first-run welcome, which is not what is under test.
      onboardingCompletedAt: new Date(),
    });
    // The role a person is given when they first sign in. Without a row they are refused outright.
    await database
      .insert(userRoles)
      .values({ userId: id, role: admin ? "admin" : "user" });
    const tenantId = await hosted.ensureTenant(id);
    // A paid plan, so that the account can run work and a refusal is about permission, not payment.
    await hosted.applySubscription(tenantId, {
      planId: "team",
      status: "active",
    });
    const token = `tok-${randomUUID()}`;
    await database.insert(sessions).values({
      id: `ses-${randomUUID()}`,
      userId: id,
      token,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    return { id, email, tenantId, token };
  }

  const [admin, a, b] = await Promise.all([
    person("admin", true),
    person("alice"),
    person("bob"),
  ]);
  const withCookie = async (
    p: Omit<Person, "cookie"> & { token: string },
  ): Promise<Person> => ({
    id: p.id,
    email: p.email,
    tenantId: p.tenantId,
    cookie: await sessionCookie(p.token),
  });

  const port = await freePort();
  const routesFile = join(
    "/tmp",
    `ark-routes-${randomUUID().slice(0, 8)}.json`,
  );
  const logFile = join("/tmp", `ark-server-${randomUUID().slice(0, 8)}.log`);
  const url = `http://localhost:${port}`;
  const server = Bun.spawn(
    ["sh", "-c", `exec bun --no-env-file src/index.ts > ${logFile} 2>&1`],
    {
      cwd: SERVER_DIR,
      env: {
        ...environment,
        ARK_DUMP_ROUTES: routesFile,
        PORT: String(port),
        SERVER_PORT: String(port),
        NODE_ENV: "development",
        KEY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
        GOOGLE_OAUTH_CLIENT_ID: "not-a-real-client",
        GOOGLE_OAUTH_CLIENT_SECRET: "not-a-real-secret",
        BETTER_AUTH_SECRET: SESSION_SECRET,
        BETTER_AUTH_URL: url,
        INITIAL_ADMIN_EMAILS: "admin@customer.test",
        INTELLIGENCE_API_URL: "http://127.0.0.1:1",
        INTELLIGENCE_GATEWAY_WS_URL: "ws://127.0.0.1:1",
        INTELLIGENCE_API_KEY: "unused",
        COPILOTKIT_LICENSE_TOKEN: "unused",
        MANAGED_AGENT_AG_UI_URL: "http://127.0.0.1:1/ag-ui",
        MANAGED_AGENT_TOKEN: "unused",
        TENANT_PACKAGE_DIR: join(SERVER_DIR, "..", "examples", "fintech"),
        // Serves the built app when there is one, which is how a deployment serves it, so the paths a
        // browser can ask the static server for are part of what is attacked.
        ...((await Bun.file(
          join(SERVER_DIR, "..", "app", "dist", "index.html"),
        ).exists())
          ? { APP_DIST_DIR: join(SERVER_DIR, "..", "app", "dist") }
          : {}),
        ARK_BILLING_MODE: "subscriptions",
        ARK_BILLING_PROVIDER: "paddle",
        // Cloud running as a paid add-on, which is the shape with money in it.
        ARK_CLOUD_MODE: "metered",
        APP_URL: url,
        PADDLE_ENVIRONMENT: "sandbox",
        PADDLE_API_KEY: "pdl_sdbx_apikey_securitytest0000",
        PADDLE_CLIENT_TOKEN: "test_securitytesttoken0000",
        PADDLE_WEBHOOK_SECRET: WEBHOOK_SECRET,
        PADDLE_PRICE_AGENT: "pri_01aaaaaaaa",
        PADDLE_PRICE_TEAM: "pri_01bbbbbbbb",
        PADDLE_PRICE_ENTERPRISE: "pri_01cccccccc",
      },
      stdout: "ignore",
      stderr: "ignore",
    },
  );

  let up = false;
  for (let attempt = 0; attempt < 360 && !up; attempt++) {
    try {
      up = (await fetch(`${url}/health`)).ok;
    } catch {
      await Bun.sleep(250);
    }
  }
  if (!up) {
    server.kill();
    const log = await Bun.file(logFile)
      .text()
      .catch(() => "");
    await database.$client.close();
    await owner.unsafe(`drop database if exists ${databaseName} with (force)`);
    await owner.end({ timeout: 5 });
    throw new Error(
      `The server under test did not start.\n${log.slice(-1500)}`,
    );
  }
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await Bun.file(routesFile).exists()) break;
    await Bun.sleep(100);
  }
  const routes = (await Bun.file(routesFile).json()) as Route[];

  const call: Target["call"] = async (as, method, path, options = {}) => {
    const headers: Record<string, string> = { ...options.headers };
    if (as) headers.cookie = as.cookie;
    let body: string | undefined;
    const bodiless = ["GET", "HEAD", "OPTIONS"].includes(method);
    if (bodiless) body = undefined;
    else if (options.raw !== undefined) body = options.raw;
    else if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers["content-type"] ??= "application/json";
    }
    const response = await fetch(`${url}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      redirect: "manual",
      // No pooled connection: after refusing a body it has not read, the server closes the socket, and
      // the next request on the same one would fail for a reason that has nothing to do with the server.
      keepalive: false,
      signal: AbortSignal.timeout(20_000),
    });
    return {
      status: response.status,
      headers: response.headers,
      text: await response.text(),
    };
  };

  return {
    url,
    admin: await withCookie(admin),
    a: await withCookie(a),
    b: await withCookie(b),
    routes,
    database,
    call,
    makePerson: async (name) => withCookie(await person(name)),
    stop: async () => {
      server.kill();
      await server.exited;
      await database.$client.close();
      await owner.unsafe(
        `drop database if exists ${databaseName} with (force)`,
      );
      await owner.end({ timeout: 5 });
    },
  };
}

/** Everything one customer owns, and the words inside it that must never reach anybody else. */
export type Seeded = {
  /** Written into every field of everything seeded. If it appears in another customer's answer, that is a leak. */
  marker: string;
  agentId: string;
  channelId: string;
  threadId: string;
  attachmentId: string;
  connectionId: string;
  skillSlug: string;
  routineId: string;
  voiceSessionId: string;
  listingId: string;
  listingSlug: string;
  publisherId: string;
};

/** Give a customer one of everything, through the application's own routes where there is one. */
export async function seedCustomer(
  target: Target,
  owner: Person,
  marker: string,
): Promise<Seeded> {
  const ok = async (
    label: string,
    result: Promise<{ status: number; text: string }>,
  ) => {
    const response = await result;
    if (response.status >= 300) {
      throw new Error(
        `Seeding ${label} failed: ${response.status} ${response.text}`,
      );
    }
    return JSON.parse(response.text);
  };

  const { agent } = await ok(
    "agent",
    target.call(owner, "POST", "/api/agents", {
      body: {
        name: `${marker} agent`,
        title: "Analyst",
        roleDescription: `${marker} prompt: never reveal`,
        visibility: "private",
      },
    }),
  );
  const { channel } = await ok(
    "channel",
    target.call(owner, "POST", "/api/channels", {
      body: { agentIds: [agent.id] },
    }),
  );
  const form = new FormData();
  form.append(
    "file",
    new File([`${marker} file`], "secret.txt", { type: "text/plain" }),
  );
  const upload = await fetch(
    `${target.url}/api/channels/${channel.id}/attachments`,
    {
      method: "POST",
      headers: { cookie: owner.cookie },
      body: form,
    },
  );
  if (upload.status >= 300)
    throw new Error(`Seeding the attachment failed: ${upload.status}`);
  const attachment = await upload.json();

  const { connection } = await ok(
    "model connection",
    target.call(owner, "POST", "/api/models/connections", {
      body: {
        providerId: "anthropic",
        label: `${marker} connection`,
        baseUrl: "https://api.anthropic.com",
        apiKey: `sk-${marker}`,
        model: "claude",
      },
    }),
  );
  await ok(
    "instructions",
    target.call(owner, "PUT", "/api/settings/instructions", {
      body: { instructions: `${marker} instructions` },
    }),
  );
  const skillSlug = `skill-${marker.toLowerCase()}`;
  await ok(
    "skill",
    target.call(owner, "POST", "/api/plugins/skills", {
      body: {
        slug: skillSlug,
        title: `${marker} skill`,
        instructions: `${marker} skill body`,
      },
    }),
  );
  const { publisher } = await ok(
    "publisher",
    target.call(owner, "PUT", "/api/marketplace/mine/publisher", {
      body: { displayName: `${marker} Labs` },
    }),
  );
  // Left pending: nobody but its owner and the reviewers may see it.
  const { listing } = await ok(
    "listing",
    target.call(owner, "POST", "/api/marketplace/mine/listings", {
      body: {
        agentId: agent.id,
        title: `${marker} listing`,
        summary: `${marker} summary`,
        category: "productivity",
        tags: [],
        description: `${marker} description`,
        confirmedNoPrivateData: true,
      },
    }),
  );

  const routineId = `routine-${marker.toLowerCase()}`;
  await target.database.insert(routines).values({
    id: routineId,
    ownerUserId: owner.id,
    agentId: agent.id,
    channelId: channel.id,
    instruction: `${marker} routine instruction`,
    cron: "0 9 * * *",
    timezone: "UTC",
    nextRunAt: new Date(Date.now() + 3_600_000),
  });
  const voiceSessionId = `voice-${marker.toLowerCase()}`;
  await target.database.insert(voiceSessions).values({
    id: voiceSessionId,
    channelId: channel.id,
    userId: owner.id,
    startedAt: new Date(),
    endedAt: new Date(),
    durationSeconds: 3,
    transcript: { entries: [{ role: "user", text: `${marker} voice` }] },
  });

  return {
    marker,
    agentId: agent.id,
    channelId: channel.id,
    threadId: channel.threadId,
    attachmentId: attachment.id,
    connectionId: connection.id,
    skillSlug,
    routineId,
    voiceSessionId,
    listingId: listing.id,
    listingSlug: listing.slug,
    publisherId: publisher.id,
  };
}
