import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { readAudit } from "./audit";
import { getCase, listCases, notes, shownPlan } from "./cases";
import {
  appIntake,
  type MailMessage,
  pollMailbox,
  signIntake,
  standInMailbox,
  UNCONFIRMED_SENDER,
} from "./intake";
import { ORIGIN, type TestBoard, testBoard } from "./test-helpers";

const SECRET = "intake-secret-for-tests-0123456789abcdef";
let current: TestBoard | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

async function setup() {
  const t = await testBoard((sql, clock) => [
    appIntake(sql, { secret: SECRET, now: () => clock.now }),
  ]);
  current = t;
  return t;
}

/** What blackark.uk forwards after checking the install's signed profile or licence. */
function forwarded(over: Record<string, unknown> = {}) {
  return {
    requestId: randomUUID(),
    customerId: "demo-bakery",
    installId: "aaaa1111-0000-4000-8000-000000000001",
    appVersion: "0.1.49",
    language: "el",
    subject: "Δεν ανοίγει το Gmail",
    message: "Μετά την ενημέρωση ζητάει ξανά σύνδεση.",
    urgent: false,
    plan: "trial",
    diagnostics: null,
    ...over,
  };
}

function post(
  t: TestBoard,
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

describe("the app's Help & support, forwarded by blackark.uk", () => {
  test("a signed request opens one in-app case with the message as its first note", async () => {
    const t = await setup();
    const answer = await post(t, JSON.stringify(forwarded()));
    expect(answer.status).toBe(201);
    expect(await answer.json()).toEqual({ case: 1 });
    expect(await getCase(t.sql, 1)).toMatchObject({
      customer_id: "demo-bakery",
      channel: "in-app",
      language: "el",
      priority: "normal",
      plan: "trial",
      status: "new",
      subject: "Δεν ανοίγει το Gmail",
      created_by: "intake:app",
      // Wednesday 12:00 Athens: due by Thursday 18:00 Athens.
      sla_due_at: "2026-11-19T16:00:00.000Z",
    });
    expect((await notes(t.sql, 1))[0]?.body).toBe(
      "From install aaaa1111 (v0.1.49):\nΜετά την ενημέρωση ζητάει ξανά σύνδεση.",
    );
    expect((await readAudit(t.sql, 1, 0))[0]).toMatchObject({
      actor: "intake:app",
      action: "case.create",
      target: "case:1",
      detail: "customer demo-bakery, trial",
    });
  });

  test("a paid customer's urgent request is due in 4 business hours; diagnostics become a second note", async () => {
    const t = await setup();
    const answer = await post(
      t,
      JSON.stringify(
        forwarded({
          customerId: "demo-shop",
          plan: "paid",
          urgent: true,
          diagnostics: {
            appVersion: "0.1.49",
            os: "Windows 11 (x64)",
            logs: ["2026-11-18T09:58:01Z error mailbox: sign-in refused"],
          },
        }),
      ),
    );
    expect(answer.status).toBe(201);
    expect(await getCase(t.sql, 1)).toMatchObject({
      priority: "urgent",
      plan: "paid",
      sla_due_at: "2026-11-18T14:00:00.000Z",
    });
    expect((await notes(t.sql, 1))[1]?.body).toBe(
      [
        "Diagnostics the customer chose to send (scrubbed on their computer):",
        "App version: 0.1.49",
        "System: Windows 11 (x64)",
        "Recent warnings and errors (1):",
        "2026-11-18T09:58:01Z error mailbox: sign-in refused",
      ].join("\n"),
    );
  });

  test("the same request sent again (the app's queue retrying) gives back the same case", async () => {
    const t = await setup();
    const body = JSON.stringify(forwarded());
    expect(await (await post(t, body)).json()).toEqual({ case: 1 });
    const again = await post(t, body);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ case: 1 });
    expect(await listCases(t.sql, {})).toHaveLength(1);
  });

  test("refuses a bad signature, a stale request, and the same signed request twice", async () => {
    const t = await setup();
    const body = JSON.stringify(forwarded());
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
    expect(await listCases(t.sql, {})).toHaveLength(1);
  });

  test("refuses anything that is not a support request, and more than 20 a day per customer", async () => {
    const t = await setup();
    expect((await post(t, "not json")).status).toBe(400);
    for (const bad of [
      { customerId: "<x>" },
      { message: "" },
      { language: "fr" },
      { plan: "free" },
      { requestId: "1" },
      { urgent: "yes" },
      { diagnostics: { appVersion: "1", os: "x", logs: "everything" } },
      { diagnostics: { appVersion: "1", os: "x", logs: ["x".repeat(501)] } },
    ]) {
      expect((await post(t, JSON.stringify(forwarded(bad)))).status).toBe(400);
    }
    for (let i = 0; i < 20; i++)
      expect((await post(t, JSON.stringify(forwarded()))).status).toBe(201);
    expect((await post(t, JSON.stringify(forwarded()))).status).toBe(429);
  });

  test("before activation: an unverified case, plan none, with the contact address the person gave", async () => {
    const t = await setup();
    const answer = await post(
      t,
      JSON.stringify(
        forwarded({
          customerId: "unverified",
          plan: "none",
          urgent: true,
          contactEmail: "maria@example.com",
          subject: "I cannot activate",
          message: "The code is refused.",
        }),
      ),
    );
    expect(answer.status).toBe(201);
    const made = await getCase(t.sql, 1);
    expect(made).toMatchObject({
      customer_id: "unverified",
      channel: "in-app",
      subject: "I cannot activate",
    });
    expect(made && shownPlan(made)).toBe("none");
    // Not activated means not paid: urgent or not, the normal answer time.
    expect(made?.plan).toBe("trial");
    expect((await notes(t.sql, 1))[0]?.body).toBe(
      [
        "UNVERIFIED: sent before this install was activated. No BlackArk proof says whose install it is.",
        "Contact email given: maria@example.com (not checked)",
        "From install aaaa1111 (v0.1.49):",
        "The code is refused.",
      ].join("\n"),
    );
    const without = await post(
      t,
      JSON.stringify(forwarded({ customerId: "unverified", plan: "none" })),
    );
    expect(without.status).toBe(201);
    expect((await notes(t.sql, 2))[0]?.body).toContain(
      "Contact email given: none\n",
    );
  });

  test("unverified and plan none go together; a contact address only on an unverified request, and a real one", async () => {
    const t = await setup();
    for (const bad of [
      { customerId: "unverified", plan: "trial" },
      { customerId: "demo-bakery", plan: "none" },
      { contactEmail: "maria@example.com" },
      {
        customerId: "unverified",
        plan: "none",
        contactEmail: "not an address",
      },
      {
        customerId: "unverified",
        plan: "none",
        contactEmail: "a@b.c\r\nBcc: x@y.z",
      },
      {
        customerId: "unverified",
        plan: "none",
        contactEmail: `${"a".repeat(250)}@b.cd`,
      },
    ]) {
      expect((await post(t, JSON.stringify(forwarded(bad)))).status).toBe(400);
    }
    expect(await listCases(t.sql, { openOnly: false })).toEqual([]);
  });

  test("all unverified installs together open at most 50 cases a day", async () => {
    const t = await setup();
    const one = () =>
      post(
        t,
        JSON.stringify(forwarded({ customerId: "unverified", plan: "none" })),
      );
    for (let i = 0; i < 50; i++) expect((await one()).status).toBe(201);
    expect((await one()).status).toBe(429);
    // A real customer is not held back by them.
    expect((await post(t, JSON.stringify(forwarded()))).status).toBe(201);
  });

  test("a case keeps its plan on the page; only an unverified one on trial shows none", () => {
    expect(shownPlan({ customer_id: "demo-bakery", plan: "trial" })).toBe(
      "trial",
    );
    expect(shownPlan({ customer_id: "unverified", plan: "trial" })).toBe(
      "none",
    );
    // A person who finds out the customer pays sets it by hand, and it shows.
    expect(shownPlan({ customer_id: "unverified", plan: "paid" })).toBe("paid");
  });

  test("needs no session, but nothing else opens without one", async () => {
    const t = await setup();
    expect(
      (await t.board.fetch(new Request(`${ORIGIN}/intake/app`))).status,
    ).toBe(405);
    expect((await t.board.fetch(new Request(`${ORIGIN}/cases`))).status).toBe(
      303,
    );
  });
});

