import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { Hono } from "hono";
import {
  encodeBase64Url,
  PROFILE_FORMAT,
  readProfile,
} from "../../shared/trial";
import { signText } from "../../shared/trial-sign";
import { createDatabase } from "../src/db/client";
import {
  activationState,
  supportInstall,
  supportRequests,
  trialRoster,
  trialState,
} from "../src/db/schema";
import { supportRoutes } from "../src/support/routes";
import { recentLogs } from "../src/support/scrub";
import { createSupportService } from "../src/support/service";
import { createTrialService } from "../src/trial/service";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const blackArk = generateKeyPairSync("ed25519");
const NOW = new Date("2026-11-18T10:00:00Z");

async function clear() {
  await database.delete(supportRequests);
  await database.delete(trialState);
  await database.delete(trialRoster);
  await database.delete(activationState);
  await database.delete(supportInstall);
}
beforeEach(clear);
afterAll(async () => {
  await clear();
  await database.$client.close();
});

async function importTrial() {
  const profile = readProfile({
    v: 1,
    customer: { id: "demo-shop", name: "Demo Shop" },
    issuedAt: "2026-11-15T10:00:00Z",
    startsAt: "2026-11-16T00:00:00Z",
    endsAt: "2026-12-16T00:00:00Z",
    plan: "team",
    createBlocked: true,
    roster: [
      {
        key: "front-desk",
        name: "Front Desk",
        title: "Front Desk",
        roleDescription: "Answers enquiries.",
        instructions: "Draft every reply for approval.",
      },
    ],
  });
  const encoded = encodeBase64Url(JSON.stringify(profile));
  await createTrialService(database, {
    keys: [blackArk.publicKey],
    version: "0.1.49",
    now: () => NOW,
  }).importProfile(
    JSON.stringify({
      format: PROFILE_FORMAT,
      profile: encoded,
      signature: signText(blackArk.privateKey, encoded),
    }),
  );
  const [row] = await database.select().from(trialState);
  return row as typeof trialState.$inferSelect;
}

type Reply = { status: number; body?: unknown } | "unreachable";

function harness(
  replies: Reply[],
  options: { beforeActivation?: boolean } = {},
) {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const logs = recentLogs();
  logs.record(
    "error",
    ["mailbox sign-in refused for maria@shop.example"],
    NOW.getTime() - 60_000,
  );
  const service = createSupportService(database, {
    version: "0.1.49",
    logs,
    url: "https://blackark.example/checkin/support/",
    now: () => NOW,
    system: () => "Windows 10.0.22631 (x64)",
    ...options,
    fetch: (async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)) });
      const reply = replies.shift() ?? { status: 200, body: { case: 1 } };
      if (reply === "unreachable") throw new TypeError("fetch failed");
      return Response.json(reply.body ?? {}, { status: reply.status });
    }) as unknown as typeof fetch,
  });
  return { service, sent };
}

const input = {
  subject: "Το Gmail δεν ανοίγει",
  message: "Μετά την ενημέρωση ζητάει ξανά σύνδεση.",
  urgent: true,
  includeDiagnostics: false,
  language: "el" as const,
};

