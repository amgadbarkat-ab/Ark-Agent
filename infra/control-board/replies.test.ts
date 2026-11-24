import { afterEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { randomBytes, randomUUID } from "node:crypto";
import { readAudit } from "./audit";
import { casesExtension, getCase, notes, reachOf } from "./cases";
import { appIntake, pollMailbox, signIntake, standInMailbox } from "./intake";
import { graphSender, replyMime } from "./mail";
import {
  appReplies,
  type OutgoingMail,
  REPEAT_MS,
  type ReplyMailer,
  replyHtml,
  replySubject,
  replyText,
  replyToCase,
} from "./replies";
import { Browser, ORIGIN, type TestBoard, testBoard } from "./test-helpers";

const SECRET = "intake-secret-for-tests-0123456789abcdef";
const INSTALL = "aaaa1111-0000-4000-8000-000000000001";
const OTHER_INSTALL = "bbbb2222-0000-4000-8000-000000000002";

let current: TestBoard | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

/** A mailer that keeps what it was asked to send, or fails like a refused Graph call. */
function mailbox(fail = false): ReplyMailer & { sent: OutgoingMail[] } {
  const sent: OutgoingMail[] = [];
  return {
    sent,
    async send(mail) {
      if (fail) {
        const error = new Error("sendMail refused (HTTP 403)");
        error.name = "GraphError";
        throw error;
      }
      sent.push(mail);
    },
  };
}

async function setup(
  options: { mailer?: ReplyMailer | null; role?: "support" | "read-only" } = {},
) {
  const t = await testBoard((sql, clock) => [
    casesExtension(sql, {
      githubRepo: "example/repo",
      mailer: options.mailer ?? null,
    }),
    appIntake(sql, { secret: SECRET, now: () => clock.now }),
    appReplies(sql, { secret: SECRET, now: () => clock.now }),
  ]);
  current = t;
  await t.addAccount("maria", options.role ?? "support");
  const browser = t.browser();
  await browser.signIn("maria", t.code("maria"));
  return { t, browser };
}

function signed(t: TestBoard, path: string, value: unknown) {
  const body = JSON.stringify(value);
  const time = String(Math.floor(t.clock.now / 1000));
  const nonce = randomBytes(18).toString("base64url");
  return t.board.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ark-time": time,
        "x-ark-nonce": nonce,
        "x-ark-signature": signIntake(SECRET, time, nonce, body),
      },
      body,
    }),
  );
}

/** A request as blackark.uk forwards it: before activation (with an address), or from a customer. */
function fromApp(t: TestBoard, over: Record<string, unknown> = {}) {
  return signed(t, "/intake/app", {
    requestId: randomUUID(),
    customerId: "unverified",
    installId: INSTALL,
    appVersion: "0.1.52",
    language: "el",
    subject: "Δεν ενεργοποιείται",
    message: "Ο κωδικός δοκιμής δεν γίνεται δεκτός.",
    urgent: false,
    plan: "none",
    diagnostics: null,
    contactEmail: "maria@shop.example",
    ...over,
  });
}

async function reply(
  browser: Browser,
  number: number,
  fields: Record<string, string>,
) {
  const page = await browser.get(`/cases/${number}`);
  return browser.post(`/cases/${number}`, {
    csrf: Browser.csrfFrom(page.text),
    action: "reply",
    ...fields,
  });
}