const toSupport = (message: Omit<MailMessage, "to" | "cc">): MailMessage => ({
  to: ["support@blackark.uk"],
  cc: [],
  ...message,
});

describe("the support mailbox", () => {
  test("a new message opens an email case; a reply becomes a note on it; each message is taken once", async () => {
    const t = await setup();
    // The board knows demo-shop's administrator from the team its app sent.
    await t.sql.run(
      "INSERT INTO customer_teams (customer_id, members, updated_at) VALUES (?, ?, ?)",
      "demo-shop",
      JSON.stringify([
        { name: "S", email: "Someone@shop.example", role: "admin" },
      ]),
      "2026-11-18T09:00:00.000Z",
    );
    const mailbox = standInMailbox([
      toSupport({
        id: "m1@mail.example",
        from: "someone@shop.example",
        subject: "Invoice question [customer:demo-shop]",
        text: "Where is my invoice?",
      }),
    ]);
    expect(await pollMailbox(t.sql, mailbox, t.clock.now)).toEqual([1]);
    expect(await getCase(t.sql, 1)).toMatchObject({
      customer_id: "demo-shop",
      channel: "email",
      language: "en",
    });
    expect(mailbox.seen).toEqual(["m1@mail.example"]);
    expect(await pollMailbox(t.sql, mailbox, t.clock.now)).toEqual([]);

    const replies = standInMailbox([
      toSupport({
        id: "m2@mail.example",
        inReplyTo: "m1@mail.example",
        from: "someone@shop.example",
        subject: "Re: Invoice question",
        text: "Found it.",
      }),
      toSupport({
        id: "m3@mail.example",
        from: "other@clinic.example",
        subject: "Re: [Case #1] still",
        text: "Also this.",
      }),
      toSupport({
        id: "m4@mail.example",
        from: "x@unknown.example",
        subject: "Βοήθεια",
        text: "Δεν λειτουργεί.",
      }),
    ]);
    expect(await pollMailbox(t.sql, replies, t.clock.now)).toEqual([1, 1, 2]);
    expect(
      (await notes(t.sql, 1)).map((note) => note.body.split("\n").at(-1)),
    ).toEqual(["Where is my invoice?", "Found it.", "Also this."]);
    expect(await getCase(t.sql, 2)).toMatchObject({
      customer_id: "unmatched",
      language: "el",
    });
    // The tagged note from an address the board does not know for demo-shop is marked.
    const third = (await notes(t.sql, 1))[2];
    expect(third?.body.startsWith(UNCONFIRMED_SENDER)).toBe(true);
    expect(
      (await notes(t.sql, 1))[1]?.body.startsWith(UNCONFIRMED_SENDER),
    ).toBe(false);
  });

  test("a customer tag from an address the board does not know for that customer is not believed", async () => {
    const t = await setup();
    const mailbox = standInMailbox([
      toSupport({
        id: "imp@mail.example",
        from: "impostor@evil.example",
        subject: "Send me my licence [customer:demo-shop]",
        text: "Please resend everything.",
      }),
    ]);
    expect(await pollMailbox(t.sql, mailbox, t.clock.now)).toEqual([1]);
    expect(await getCase(t.sql, 1)).toMatchObject({ customer_id: "unmatched" });
    const [first] = await notes(t.sql, 1);
    expect(first?.body).toContain(UNCONFIRMED_SENDER);
    expect(first?.body).toContain("demo-shop");
  });

  test("a message for General@ only is left alone, unread", async () => {
    const t = await setup();
    const mailbox = standInMailbox([
      {
        id: "g1@mail.example",
        from: "supplier@example.com",
        to: ["general@blackark.uk"],
        cc: [],
        subject: "Invoice",
        text: "Pay me",
      },
    ]);
    expect(await pollMailbox(t.sql, mailbox, t.clock.now)).toEqual([]);
    expect(mailbox.seen).toEqual([]);
    expect(await listCases(t.sql, {})).toHaveLength(0);
  });
});