describe("Help & support (#149)", () => {
  test("without a BlackArk trial or licence on this computer, there is nothing to send with", async () => {
    const { service } = harness([]);
    expect(await service.available()).toBe(false);
    await expect(service.preview("user-1", input)).rejects.toThrow("activated");
  });

  test("before activation, on a desktop install: sent unverified, with no proof, and an address only if given", async () => {
    const { service, sent } = harness([{ status: 200, body: { case: 12 } }], {
      beforeActivation: true,
    });
    expect(await service.available()).toBe(true);
    expect(await service.verified()).toBe(false);
    const preview = await service.preview("user-1", {
      ...input,
      contactEmail: " maria@shop.example ",
    });
    expect(preview).toMatchObject({
      customerId: "unverified",
      proof: null,
      contactEmail: "maria@shop.example",
      diagnostics: null,
    });
    expect(preview.installId).toMatch(/^[0-9a-f-]{36}$/);
    const made = await service.submit(
      "user-1",
      { ...input, contactEmail: "maria@shop.example" },
      preview.requestId,
    );
    expect(made).toMatchObject({ status: "sent", caseNumber: 12 });
    expect(sent[0]?.body).toEqual(preview);
    // The same random id every time, and no address when none is given.
    const again = await service.preview("user-1", {
      ...input,
      contactEmail: "",
    });
    expect(again.installId).toBe(preview.installId);
    expect(again.contactEmail).toBeNull();
  });

  test("once activated, the request names the customer with BlackArk's proof and carries no address", async () => {
    const trial = await importTrial();
    const { service } = harness([], { beforeActivation: true });
    expect(await service.verified()).toBe(true);
    const preview = await service.preview("user-1", {
      ...input,
      contactEmail: "maria@shop.example",
    });
    expect(preview.customerId).toBe("demo-shop");
    expect(preview.installId).toBe(trial.installId);
    expect(preview.proof).not.toBeNull();
    expect("contactEmail" in preview).toBe(false);
  });

  test("the preview is exactly what is sent: the words, the install, and BlackArk's own proof", async () => {
    const trial = await importTrial();
    const { service, sent } = harness([{ status: 200, body: { case: 7 } }]);
    expect(await service.available()).toBe(true);
    const preview = await service.preview("user-1", input);
    expect(Object.keys(preview).sort()).toEqual([
      "appVersion",
      "customerId",
      "diagnostics",
      "installId",
      "language",
      "message",
      "proof",
      "requestId",
      "subject",
      "urgent",
    ]);
    expect(preview).toMatchObject({
      customerId: "demo-shop",
      installId: trial.installId,
      diagnostics: null,
      proof: {
        kind: "profile",
        profile: trial.profile,
        signature: trial.signature,
      },
    });
    const made = await service.submit("user-1", input, preview.requestId);
    expect(made).toMatchObject({
      status: "sent",
      caseNumber: 7,
      id: preview.requestId,
    });
    // Exactly what the person read, the request id included.
    expect(sent[0]?.body).toEqual(preview);
    expect(sent[0]?.url).toBe("https://blackark.example/checkin/support/");
  });

  test("diagnostics only when ticked: version, system and scrubbed recent errors", async () => {
    await importTrial();
    const { service } = harness([]);
    const preview = await service.preview("user-1", {
      ...input,
      includeDiagnostics: true,
    });
    expect(preview.diagnostics).toEqual({
      appVersion: "0.1.49",
      os: "Windows 10.0.22631 (x64)",
      logs: [
        "2026-11-18T09:59:00.000Z error mailbox sign-in refused for [email]",
      ],
    });
  });

  test("when BlackArk cannot be reached it waits, and is sent again with the same id", async () => {
    await importTrial();
    const { service, sent } = harness([
      "unreachable",
      { status: 502, body: { error: "down" } },
      { status: 200, body: { case: 12 } },
    ]);
    const waiting = await service.submit("user-1", input);
    expect(waiting).toMatchObject({ status: "queued", caseNumber: null });
    expect(waiting.lastError).toContain("will be sent again");
    expect(await service.retry()).toBe(0);
    expect(await service.retry()).toBe(1);
    const [row] = await service.list("user-1");
    expect(row).toMatchObject({ status: "sent", caseNumber: 12 });
    expect(new Set(sent.map((one) => one.body.requestId))).toEqual(
      new Set([waiting.id]),
    );
    expect(await service.retry()).toBe(0);
    expect(sent).toHaveLength(3);
  });

  test("a request BlackArk refuses is not sent again", async () => {
    await importTrial();
    const { service, sent } = harness([{ status: 403, body: {} }]);
    expect((await service.submit("user-1", input)).status).toBe("refused");
    await service.retry();
    expect(sent).toHaveLength(1);
  });

  test("a person sees only their own requests; the routes check what is sent", async () => {
    await importTrial();
    const { service } = harness([
      { status: 200, body: { case: 1 } },
      { status: 200, body: { case: 2 } },
    ]);
    await service.submit("user-1", input);
    await service.submit("user-2", { ...input, subject: "Someone else's" });
    expect((await service.list("user-1")).map((one) => one.caseNumber)).toEqual(
      [1],
    );

    const app = new Hono();
    app.route(
      "/api/support",
      supportRoutes(async (context, next) => {
        context.set("actor" as never, { id: "user-1" } as never);
        await next();
      }, service),
    );
    const state = await (await app.request("/api/support")).json();
    expect(state).toMatchObject({ available: true, verified: true });
    expect(state.requests).toHaveLength(1);
    const bad = await app.request("/api/support/requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...input, subject: "" }),
    });
    expect(bad.status).toBe(400);
    const extra = await app.request("/api/support/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...input, conversation: "everything" }),
    });
    expect(extra.status).toBe(400);
    const notAnAddress = await app.request("/api/support/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...input, contactEmail: "maria at shop" }),
    });
    expect(notAnAddress.status).toBe(400);
  });
  test("replies: asked with this install's id and proof, and only those to the person's own requests come back", async () => {
    const trial = await importTrial();
    const board = {
      cases: [
        {
          case: 1,
          subject: "x",
          status: "waiting",
          openedAt: "2026-11-18T09:00:00.000Z",
          replies: [
            {
              at: "2026-11-18T09:30:00.000Z",
              language: "el",
              text: "Δοκιμάστε ξανά.",
              english: "Please try again.",
              author: "maria",
            },
          ],
        },
        { case: 2, status: "open", replies: [] },
        { case: "bad", replies: [] },
      ],
    };
    const { service, sent } = harness([
      { status: 200, body: { case: 1 } },
      { status: 200, body: { case: 2 } },
      { status: 200, body: board },
    ]);
    await service.submit("user-1", input);
    await service.submit("user-2", input);
    expect(await service.replies("user-1")).toEqual([
      {
        case: 1,
        status: "waiting",
        replies: [
          {
            at: "2026-11-18T09:30:00.000Z",
            language: "el",
            text: "Δοκιμάστε ξανά.",
            english: "Please try again.",
          },
        ],
      },
    ]);
    expect(sent[2]?.url).toBe(
      "https://blackark.example/checkin/support/replies/",
    );
    expect(sent[2]?.body).toEqual({
      customerId: "demo-shop",
      installId: trial.installId,
      proof: {
        kind: "profile",
        profile: trial.profile,
        signature: trial.signature,
      },
    });
    // Kept two minutes: the second person's view asks blackark.uk nothing more.
    expect((await service.replies("user-2"))?.map((one) => one.case)).toEqual([
      2,
    ]);
    expect(sent).toHaveLength(3);
  });

  test("replies before activation: the unverified install id and no proof; null when blackark.uk is down", async () => {
    const { service, sent } = harness(
      [
        { status: 200, body: { case: 4 } },
        { status: 502, body: {} },
      ],
      { beforeActivation: true },
    );
    expect(await service.replies("user-1")).toEqual([]);
    expect(sent).toHaveLength(0);
    await service.submit("user-1", { ...input, contactEmail: "" });
    expect(await service.replies("user-1")).toBeNull();
    expect(sent[1]?.body).toMatchObject({
      customerId: "unverified",
      proof: null,
    });
    expect(sent[1]?.body.installId).toBe(sent[0]?.body.installId);
  });
  test("24/7 Priority Support: asked with the install's proof; the offer, the plan and the buy page come back", async () => {
    const trial = await importTrial();
    const offer = {
      monthlyCents: 10000,
      currency: "eur",
      vat: "excluded",
      scope: {
        el: "Υποστήριξη 24/7: απάντηση μέσα σε 1 ώρα",
        en: "24/7 support: response within 1 hour, around the clock",
      },
    };
    const { service, sent } = harness([
      {
        status: 200,
        body: {
          offer,
          plan: null,
          buyUrl:
            "https://blackark.example/checkin/buy/?customer=demo-shop&support=247",
        },
      },
      {
        status: 200,
        body: {
          offer,
          plan: {
            status: "active",
            startedAt: "2026-11-24T10:00:00Z",
            paidUntil: "2026-12-24T10:00:00Z",
          },
          buyUrl:
            "https://blackark.example/checkin/buy/?customer=demo-shop&support=247",
        },
      },
    ]);
    const first = await service.priority();
    expect(first).toEqual({
      available: true,
      offer: { monthlyCents: 10000, vat: "excluded", scope: offer.scope },
      plan: null,
      buyUrl:
        "https://blackark.example/checkin/buy/?customer=demo-shop&support=247",
      error: null,
    });
    expect(sent[0]?.url).toBe(
      "https://blackark.example/checkin/support/priority/",
    );
    expect(sent[0]?.body).toEqual({
      customerId: "demo-shop",
      installId: trial.installId,
      proof: {
        kind: "profile",
        profile: trial.profile,
        signature: trial.signature,
      },
    });
    // Within the minute, BlackArk is not asked again; after paying, `fresh` asks.
    expect((await service.priority()).plan).toBeNull();
    expect(sent).toHaveLength(1);
    expect((await service.priority(true)).plan?.status).toBe("active");
  });

  test("24/7 Priority Support before activation: not available, nothing is asked", async () => {
    const { service, sent } = harness([], { beforeActivation: true });
    expect(await service.priority()).toEqual({
      available: false,
      offer: null,
      plan: null,
      buyUrl: null,
      error: null,
    });
    expect(sent).toHaveLength(0);
  });

  test("24/7 Priority Support: an answer that is not one, or BlackArk down, says so", async () => {
    await importTrial();
    const { service } = harness([
      { status: 200, body: { offer: { monthlyCents: "100" }, buyUrl: "x" } },
      { status: 502, body: {} },
    ]);
    expect((await service.priority()).error).toContain("could not be reached");
    const down = await service.priority(true);
    expect(down.available).toBe(true);
    expect(down.offer).toBeNull();
  });
});
