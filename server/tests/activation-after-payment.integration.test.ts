/**
 * End to end (#109, v0.1.49; Amgad, 19 Nov: "the customer pays, and the activation code immediately
 * reaches the app and unlocks it, with no manual step").
 *
 * The real blackark.uk check-in service (infra/blackark-checkin/checkin, on PHP's built-in server
 * with a throwaway config and throwaway keys), a stand-in for Stripe that sends signed webhook
 * events to its real `stripe/`, and this server's activation service and `/api/activation` routes,
 * asking the real `renew/` on their own schedule. Nothing is typed.
 *
 * Needs php 8 with pdo_sqlite and sodium (as infra/blackark-checkin/test.sh); skipped without it.
 */

import { Database } from "bun:sqlite";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createHmac, generateKeyPairSync, type KeyObject } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Hono, type MiddlewareHandler } from "hono";
import {
  encodeBase64Url,
  PROFILE_FORMAT,
  readProfile,
} from "../../shared/trial";
import { publicKeyToBase64, signText } from "../../shared/trial-sign";
import type { Entitlement } from "../src/accounts/store";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import {
  activationState,
  supportInstall,
  trialCheckIns,
  trialCodes,
  trialRoster,
  trialState,
} from "../src/db/schema";
import { createActivationService } from "../src/trial/activation";
import { activationRoutes } from "../src/trial/routes";
import { createTrialService } from "../src/trial/service";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const php = spawnSync(
  "php",
  [
    "-r",
    "echo function_exists('sodium_crypto_sign_detached') && extension_loaded('pdo_sqlite') ? 'ok' : 'no';",
  ],
  { encoding: "utf8" },
);
const havePhp = php.stdout === "ok";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const trialKey = generateKeyPairSync("ed25519");
const licenseKey = generateKeyPairSync("ed25519");
const stranger = generateKeyPairSync("ed25519");
/** blackark.uk's self-serve trial key (v0.1.58). */
const selfServeKey = generateKeyPairSync("ed25519");
const WEBHOOK_SECRET = "whsec_end_to_end";
/** renew/index.php exactly as it was before v0.1.49 asked for proof. */
const RENEW_TODAY = `<?php
declare(strict_types=1);
define('ARK_CHECKIN', true);
require dirname(__DIR__) . '/lib.php';
header('Content-Type: application/json; charset=utf-8');
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') { http_response_code(405); echo '{}'; exit; }
$body = json_decode((string) file_get_contents('php://input', false, null, 0, 4096), true);
$customer = is_array($body) ? (string) ($body['customerId'] ?? '') : '';
$has = is_array($body) ? strtotime((string) ($body['validUntil'] ?? '')) : false;
if (preg_match('/^[a-z0-9][a-z0-9-]{1,63}$/', $customer) !== 1 || $has === false) { http_response_code(400); echo '{}'; exit; }
$find = ark_db()->prepare("SELECT license_key, valid_until FROM licenses WHERE customer_id = ? AND status = 'active' AND license_key IS NOT NULL ORDER BY valid_until DESC LIMIT 1");
$find->execute([$customer]);
$row = $find->fetch();
if ($row && strtotime((string) $row['valid_until']) > $has) { echo json_encode(['key' => $row['license_key']], JSON_UNESCAPED_SLASHES); exit; }
echo '{}';
`;

let base = "";
let work = "";
let server: ReturnType<typeof spawn> | null = null;

async function freePort(): Promise<number> {
  return new Promise((done) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() =>
        done(typeof address === "object" && address ? address.port : 0),
      );
    });
  });
}

/** The licence key pair as license-keygen makes it: a 64-byte sodium secret and the 32-byte public. */
function sodiumSecret(key: { privateKey: KeyObject; publicKey: KeyObject }) {
  const jwk = key.privateKey.export({ format: "jwk" }) as {
    d: string;
    x: string;
  };
  return Buffer.concat([
    Buffer.from(jwk.d, "base64url"),
    Buffer.from(jwk.x, "base64url"),
  ]).toString("base64");
}

async function clear() {
  // A new computer each test: its own install id too (blackark.uk counts one trial per computer).
  await database.delete(supportInstall);
  await database.delete(activationState);
  await database.delete(trialState);
  await database.delete(trialRoster);
  await database.delete(trialCodes);
  await database.delete(trialCheckIns);
}