describe("replies to the customer, from the board", () => {
  test("a Greek case from before activation: emailed in BlackArk's look (Greek, then English), shown in the app, kept, noted and audited", async () => {
    const mailer = mailbox();
    const { t, browser } = await setup({ mailer });
    expect((await fromApp(t)).status).toBe(201);
    expect(await reachOf(t.sql, 1)).toEqual({
      install_id: INSTALL,
      email: "maria@shop.example",
    });

    const page = (await browser.get("/cases/1")).text;
    expect(page).toContain("Replies to the customer");
    expect(page).toContain("<strong>maria@shop.example</strong>");
    expect(page).toContain("in the customer&#39;s app");
    expect(page).toContain('name="english"');

    const sent = await reply(browser, 1, {
      body: "Καλησπέρα. Δοκιμάστε ξανά τώρα.\nΟ κωδικός ανανεώθηκε.",
      english: "Good evening. Please try again now.\nThe code was renewed.",
    });
    expect(sent.status).toBe(303);

    expect(mailer.sent).toHaveLength(1);
    const mail = mailer.sent[0] as OutgoingMail;
    expect(mail.to).toBe("maria@shop.example");
    expect(mail.subject).toBe("[Case #1] Δεν ενεργοποιείται");
    expect(mail.text).toBe(
      [
        "Καλησπέρα. Δοκιμάστε ξανά τώρα.\nΟ κωδικός ανανεώθηκε.",
        "Για να μας απαντήσετε, απαντήστε σε αυτό το email.\nBlackArk Support",
        "---",
        "Good evening. Please try again now.\nThe code was renewed.",
        "To answer us, reply to this email.\nBlackArk Support",
      ].join("\n\n"),
    );
    expect(mail.html).toContain('<html lang="el">');
    expect(mail.html).toContain(
      '<div lang="el"><p style="margin:0 0 16px;">Καλησπέρα. Δοκιμάστε ξανά τώρα.<br>Ο κωδικός ανανεώθηκε.</p>',
    );
    expect(mail.html).toContain(
      '<div lang="en"><p style="margin:0 0 16px;">Good evening.',
    );
    expect(mail.html).toContain("background:#070504");

    expect((await getCase(t.sql, 1))?.status).toBe("waiting");
    const note = (await notes(t.sql, 1)).at(-1);
    expect(note?.author).toBe("maria");
    expect(note?.body).toBe(
      "Reply to the customer (emailed to maria@shop.example; shown in the app):\n\nΚαλησπέρα. Δοκιμάστε ξανά τώρα.\nΟ κωδικός ανανεώθηκε.\n\n--- English copy ---\nGood evening. Please try again now.\nThe code was renewed.",
    );
    const audit = (await readAudit(t.sql, 10, 0)).find(
      (row) => row.action === "case.reply",
    );
    expect(audit).toMatchObject({
      actor: "maria",
      target: "case:1",
      outcome: "ok",
      detail: "emailed, app",
    });
    // The audit log never holds the words.
    expect(JSON.stringify(audit)).not.toContain("Καλησπέρα");

    // The app (through blackark.uk) sees the reply for this install, and only this install.
    const mine = await signed(t, "/intake/replies", {
      customerId: "unverified",
      installId: INSTALL,
    });
    expect(mine.status).toBe(200);
    expect(await mine.json()).toEqual({
      cases: [
        {
          case: 1,
          subject: "Δεν ενεργοποιείται",
          status: "waiting",
          openedAt: "2026-11-18T10:00:00.000Z",
          replies: [
            {
              at: "2026-11-18T10:00:00.000Z",
              language: "el",
              text: "Καλησπέρα. Δοκιμάστε ξανά τώρα.\nΟ κωδικός ανανεώθηκε.",
              english:
                "Good evening. Please try again now.\nThe code was renewed.",
            },
          ],
        },
      ],
    });
    for (const asker of [
      { customerId: "unverified", installId: OTHER_INSTALL },
      { customerId: "demo-shop", installId: INSTALL },
    ]) {
      const other = await signed(t, "/intake/replies", asker);
      expect(await other.json()).toEqual({ cases: [] });
    }
  });

  test("an activated install's case has no address: the reply reaches the app only, and nothing is emailed", async () => {
    const mailer = mailbox();
    const { t, browser } = await setup({ mailer });
    await fromApp(t, {
      customerId: "demo-shop",
      plan: "trial",
      language: "en",
      subject: "Gmail stopped",
      contactEmail: undefined,
    });
    const page = (await browser.get("/cases/1")).text;
    expect(page).not.toContain('name="english"');
    expect(page).toContain("Reply in English");
    expect(
      (await reply(browser, 1, { body: "Please sign in to Gmail again." }))
        .status,
    ).toBe(303);
    expect(mailer.sent).toEqual([]);
    expect((await notes(t.sql, 1)).at(-1)?.body).toStartWith(
      "Reply to the customer (shown in the app):",
    );
    const answer = (await (
      await signed(t, "/intake/replies", {
        customerId: "demo-shop",
        installId: INSTALL,
      })
    ).json()) as { cases: Array<{ replies: unknown[] }> };
    expect(answer.cases[0]?.replies).toEqual([
      {
        at: "2026-11-18T10:00:00.000Z",
        language: "en",
        text: "Please sign in to Gmail again.",
        english: null,
      },
    ]);
  });

  test("an email case: the reply goes to the sender, and their answer comes back to the same case", async () => {
    const mailer = mailbox();
    const { t, browser } = await setup({ mailer });
    await pollMailbox(
      t.sql,
      standInMailbox([
        {
          id: "m1@x",
          from: "A Customer <customer@example.com>",
          to: ["support@blackark.uk"],
          cc: [],
          subject: "Invoice question",
          text: "Where is my invoice?",
        },
      ]),
      t.clock.now,
    );
    expect(await reachOf(t.sql, 1)).toEqual({
      install_id: null,
      email: "customer@example.com",
    });
    await reply(browser, 1, { body: "It is attached to your account page." });
    expect(mailer.sent[0]).toMatchObject({
      to: "customer@example.com",
      subject: "[Case #1] Invoice question",
    });
    // The answer has the tag in its subject: a note on case 1, not a new case.
    expect(
      await pollMailbox(
        t.sql,
        standInMailbox([
          {
            id: "m2@x",
            from: "customer@example.com",
            to: ["support@blackark.uk"],
            cc: [],
            subject: `Re: ${mailer.sent[0]?.subject}`,
            text: "Found it, thank you.",
          },
        ]),
        t.clock.now,
      ),
    ).toEqual([1]);
    expect((await notes(t.sql, 1)).at(-1)?.body).toEndWith(
      "Found it, thank you.",
    );
  });

  test("when the email fails, the reply is kept as failed, the person is told, and the app still has it", async () => {
    const { t, browser } = await setup({ mailer: mailbox(true) });
    await fromApp(t);
    const answer = await reply(browser, 1, {
      body: "Δοκιμάστε ξανά.",
      english: "Please try again.",
    });
    expect(answer.status).toBe(502);
    expect(answer.text).toContain("The email could not be sent.");
    const row = await t.sql.first<{ email: string; emailed_to: string }>(
      "SELECT email, emailed_to FROM case_replies WHERE case_number = 1",
    );
    expect(row).toEqual({ email: "failed", emailed_to: "maria@shop.example" });
    expect((await notes(t.sql, 1)).at(-1)?.body).toStartWith(
      "Reply to the customer (NOT emailed to maria@shop.example: sendMail refused (HTTP 403); shown in the app):",
    );
    expect(
      (await readAudit(t.sql, 10, 0)).find((r) => r.action === "case.reply")
        ?.detail,
    ).toBe("email failed (sendMail refused (HTTP 403)), app");
  });

  test("no way back to the customer: no form, and a reply is refused; a Greek case needs its English copy", async () => {
    const { t, browser } = await setup({ mailer: mailbox() });
    const form = await browser.get("/cases/new?customer=demo-clinic");
    await browser.post("/cases", {
      csrf: Browser.csrfFrom(form.text),
      customer: "demo-clinic",
      subject: "Phoned in",
      channel: "in-app",
      language: "en",
      priority: "normal",
      owner: "",
      github: "",
      note: "",
    });
    const page = (await browser.get("/cases/1")).text;
    expect(page).not.toContain('value="reply"');
    expect(page).toContain("the board cannot reply");
    expect((await reply(browser, 1, { body: "Hello" })).status).toBe(409);
    expect(
      await t.sql.first<{ n: number }>(
        "SELECT COUNT(*) AS n FROM case_replies",
      ),
    ).toEqual({ n: 0 });

    await fromApp(t);
    expect((await reply(browser, 2, { body: "Μόνο ελληνικά" })).status).toBe(
      400,
    );
  });

  test("email replies not switched on: an email case says so; an app case still gets its reply in the app", async () => {
    const { t, browser } = await setup({ mailer: null });
    await fromApp(t);
    const page = (await browser.get("/cases/1")).text;
    expect(page).not.toContain("<strong>maria@shop.example</strong>");
    expect(
      (await reply(browser, 1, { body: "Γεια", english: "Hello" })).status,
    ).toBe(303);
    expect(
      await t.sql.first<{ email: string; emailed_to: string | null }>(
        "SELECT email, emailed_to FROM case_replies",
      ),
    ).toEqual({ email: "none", emailed_to: null });
  });

  test("the same reply sent twice (a double click, live on 24 Nov): kept and emailed once; again after 2 minutes it is a new reply", async () => {
    const mailer = mailbox();
    const { t, browser } = await setup({ mailer });
    await fromApp(t);
    const words = { body: "Δοκιμή απάντησης", english: "Test reply" };
    expect((await reply(browser, 1, words)).status).toBe(303);
    expect((await reply(browser, 1, words)).status).toBe(303);
    // Both in flight at once, as two clicks before the page answers.
    const row = (await getCase(t.sql, 1)) as NonNullable<
      Awaited<ReturnType<typeof getCase>>
    >;
    const other = { body: "Δεύτερη", english: "Second" };
    const both = await Promise.all([
      replyToCase(t.sql, mailer, row, "maria", other, t.clock.now),
      replyToCase(t.sql, mailer, row, "maria", other, t.clock.now),
    ]);
    expect(both.filter((one) => one?.reply).length).toBe(1);
    expect(mailer.sent).toHaveLength(2);
    expect(
      await t.sql.first<{ n: number }>(
        "SELECT COUNT(*) AS n FROM case_replies",
      ),
    ).toEqual({ n: 2 });
    expect(
      (await readAudit(t.sql, 20, 0))
        .filter((r) => r.action === "case.reply")
        .map((r) => `${r.outcome} ${r.detail}`),
    ).toContain(
      "refused the same reply again within 2 minutes: not sent again",
    );

    t.clock.now += REPEAT_MS + 1000;
    expect((await reply(browser, 1, words)).status).toBe(303);
    expect(mailer.sent).toHaveLength(3);
  });

  test("after a failed email, the same reply can be tried again at once", async () => {
    let fail = true;
    const sent: OutgoingMail[] = [];
    const flaky: ReplyMailer = {
      async send(mail) {
        if (fail) {
          const error = new Error("sendMail refused (HTTP 503)");
          error.name = "GraphError";
          throw error;
        }
        sent.push(mail);
      },
    };
    const { t, browser } = await setup({ mailer: flaky });
    await fromApp(t);
    const words = { body: "Γεια", english: "Hello" };
    expect((await reply(browser, 1, words)).status).toBe(502);
    fail = false;
    expect((await reply(browser, 1, words)).status).toBe(303);
    expect(sent).toHaveLength(1);
  });

  test("read-only accounts see replies but cannot send one", async () => {
    const { t, browser } = await setup({
      mailer: mailbox(),
      role: "read-only",
    });
    await fromApp(t);
    expect((await browser.get("/cases/1")).text).not.toContain('value="reply"');
    const answer = await browser.post("/cases/1", {
      csrf: Browser.csrfFrom((await browser.get("/cases/1")).text),
      action: "reply",
      body: "x",
      english: "x",
    });
    expect(answer.status).toBe(403);
  });

  test("the replies request is signed like the intake, and checks what it is asked", async () => {
    const { t } = await setup();
    const unsigned = await t.board.fetch(
      new Request(`${ORIGIN}/intake/replies`, {
        method: "POST",
        body: JSON.stringify({ customerId: "unverified", installId: INSTALL }),
      }),
    );
    expect(unsigned.status).toBe(403);
    expect(
      (
        await signed(t, "/intake/replies", {
          customerId: "unverified",
          installId: "not-a-uuid",
        })
      ).status,
    ).toBe(400);
  });
});

