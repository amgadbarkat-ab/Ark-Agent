import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { readAudit } from "./audit";
import { getCase, listCases, notes } from "./cases";
import { appIntake, pollMailbox, signIntake, standInMailbox } from "./intake";
import { ORIGIN, testBoard } from "./test-helpers";

const SECRET = "intake-secret-for-tests-0123456789abcdef";
let current: ReturnType<typeof testBoard> | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

function setup() {
  const t = testBoard((db, clock) => [
    appIntake(db, { secret: SECRET, now: () => clock.now }),
  ]);
  current = t;
  return t;
}

const request = {
  customerId: "demo-bakery",
  installId: "aaaa1111-0000-4000-8000-000000000001",
  appVersion: "0.1.49",
  language: "el",
  subject: "Δεν ανοίγει το Gmail",
  message: "Μετά την ενημέρωση ζητάει ξανά σύνδεση.",
};

function post(
  t: ReturnType<typeof testBoard>,
  body: string,
  options: { time?: number; nonce?: string; secret?: string } = {},
) {
  const time = String(Math.floor((options.time ?? t.clock.now) / 1000));
  const nonce = options.nonce ?? randomBytes(18).toString("base64url");
  return t.board.fetch(
    new Request(`${ORIGIN}/intake/app`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ark-time": time,
        "x-ark-nonce": nonce,
        "x-ark-signature": signIntake(
          options.secret ?? SECRET,
          time,
          nonce,
          body,
        ),
      },
      body,
    }),
  );
}

describe("the app's support form (design stage)", () => {
  test("a signed request opens one in-app case with the message as its first note", async () => {
    const t = setup();
    const answer = await post(t, JSON.stringify(request));
    expect(answer.status).toBe(201);
    expect(await answer.json()).toEqual({ case: 1 });
    expect(getCase(t.db, 1)).toMatchObject({
      customer_id: "demo-bakery",
      channel: "in-app",
      language: "el",
      priority: "normal",
      status: "new",
      subject: "Δεν ανοίγει το Gmail",
      created_by: "intake:app",
    });
    expect(notes(t.db, 1)[0]?.body).toBe(
      "From install aaaa1111 (v0.1.49):\nΜετά την ενημέρωση ζητάει ξανά σύνδεση.",
    );
    expect(readAudit(t.db, 1, 0)[0]).toMatchObject({
      actor: "intake:app",
      action: "case.create",
      target: "case:1",
    });
  });

  test("refuses a bad signature, a stale request, and the same request twice", async () => {
    const t = setup();
    const body = JSON.stringify(request);
    expect(
      (await post(t, body, { secret: "another-secret-0123456789abcdefghij" }))
        .status,
    ).toBe(403);
    expect(
      (await post(t, body, { time: t.clock.now - 6 * 60_000 })).status,
    ).toBe(403);
    const nonce = randomBytes(18).toString("base64url");
    expect((await post(t, body, { nonce })).status).toBe(201);
    expect((await post(t, body, { nonce })).status).toBe(409);
    expect(listCases(t.db, {})).toHaveLength(1);
  });

  test("refuses anything that is not a support request, and more than 20 a day per customer", async () => {
    const t = setup();
    expect((await post(t, "not json")).status).toBe(400);
    expect(
      (await post(t, JSON.stringify({ ...request, customerId: "<x>" }))).status,
    ).toBe(400);
    expect(
      (await post(t, JSON.stringify({ ...request, message: "" }))).status,
    ).toBe(400);
    expect(
      (await post(t, JSON.stringify({ ...request, language: "fr" }))).status,
    ).toBe(400);
    for (let i = 0; i < 20; i++)
      expect((await post(t, JSON.stringify(request))).status).toBe(201);
    expect((await post(t, JSON.stringify(request))).status).toBe(429);
  });

  test("needs no session, but nothing else opens without one", async () => {
    const t = setup();
    expect(
      (await t.board.fetch(new Request(`${ORIGIN}/intake/app`))).status,
    ).toBe(405);
    expect((await t.board.fetch(new Request(`${ORIGIN}/cases`))).status).toBe(
      303,
    );
  });
});

describe("the support mailbox (stand-in)", () => {
  test("a new message opens an email case; a reply becomes a note on it; each message is taken once", async () => {
    const t = setup();
    const mailbox = standInMailbox([
      {
        id: "m1@mail.example",
        from: "someone@shop.example",
        subject: "Invoice question [customer:demo-shop]",
        text: "Where is my invoice?",
      },
    ]);
    expect(await pollMailbox(t.db, mailbox, t.clock.now)).toEqual([1]);
    expect(getCase(t.db, 1)).toMatchObject({
      customer_id: "demo-shop",
      channel: "email",
      language: "en",
    });
    expect(mailbox.seen).toEqual(["m1@mail.example"]);
    expect(await pollMailbox(t.db, mailbox, t.clock.now)).toEqual([]);

    const replies = standInMailbox([
      {
        id: "m2@mail.example",
        inReplyTo: "m1@mail.example",
        from: "someone@shop.example",
        subject: "Re: Invoice question",
        text: "Found it.",
      },
      {
        id: "m3@mail.example",
        from: "other@clinic.example",
        subject: "Re: [Case #1] still",
        text: "Also this.",
      },
      {
        id: "m4@mail.example",
        from: "x@unknown.example",
        subject: "Βοήθεια",
        text: "Δεν λειτουργεί.",
      },
    ]);
    expect(await pollMailbox(t.db, replies, t.clock.now)).toEqual([1, 1, 2]);
    expect(notes(t.db, 1).map((note) => note.body.split("\n").at(-1))).toEqual([
      "Where is my invoice?",
      "Found it.",
      "Also this.",
    ]);
    expect(getCase(t.db, 2)).toMatchObject({
      customer_id: "unmatched",
      language: "el",
    });
    expect(
      await pollMailbox(
        t.db,
        standInMailbox([
          {
            id: "m2@mail.example",
            from: "a@b.example",
            subject: "Re",
            text: "again",
          },
        ]),
        t.clock.now,
      ),
    ).toEqual([]);
  });
});