beforeAll(async () => {
  if (!havePhp) return;
  work = mkdtempSync(join(tmpdir(), "ark-activation-e2e-"));
  cpSync(
    resolve(import.meta.dir, "../../infra/blackark-checkin/checkin"),
    join(work, "checkin"),
    { recursive: true },
  );
  // renew/ as it is on blackark.uk today (v0.1.44 to v0.1.48), before it asks for proof: the app
  // must work against it until COO uploads the new one.
  mkdirSync(join(work, "checkin/renew-today"));
  mkdirSync(join(work, "outbox"));
  writeFileSync(join(work, "checkin/renew-today/index.php"), RENEW_TODAY);
  const port = await freePort();
  base = `http://127.0.0.1:${port}/checkin`;
  writeFileSync(
    join(work, "checkin/config.php"),
    `<?php
return [
  'data_dir' => __DIR__ . '/data',
  'trial_public_keys' => ['${publicKeyToBase64(trialKey.publicKey)}'],
  'license_secret_key' => '${sodiumSecret(licenseKey)}',
  'license_public_key' => '${publicKeyToBase64(licenseKey.publicKey)}',
  'license_grace_days' => 7,
  'stripe_webhook_secret' => '${WEBHOOK_SECRET}',
  'stripe_prices' => ['price_team' => ['plan' => 'team', 'seats' => 1]],
  'public_base_url' => '${base}',
  'buy_link_secret' => 'buy-link-secret-for-tests-0123456789abcdef',
  'selfserve_trial_secret_key' => '${sodiumSecret(selfServeKey)}',
  'mail_outbox_dir' => '${join(work, "outbox")}',
];
`,
  );
  server = spawn("php", ["-S", `127.0.0.1:${port}`, "-t", work], {
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    const ok = await fetch(`${base}/renew/`).then(
      () => true,
      () => false,
    );
    if (ok) break;
    await Bun.sleep(50);
  }
});

beforeEach(clear);
afterAll(async () => {
  server?.kill();
  if (work) rmSync(work, { recursive: true, force: true });
  await clear();
  await database.$client.close();
});

/** What Stripe would send: the event, signed with the webhook secret over "<t>.<body>". */
async function stripeSends(event: Record<string, unknown>): Promise<number> {
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", WEBHOOK_SECRET)
    .update(`${t}.${body}`)
    .digest("hex");
  const response = await fetch(`${base}/stripe/`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": `t=${t},v1=${v1}`,
    },
    body,
  });
  return response.status;
}

/** A paid subscription for this customer, as the buy page's checkout ends: both events. */
async function customerPays(customer: string, periodEnd: Date) {
  const end = Math.floor(periodEnd.getTime() / 1000);
  const sub = `sub_${customer.replace(/-/g, "")}`;
  expect(
    await stripeSends({
      id: `evt_cs_${customer}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_test_${customer.replace(/-/g, "")}session`,
          client_reference_id: customer,
          customer: "cus_1",
          subscription: sub,
        },
      },
    }),
  ).toBe(200);
  expect(
    await stripeSends({
      id: `evt_in_${customer}`,
      type: "invoice.paid",
      data: {
        object: {
          subscription: sub,
          lines: {
            data: [
              { price: { id: "price_team" }, quantity: 1, period: { end } },
            ],
          },
        },
      },
    }),
  ).toBe(200);
}

function profileFile(customer: string, key: KeyObject = trialKey.privateKey) {
  const profile = readProfile({
    v: 1,
    customer: { id: customer, name: customer },
    issuedAt: "2026-11-15T10:00:00Z",
    startsAt: "2026-11-16T00:00:00Z",
    endsAt: "2026-12-16T00:00:00Z",
    plan: "team",
    createBlocked: true,
    roster: [],
  });
  const encoded = encodeBase64Url(JSON.stringify(profile));
  return JSON.stringify({
    format: PROFILE_FORMAT,
    profile: encoded,
    signature: signText(key, encoded),
  });
}

const internal: Entitlement = {
  tenantId: "t",
  planId: "internal",
  planName: "Internal",
  subscriptionStatus: "active",
  maxActiveBots: null,
  canRun: true,
};

