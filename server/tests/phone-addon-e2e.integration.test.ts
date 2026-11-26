/**
 * The phone add-on end to end (#109, v0.1.49; Amgad, 19 Nov: "verify it end to end").
 *
 * Real, on this machine: the check-in service (infra/blackark-checkin/checkin: buy/, stripe/,
 * phone/) on PHP's built-in server with a throwaway config, the phone relay (infra/phone-relay)
 * billing against it with its shared secret, and this install's phone line connected to the relay.
 * Stand-ins: Stripe's API (a checkout page) and Stripe's signed webhooks; Twilio's signed webhooks,
 * its media socket and its REST API; the speech service. A "minute" of the relay's metering is
 * 300 ms; what is charged is what Twilio reports, in real seconds.
 *
 * Needs php 8 with pdo_sqlite and sodium (as infra/blackark-checkin/test.sh); skipped without it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import {
  createRelay,
  type Line,
  sha256Hex,
  twilioSignature,
} from "../../infra/phone-relay/relay";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agentPreferences,
  agentProfiles,
  agents,
  phoneCalls,
  phoneLine,
  users,
} from "../src/db/schema";
import type { SpeechSocket } from "../src/phone-line/bridge";
import { createPhoneLineService } from "../src/phone-line/service";
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
const encryptionKey = Buffer.alloc(32, 9).toString("base64");
const userId = `phone-e2e-${randomUUID()}`;
const CUSTOMER = "demo-phone";
const RELAY_SECRET = "relay-secret-for-the-e2e-0123456789abcdef";
const WEBHOOK_SECRET = "whsec_phone_end_to_end";
const accountSid = `AC${"2".repeat(32)}`;
const authToken = "phone-e2e-auth-token";
const lineToken = "phone-e2e-line-token";
const callId = (n: number) => `CA${n.toString(16).padStart(32, "0")}`;
const line: Line = {
  name: "demo-phone",
  number: "+302105550000",
  tokenSha256: sha256Hex(lineToken),
  fallback: "+306905550000",
  customerId: CUSTOMER,
};

let work = "";
let checkin = "";
let php8: ReturnType<typeof spawn> | null = null;
let agentId = "";
const stops: (() => void | Promise<void>)[] = [];

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

const until = async (check: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await Bun.sleep(20);
  }
  expect(await check()).toBe(true);
};

/** Stripe's API, for the buy page: every checkout it is asked for, answered with a checkout page. */
const checkouts: string[] = [];
const stripeApi = Bun.serve({
  port: 0,
  async fetch(request) {
    checkouts.push(await request.text());
    return Response.json({
      id: `cs_test_${checkouts.length}`,
      url: `https://checkout.stripe.com/c/pay/cs_test_${checkouts.length}`,
    });
  },
});
stops.push(() => void stripeApi.stop(true));

/** Stripe's webhook: the event, signed with the webhook secret over "<t>.<body>". */
async function stripeSends(event: Record<string, unknown>): Promise<number> {
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", WEBHOOK_SECRET)
    .update(`${t}.${body}`)
    .digest("hex");
  const response = await fetch(`${checkin}/stripe/`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": `t=${t},v1=${v1}`,
    },
    body,
  });
  return response.status;
}

/** The balance on blackark.uk, asked the way the relay asks. */
async function balanceOnBlackArk(): Promise<number> {
  const body = JSON.stringify({ action: "balance", customerId: CUSTOMER });
  const time = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", RELAY_SECRET)
    .update(`${time}.${body}`)
    .digest("hex");
  const response = await fetch(`${checkin}/phone/`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ark-time": time,
      "x-ark-signature": signature,
    },
    body,
  });
  return ((await response.json()) as { balanceMils: number }).balanceMils;
}

/**
 * A buy link as blackark.uk signs it for a proven install (buy/link/, v0.1.57): the customer id, when
 * it runs out, and an HMAC of both with `buy_link_secret`.
 */
const BUY_LINK_SECRET = "buy-link-secret-for-tests-0123456789abcdef";
function signedBuyQuery(customer: string): string {
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const token = createHmac("sha256", BUY_LINK_SECRET)
    .update(`buy|${customer}|${expires}`)
    .digest("base64url");
  return `customer=${encodeURIComponent(customer)}&e=${expires}&t=${token}`;
}

/** The buy page, as the customer's browser opens it: where it sends them. */
async function openBuyPage(query: string): Promise<string> {
  const response = await fetch(`${checkin}/buy/?${query}`, {
    redirect: "manual",
  });
  expect(response.status).toBe(303);
  return response.headers.get("location") ?? "";
}

