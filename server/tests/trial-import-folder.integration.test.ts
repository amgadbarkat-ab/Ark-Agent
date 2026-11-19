/**
 * The import folder (v0.1.50): BlackArk staff drop a signed `.arktrial` file in
 * `<app config dir>/import/` during the setup session, and the desktop app sends its text to
 * `POST /api/trial/profile` as `{ "text": <the file> }` (desktop/src-tauri/src/trial_profile.rs).
 * Held here on the real route and database: a file BlackArk signed goes in and is audited; an unsigned
 * one, one signed by anyone else and one changed after signing are refused, with the reason the app
 * writes to its log. The check is the one the server has always made: nothing new decides.
 */
import { afterAll, beforeEach, expect, test } from "bun:test";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import {
  decodeBase64Url,
  encodeBase64Url,
  PROFILE_FORMAT,
  readProfile,
} from "../../shared/trial";
import { signText } from "../../shared/trial-sign";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { trialCodes, trialRoster, trialState } from "../src/db/schema";
import { type TrialAudit, trialRoutes } from "../src/trial/routes";
import { createTrialService } from "../src/trial/service";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const blackArk = generateKeyPairSync("ed25519");
const stranger = generateKeyPairSync("ed25519");

async function clear() {
  await database.delete(trialState);
  await database.delete(trialRoster);
  await database.delete(trialCodes);
}

beforeEach(clear);
afterAll(async () => {
  await clear();
  await database.$client.close();
});

function signedFile(key: KeyObject = blackArk.privateKey) {
  const profile = readProfile({
    v: 1,
    customer: { id: "demo-shop", name: "Demo Shop" },
    issuedAt: "2026-11-15T10:00:00Z",
    startsAt: "2026-11-16T00:00:00Z",
    endsAt: "2099-12-16T00:00:00Z",
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
  return {
    format: PROFILE_FORMAT,
    profile: encoded,
    signature: signText(key, encoded),
  };
}

// On a desktop install the one person is the administrator (single-user mode).
const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", {
    id: "desktop-owner",
    email: "owner@example.test",
    role: "admin",
  });
  await next();
};

function server() {
  const audited: Parameters<TrialAudit>[0][] = [];
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/api/trial",
    trialRoutes(requireUser, {
      service: createTrialService(database, {
        keys: [blackArk.publicKey],
        version: "0.1.50",
      }),
      seedFor: async () => 0,
      keyConfigured: true,
      audit: async (event) => {
        audited.push(event);
      },
    }),
  );
  // Exactly the request the desktop app makes for a file in the import folder.
  const dropped = async (file: string) => {
    const response = await app.request("/api/trial/profile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: file }),
    });
    return {
      status: response.status,
      body: (await response.json()) as { error?: string; changed?: boolean },
    };
  };
  return { dropped, audited };
}

test("a profile BlackArk signed goes in from the import folder and is audited", async () => {
  const { dropped, audited } = server();
  const taken = await dropped(JSON.stringify(signedFile()));
  expect(taken.status).toBe(200);
  expect(taken.body.changed).toBe(true);
  expect(audited).toHaveLength(1);
  expect(audited[0]?.eventType).toBe("trial.profile_imported");
  expect(audited[0]?.payload.customer).toBe("demo-shop");
  // The same file a second time changes nothing and is not imported twice.
  const again = await dropped(JSON.stringify(signedFile()));
  expect(again.status).toBe(200);
  expect(again.body.changed).toBe(false);
  expect(audited).toHaveLength(1);
});

test("an unsigned file, one signed by anyone else, and one changed after signing are refused", async () => {
  const { dropped, audited } = server();

  const unsigned = { ...signedFile(), signature: "" };
  const strangers = signedFile(stranger.privateKey);
  const original = signedFile();
  const profile = JSON.parse(decodeBase64Url(original.profile)) as {
    endsAt: string;
  };
  profile.endsAt = "2199-12-16T00:00:00Z";
  const altered = {
    ...original,
    profile: encodeBase64Url(JSON.stringify(profile)),
  };

  for (const file of [unsigned, strangers, altered]) {
    const refused = await dropped(JSON.stringify(file));
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBeTruthy();
  }
  expect((await dropped(JSON.stringify(strangers))).body.error).toBe(
    "This trial profile is not signed by BlackArk.",
  );
  expect((await dropped(JSON.stringify(altered))).body.error).toBe(
    "This trial profile is not signed by BlackArk.",
  );
  expect(audited).toHaveLength(0);
});