describe("the reply email itself", () => {
  test("subject, plain text and HTML", () => {
    expect(replySubject({ number: 7, subject: "Re: Gmail stopped" })).toBe(
      "[Case #7] Gmail stopped",
    );
    expect(
      replySubject({ number: 7, subject: "[Case #7] Gmail stopped" }),
    ).toBe("[Case #7] Gmail stopped");
    expect(replyText("en", "Hello", "ignored")).toBe(
      "Hello\n\nTo answer us, reply to this email.\nBlackArk Support",
    );
    const html = replyHtml("<b>x</b>\nhttps://blackark.uk/help", "en", "T");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).toContain('<a href="https://blackark.uk/help"');
    expect(html).not.toContain("<b>x</b>");
  });

  test("the MIME message: From General@, Reply-To support@, both parts, nothing typed can reach a header", () => {
    const mail: OutgoingMail = {
      to: "maria@shop.example",
      subject: "[Case #3] Δεν ανοίγει\r\nBcc: evil@example.com",
      text: "Γεια σας",
      html: "<p>Γεια σας</p>",
      language: "el",
      caseNumber: 3,
    };
    const mime = replyMime(mail, {
      from: "General@blackark.uk",
      replyTo: "support@blackark.uk",
      now: Date.UTC(2026, 10, 24, 10, 0),
      random: "abc123",
    });
    const [head, ...rest] = mime.split("\r\n\r\n");
    expect(head?.split("\r\n").slice(0, 3)).toEqual([
      "From: BlackArk Support <General@blackark.uk>",
      "Reply-To: BlackArk Support <support@blackark.uk>",
      "To: <maria@shop.example>",
    ]);
    expect(head).not.toMatch(/^Bcc:/m);
    expect(head).toContain("Message-ID: <case-3.abc123@blackark.uk>");
    expect(head).toContain(
      'Content-Type: multipart/alternative; boundary="ark-abc123"',
    );
    const subject = (head?.match(/^Subject: ([\s\S]*?)\r\nDate:/m)?.[1] ?? "")
      .split(/\r\n /)
      .map((word) =>
        Buffer.from(
          word.replace(/^=\?UTF-8\?B\?|\?=$/g, ""),
          "base64",
        ).toString("utf8"),
      )
      .join("");
    expect(subject).toBe("[Case #3] Δεν ανοίγει Bcc: evil@example.com");
    const body = rest.join("\r\n\r\n");
    const parts = [
      ...body.matchAll(/base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/g),
    ].map((m) =>
      Buffer.from((m[1] as string).replace(/\r\n/g, ""), "base64").toString(
        "utf8",
      ),
    );
    expect(parts).toEqual(["Γεια σας", "<p>Γεια σας</p>"]);
    expect(() =>
      replyMime(
        { ...mail, to: "x@y.example>\r\nBcc: evil@example.com" },
        {
          from: "General@blackark.uk",
          replyTo: "support@blackark.uk",
          now: 0,
          random: "r",
        },
      ),
    ).toThrow("not an email address");
  });

  test("Graph: one sign-in, then sendMail on General@ with the MIME message, base64", async () => {
    const requests: Array<{ url: string; headers: Headers; body: string }> = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({
        url,
        headers: new Headers(init?.headers),
        body: String(init?.body ?? ""),
      });
      if (url.startsWith("https://login.microsoftonline.com/"))
        return Response.json({ access_token: "token-1" });
      return new Response(null, { status: 202 });
    }) as typeof fetch;
    const sender = graphSender(
      {
        tenantId: "contoso-tenant-id",
        clientId: "board-app-id",
        clientSecret: "app-secret",
        mailbox: "General@blackark.uk",
      },
      { fetch: fetcher, now: () => 0, random: () => "r1" },
    );
    await sender.send({
      to: "maria@shop.example",
      subject: "[Case #1] Hello",
      text: "Hi",
      html: "<p>Hi</p>",
      language: "en",
      caseNumber: 1,
    });
    expect(requests.map((r) => r.url)).toEqual([
      "https://login.microsoftonline.com/contoso-tenant-id/oauth2/v2.0/token",
      "https://graph.microsoft.com/v1.0/users/General%40blackark.uk/sendMail",
    ]);
    const send = requests[1];
    expect(send?.headers.get("authorization")).toBe("Bearer token-1");
    expect(send?.headers.get("content-type")).toBe("text/plain");
    expect(
      Buffer.from(send?.body ?? "", "base64").toString("utf8"),
    ).toStartWith(
      "From: BlackArk Support <General@blackark.uk>\r\nReply-To: BlackArk Support <support@blackark.uk>\r\n",
    );

    const refused = graphSender(
      {
        tenantId: "contoso-tenant-id",
        clientId: "board-app-id",
        clientSecret: "app-secret",
        mailbox: "General@blackark.uk",
      },
      {
        fetch: (async (input: RequestInfo | URL) =>
          String(input).includes("login.")
            ? Response.json({ access_token: "t" })
            : new Response("ErrorAccessDenied", {
                status: 403,
              })) as typeof fetch,
      },
    );
    await expect(
      refused.send({
        to: "maria@shop.example",
        subject: "s",
        text: "t",
        html: "h",
        language: "en",
        caseNumber: 1,
      }),
    ).rejects.toThrow("sendMail refused (HTTP 403)");
  });
});