/** The relay, billing against the real phone/; Twilio's REST API is a stand-in that keeps calls. */
const twilioApi: string[] = [];
let relayBase = "";
const relay = createRelay({
  accountSid,
  authToken,
  get publicBaseUrl() {
    return relayBase;
  },
  lines: () => [line],
  billing: {
    get url() {
      return `${checkin}/phone/`;
    },
    secret: RELAY_SECRET,
    minuteMs: 300,
    marginMs: 100,
    refreshMs: 200,
  },
  fetch: (async (url: string, init: RequestInit) => {
    if (url.startsWith(checkin)) return fetch(url, init);
    twilioApi.push(decodeURIComponent(String(init.body)));
    return new Response("{}");
  }) as typeof fetch,
  log: () => undefined,
  alert: async () => undefined,
});
const relayServer = Bun.serve({
  port: 0,
  fetch: relay.fetch,
  websocket: relay.websocket,
});
relayBase = `http://localhost:${relayServer.port}`;
stops.push(() => void relayServer.stop(true));

/** Twilio's signed webhooks to the relay. */
function twilioPosts(path: string, params: Record<string, string>) {
  return fetch(`${relayBase}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": twilioSignature(
        authToken,
        `${relayBase}${path}`,
        params,
      ),
    },
    body: new URLSearchParams(params).toString(),
  });
}
const ring = (n: number) =>
  twilioPosts("/twilio/voice", {
    AccountSid: accountSid,
    CallSid: callId(n),
    From: "+306912345678",
    To: line.number,
  }).then((response) => response.text());
const hangUp = (n: number, seconds: number) =>
  twilioPosts("/twilio/status", {
    AccountSid: accountSid,
    CallSid: callId(n),
    CallStatus: "completed",
    CallDuration: String(seconds),
    To: line.number,
  });

/** A speech service that opens and records, so the employee "answers". */
const speechSockets: (SpeechSocket & { sent: Record<string, unknown>[] })[] =
  [];
function connectSpeech() {
  const socket = {
    sent: [] as Record<string, unknown>[],
    onopen: null as (() => void) | null,
    onmessage: null as ((event: { data: unknown }) => void) | null,
    onclose: null as (() => void) | null,
    onerror: null as (() => void) | null,
    send(data: string) {
      socket.sent.push(JSON.parse(data));
    },
    close() {
      socket.onclose?.();
    },
  };
  speechSockets.push(socket);
  queueMicrotask(() => socket.onopen?.());
  return socket;
}

const service = createPhoneLineService(database, {
  credentials: createCredentialStore(database),
  encryptionKey,
  auditStore: { insert: async () => undefined },
  employee: async (owner, id) =>
    owner === userId && id === agentId
      ? { name: "Υποδοχή", title: "Front Desk", instruction: "Be brief." }
      : null,
  business: async () => "Demo Phone",
  blockAmka: async () => true,
  allowed: async () => true,
  connectSpeech,
  allowInsecureRelay: true,
});
stops.push(() => service.stop());

beforeAll(async () => {
  if (!havePhp) return;
  work = mkdtempSync(join(tmpdir(), "ark-phone-e2e-"));
  cpSync(
    resolve(import.meta.dir, "../../infra/blackark-checkin/checkin"),
    join(work, "checkin"),
    { recursive: true },
  );
  const port = await freePort();
  checkin = `http://127.0.0.1:${port}/checkin`;
  writeFileSync(
    join(work, "checkin/config.php"),
    `<?php
return [
  'data_dir' => __DIR__ . '/data',
  'trial_public_keys' => [],
  'stripe_webhook_secret' => '${WEBHOOK_SECRET}',
  'stripe_prices' => ['price_team' => ['plan' => 'team', 'seats' => 1, 'max_agents' => 5], 'price_phone' => ['addon' => 'phone']],
  'stripe_buy' => ['tiers' => [5 => 'price_team'], 'phone' => 'price_phone', 'block' => 'price_block5h'],
  'stripe_api_key' => 'rk_test_fake',
  'stripe_api_base' => 'http://127.0.0.1:${stripeApi.port}',
  'public_base_url' => '${checkin}',
  'buy_url' => 'https://blackark.example/checkin/buy/',
  'relay_secret' => '${RELAY_SECRET}',
  'buy_link_secret' => '${BUY_LINK_SECRET}',
];
`,
  );
  php8 = spawn("php", ["-S", `127.0.0.1:${port}`, "-t", work], {
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    if (
      await fetch(`${checkin}/phone/`).then(
        () => true,
        () => false,
      )
    )
      break;
    await Bun.sleep(50);
  }
  await database
    .insert(users)
    .values({ id: userId, email: `${userId}@example.test`, name: "Admin" });
  agentId = (
    await createAgentProfileStore(database, undefined).create(
      { id: userId, role: "admin" },
      {
        name: "Υποδοχή",
        title: "Front Desk",
        roleDescription: "Answers the phone.",
        visibility: "private",
        systemPrompt: "Be brief.",
      },
    )
  ).id;
});

afterAll(async () => {
  for (const stop of stops.splice(0)) await stop();
  php8?.kill();
  if (work) rmSync(work, { recursive: true, force: true });
  await database.delete(phoneCalls);
  await database.delete(phoneLine);
  if (agentId) {
    await database
      .delete(agentPreferences)
      .where(eq(agentPreferences.agentId, agentId));
    await database
      .delete(agentProfiles)
      .where(eq(agentProfiles.agentId, agentId));
    await database.delete(agents).where(eq(agents.id, agentId));
  }
  await database.delete(users).where(eq(users.id, userId));
  await database.$client.close();
});

describe.skipIf(!havePhp)("the phone add-on end to end (#109, v0.1.49)", () => {
  test("buy, answer, charge, the last hour, busy at zero, top up", async () => {
    // 1. The customer buys the plan with the phone add-on: the buy page opens Stripe's checkout
    //    with the first 5-hour block, and Stripe's "paid" credits it: EUR 23.40.
    expect(
      await openBuyPage(`${signedBuyQuery(CUSTOMER)}&tier=5&phone=1`),
    ).toStartWith("https://checkout.stripe.com/");
    expect(decodeURIComponent(checkouts.at(-1) ?? "")).toContain(
      "line_items[2][price]=price_block5h",
    );
    expect(
      await stripeSends({
        id: "evt_phone_checkout",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_test_phonefirst01",
            client_reference_id: CUSTOMER,
            customer: "cus_phone",
            subscription: "sub_phone",
            payment_status: "paid",
            metadata: { kind: "subscription", phone_blocks: "1" },
          },
        },
      }),
    ).toBe(200);
    expect(await balanceOnBlackArk()).toBe(23_400);

    // 2. The install's phone line connects to the relay and hears the balance.
    service.start();
    await service.save(userId, {
      relayUrl: relayBase,
      lineToken,
      speechKey: "sk-test-speech",
      agentId,
      speechModel: "gpt-realtime",
      voice: "marin",
      greeting: "Demo Phone, καλημέρα σας.",
      hours: null,
      enabled: true,
    });
    await until(async () => (await service.settings())?.status === "connected");
    await until(
      async () => (await service.settings())?.balance?.balanceMils === 23_400,
    );
    expect((await service.settings())?.balance).toMatchObject({
      state: "ok",
      topUpUrl: `https://blackark.example/checkin/buy/?topup=1&customer=${CUSTOMER}`,
    });

    // 3. A call is answered by the employee, over Twilio's media socket.
    const twiml = await ring(1);
    expect(twiml).toContain("<Connect><Stream");
    const key = /name="key" value="([^"]+)"/.exec(twiml)?.[1] ?? "";
    const media = new WebSocket(
      `ws://localhost:${relayServer.port}/twilio/media`,
    );
    await new Promise((done) => {
      media.onopen = done;
    });
    media.send(
      JSON.stringify({
        event: "start",
        start: {
          callSid: callId(1),
          streamSid: "MZ1",
          customParameters: { key },
        },
      }),
    );
    await until(() => speechSockets.length === 1);
    // 4. Charged per part when Twilio says it ended: 75 s incoming is 2 minutes at 0.078.
    expect((await hangUp(1, 75)).status).toBe(204);
    media.close();
    await until(async () => (await balanceOnBlackArk()) === 23_400 - 156);
    // 5. The balance falls in the app too.
    await until(
      async () =>
        (await service.settings())?.balance?.balanceMils === 23_400 - 156,
    );

    // 6. A long call leaves less than an hour: the app is told it is the last hour.
    expect(await ring(2)).toContain("<Connect>");
    await hangUp(2, 230 * 60); // 230 minutes incoming: 17,940 mils
    await until(
      async () => (await service.settings())?.balance?.state === "low",
    );
    expect((await service.settings())?.balance).toMatchObject({
      balanceMils: 23_400 - 156 - 17_940,
      state: "low",
    });

    // 7. Used up: the balance stops at zero, and the next call hears busy (not answered).
    expect(await ring(3)).toContain("<Connect>");
    await hangUp(3, 120 * 60);
    await until(async () => (await balanceOnBlackArk()) === 0);
    await until(
      async () => (await service.settings())?.balance?.state === "empty",
    );
    expect(await ring(4)).toContain('<Reject reason="busy"/>');

    // 8. Topping up: the buy page opens a one-off checkout for one block; Stripe's "paid"
    //    credits it, and the next call is answered again.
    expect(await openBuyPage(`customer=${CUSTOMER}&topup=1`)).toStartWith(
      "https://checkout.stripe.com/",
    );
    expect(decodeURIComponent(checkouts.at(-1) ?? "")).toContain(
      "mode=payment",
    );
    expect(
      await stripeSends({
        id: "evt_phone_topup",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_test_phonetopup01",
            client_reference_id: CUSTOMER,
            payment_status: "paid",
            metadata: { kind: "phone_topup", phone_blocks: "1" },
          },
        },
      }),
    ).toBe(200);
    expect(await balanceOnBlackArk()).toBe(23_400);
    // The app hears it before any call comes in, and the next call is answered.
    await until(
      async () => (await service.settings())?.balance?.balanceMils === 23_400,
    );
    expect((await service.settings())?.balance?.state).toBe("ok");
    expect(await ring(5)).toContain("<Connect>");
    await hangUp(5, 0);
  }, 30_000);
});