/** This server's side: the services as index.ts builds them, and the routes the app calls. */
function desktop(
  start: string,
  trustedTrialKey: KeyObject = trialKey.publicKey,
  renewPath = "renew",
  buyPath = "buy",
) {
  let clock = new Date(start);
  const now = () => clock;
  const offline = (async () =>
    new Response(null, { status: 204 })) as unknown as typeof fetch;
  const trial = createTrialService(database, {
    keys: [trustedTrialKey],
    version: "0.1.49",
    now,
    fetch: offline,
  });
  const activation = createActivationService(database, {
    required: true,
    trialKeys: [trustedTrialKey],
    licenseKeys: [licenseKey.publicKey],
    selfServeKeys: [selfServeKey.publicKey],
    trial,
    version: "0.1.49",
    now,
    licenseUrl: `${base}/${renewPath}/`,
    buyUrl: `${base}/${buyPath}/`,
    tickMs: 25,
  });
  const signedIn: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: "owner",
      role: "admin",
    } as AppVariables["actor"]);
    await next();
  };
  const app = new Hono().route(
    "/api/activation",
    activationRoutes(signedIn, activation),
  );
  const call = async (path: string, init?: RequestInit) =>
    (
      await app.request(`/api/activation${path === "/" ? "" : path}`, init)
    ).json() as Promise<Record<string, unknown>>;
  return {
    trial,
    activation,
    view: async () => (await call("/")).activation as Record<string, unknown>,
    openBuyPage: () => call("/buying", { method: "POST" }),
    startTrial: (body: Record<string, unknown>) =>
      app.request("/api/activation/trial/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    confirmTrial: (body: Record<string, unknown>) =>
      app.request("/api/activation/trial/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

async function until(check: () => Promise<boolean>, ms = 5_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await Bun.sleep(25);
  }
  return false;
}

/** The text of the email blackark.uk sent last (written to the test outbox instead of being sent). */
function lastMail(): string {
  const dir = join(work, "outbox");
  const file = readdirSync(dir)
    .filter((name) => name.startsWith("trial-"))
    .map((name) => ({ name, at: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at)[0]?.name;
  if (!file) return "";
  const message = readFileSync(join(dir, file), "utf8");
  const plain = message.split(/text\/plain[^\n]*\n[^\n]*\n\r?\n/)[1] ?? "";
  return Buffer.from(
    plain.split("--ark-")[0]?.replace(/\s+/g, "") ?? "",
    "base64",
  ).toString("utf8");
}

/** The 6-digit code in the email blackark.uk sent last. */
function mailedCode(): string {
  return lastMail().match(/\b\d{6}\b/)?.[0] ?? "";
}

describe.skipIf(!havePhp)(
  "the whole journey with nothing typed but an email and its code (v0.1.58)",
  () => {
    test("a new computer: a self-serve trial by email, then a signed buy link, then paid", async () => {
      // blackark.uk signs with the real clock, so this install's clock is the real one too.
      const install = desktop(new Date().toISOString());
      expect(await install.view()).toMatchObject({
        state: "none",
        allowed: false,
        selfServeTrial: true,
      });
      const started = await install.startTrial({
        name: "Μαρία",
        company: "Οινοποιείο Λάμπρου",
        email: "Maria@Lambrou.example",
        language: "el",
      });
      expect(started.status).toBe(202);
      const code = mailedCode();
      expect(code).toMatch(/^\d{6}$/);
      // A wrong code first: refused, and nothing changes.
      const wrong = await install.confirmTrial({
        email: "maria@lambrou.example",
        code: code === "000000" ? "111111" : "000000",
      });
      expect(wrong.status).toBe(400);
      const confirmed = await install.confirmTrial({
        email: "maria@lambrou.example",
        code,
      });
      expect(confirmed.status).toBe(200);
      const view = await install.view();
      expect(view).toMatchObject({
        state: "trial",
        allowed: true,
        source: "trial-code",
        planId: "team",
        selfServeTrial: false,
      });
      // Seven days from when blackark.uk signed it, to the minute.
      expect(
        Math.abs(
          Date.parse(String(view.until)) - (Date.now() + 7 * 86_400_000),
        ),
      ).toBeLessThan(60_000);
      expect(String(view.customerId)).toMatch(/^oinopoieio-lamprou-[a-z0-9]+$/);

      // Buying needs nothing more: the self-serve trial is the proof for a signed link.
      const opened = await install.openBuyPage();
      expect(String(opened.buyUrl)).toContain(`customer=${view.customerId}&e=`);
      await customerPays(
        String(view.customerId),
        new Date(Date.now() + 30 * 86_400_000),
      );
      expect(await install.activation.fetchKey()).toBe("activated");
      expect(await install.view()).toMatchObject({
        state: "paid",
        source: "license",
      });
    });

    test("one free trial per email: a second computer with the same address gets no code", async () => {
      const install = desktop("2026-11-26T12:00:00Z");
      // A minute later, as blackark.uk waits that long between two codes to one address.
      const data = new Database(join(work, "checkin/data/checkins.sqlite"));
      data.run("UPDATE selfserve_pending SET sent_at = sent_at - 120");
      data.close();
      const again = await install.startTrial({
        name: "Maria",
        company: "Lambrou",
        email: "maria@lambrou.example",
        language: "en",
      });
      // The same answer as for a new trial, so nobody learns from it who had one; the email says.
      expect(again.status).toBe(202);
      expect(lastMail()).toContain("already used");
      expect(mailedCode()).toBe("");
    });

    test("a self-serve code cannot be typed into the code box: only the trial's own steps apply it", async () => {
      const install = desktop(new Date().toISOString());
      const payload = encodeBase64Url(
        JSON.stringify({
          v: 1,
          action: "trial",
          customer: "demo-typed",
          nonce: "nonce-typed-1",
          issuedAt: new Date().toISOString(),
          until: new Date(Date.now() + 7 * 86_400_000).toISOString(),
          plan: "team",
        }),
      );
      const typed = `ARK1-${payload}.${signText(selfServeKey.privateKey, payload)}`;
      await expect(install.activation.apply(typed)).rejects.toThrow(
        "not signed by BlackArk",
      );
    });

    test("a self-serve key cannot stand for more than a 7-day Ark Team trial", async () => {
      const install = desktop("2026-11-26T12:00:00Z");
      const payload = encodeBase64Url(
        JSON.stringify({
          v: 1,
          action: "trial",
          customer: "demo-long",
          nonce: "nonce-long-1",
          issuedAt: "2026-11-26T00:00:00Z",
          until: "2027-03-01T00:00:00Z",
          plan: "team",
        }),
      );
      const typed = `ARK1-${payload}.${signText(selfServeKey.privateKey, payload)}`;
      await expect(install.activation.apply(typed)).rejects.toThrow(
        "not signed by BlackArk",
      );
    });
  },
);

describe.skipIf(!havePhp)(
  "a payment reaches the app with nothing typed (#109, v0.1.49)",
  () => {
    test("a trial install whose trial ended becomes paid once Stripe says paid", async () => {
      const install = desktop("2026-12-16T00:00:01Z");
      await install.trial.importProfile(profileFile("demo-shop"));
      expect(await install.view()).toMatchObject({
        allowed: false,
        state: "ended",
      });
      expect((await install.activation.entitlement(internal)).canRun).toBe(
        false,
      );

      // The buy button: the page for this customer, signed by blackark.uk after it checked this
      // install's proof (v0.1.57), and the app starts asking often.
      const opened = await install.openBuyPage();
      expect(opened.buyUrl).toMatch(
        new RegExp(
          `^${base.replace(/[.]/g, "\\.")}/buy/\\?customer=demo-shop&e=\\d+&t=[A-Za-z0-9_-]{43}$`,
        ),
      );
      // And blackark.uk opens a checkout with it (no Stripe key here, so it stops before Stripe).
      const page = await fetch(String(opened.buyUrl), { redirect: "manual" });
      expect(page.status).not.toBe(403);
      const stop = install.activation.startKeyFetch();
      try {
        // Asked at once; nothing paid yet.
        expect(
          await until(async () => (await install.view()).lastRenewAt !== null),
        ).toBe(true);
        await Bun.sleep(100);
        expect((await install.view()).state).toBe("ended");

        await customerPays("demo-shop", new Date("2027-01-16T00:00:00Z"));
        install.advance(20_000);
        expect(
          await until(async () => (await install.view()).state === "paid"),
        ).toBe(true);
      } finally {
        stop();
      }
      expect(await install.view()).toMatchObject({
        allowed: true,
        state: "paid",
        source: "license",
        until: "2027-01-23T00:00:00.000Z",
        paymentReceivedAt: "2026-12-16T00:00:21.000Z",
        buyUrl: null,
      });
      expect(await install.activation.entitlement(internal)).toMatchObject({
        canRun: true,
        subscriptionStatus: "active",
      });
      expect(await install.activation.createBlocked()).toBe(false);
    });

    test("a running trial is unlocked too, and the next renewal still works with the fetched key as proof", async () => {
      const install = desktop("2026-11-20T09:00:00Z");
      await install.trial.importProfile(profileFile("demo-cafe"));
      await customerPays("demo-cafe", new Date("2026-12-20T00:00:00Z"));
      const fetched = await install.activation.fetchKey();
      expect(fetched).toBe("activated");
      expect(await install.view()).toMatchObject({
        state: "paid",
        source: "license",
      });
      // The next month: Stripe pays again, and the licence key in hand is the proof.
      await stripeSends({
        id: "evt_in_demo-cafe-2",
        type: "invoice.paid",
        data: {
          object: {
            subscription: "sub_democafe",
            lines: {
              data: [
                {
                  price: { id: "price_team" },
                  quantity: 1,
                  period: {
                    end: Math.floor(Date.parse("2027-01-20T00:00:00Z") / 1000),
                  },
                },
              ],
            },
          },
        },
      });
      expect(await install.activation.renew()).toBe("renewed");
      expect((await install.view()).until).toBe("2027-01-27T00:00:00.000Z");
    });

    test("the buy button falls back to the unsigned link while blackark.uk has no buy/link/ page", async () => {
      const install = desktop(
        "2026-12-16T00:00:01Z",
        trialKey.publicKey,
        "renew",
        "buy-before-0157",
      );
      await install.trial.importProfile(profileFile("demo-shop"));
      expect((await install.openBuyPage()).buyUrl).toBe(
        `${base}/buy-before-0157/?customer=demo-shop`,
      );
    });

    test("an install whose proof blackark.uk does not trust gets no signed buy link", async () => {
      const install = desktop("2026-12-16T00:00:01Z", stranger.publicKey);
      await install.trial.importProfile(
        profileFile("demo-shop", stranger.privateKey),
      );
      expect((await install.openBuyPage()).buyUrl).toBe(
        `${base}/buy/?customer=demo-shop`,
      );
    });

    test("a proof blackark.uk does not trust is refused, and nothing unlocks", async () => {
      // An install whose setup file is signed with a key blackark.uk does not know.
      const install = desktop("2026-12-16T00:00:01Z", stranger.publicKey);
      await install.trial.importProfile(
        profileFile("demo-shop", stranger.privateKey),
      );
      await customerPays("demo-shop", new Date("2027-01-16T00:00:00Z"));
      expect(await install.activation.fetchKey()).toBe("failed");
      expect(await install.view()).toMatchObject({
        allowed: false,
        state: "ended",
        lastRenewError: "The renewal was refused (403).",
      });
    });

    test("one customer's install cannot fetch another customer's key", async () => {
      await customerPays("demo-shop", new Date("2027-01-16T00:00:00Z"));
      const install = desktop("2026-12-16T00:00:01Z");
      await install.trial.importProfile(profileFile("demo-clinic"));
      // Its own customer has not paid: nothing comes back, and it stays blocked.
      expect(await install.activation.fetchKey()).toBe("unchanged");
      expect((await install.view()).state).toBe("ended");
      // Asking for demo-shop's key with demo-clinic's proof is refused by blackark.uk.
      const [row] = await database.select().from(trialState).limit(1);
      const response = await fetch(`${base}/renew/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          customerId: "demo-shop",
          installId: row?.installId,
          version: "0.1.49",
          validUntil: null,
          proof: {
            kind: "profile",
            profile: row?.profile,
            signature: row?.signature,
          },
        }),
      });
      expect(response.status).toBe(403);
    });
  },
);

describe.skipIf(!havePhp)(
  "against today's renew/ on blackark.uk (#109, v0.1.49)",
  () => {
    test("a trial install still gets its key: the extra fields are ignored", async () => {
      await customerPays("demo-shop", new Date("2027-01-16T00:00:00Z"));
      const install = desktop(
        "2026-12-16T00:00:01Z",
        trialKey.publicKey,
        "renew-today",
      );
      await install.trial.importProfile(profileFile("demo-shop"));
      expect(await install.activation.fetchKey()).toBe("activated");
      expect(await install.view()).toMatchObject({
        allowed: true,
        state: "paid",
        source: "license",
      });
    });
  },
);
