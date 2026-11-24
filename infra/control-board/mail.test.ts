import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getCase, notes } from "./cases";
import { pollMailbox } from "./intake";
import { graphMailbox, graphToken } from "./mail";
import { type TestBoard, testBoard } from "./test-helpers";

let current: TestBoard | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

type Stored = {
  id: string;
  internetMessageId: string;
  to: string[];
  cc: string[];
  /** The raw To header, when Exchange lists something else in toRecipients (an alias). */
  rawTo?: string;
  subject: string;
  text: string;
  inReplyTo?: string;
  isRead: boolean;
  receivedDateTime: string;
};

const SETTINGS = {
  tenantId: "contoso-tenant-id",
  clientId: "board-app-id",
  clientSecret: "app-secret",
  mailbox: "General@blackark.uk",
};
let made = 0;
beforeEach(() => {
  made = 0;
});
function mail(fields: {
  to?: string[];
  cc?: string[];
  rawTo?: string;
  subject?: string;
  text?: string;
  inReplyTo?: string;
  isRead?: boolean;
  received?: string;
}): Stored {
  made += 1;
  return {
    id: `g${made}`,
    internetMessageId: `<m${made}@x>`,
    to: fields.to ?? ["general@blackark.uk"],
    cc: fields.cc ?? [],
    ...(fields.rawTo ? { rawTo: fields.rawTo } : {}),
    subject: fields.subject ?? `Message ${made}`,
    text: fields.text ?? "Hello",
    ...(fields.inReplyTo ? { inReplyTo: fields.inReplyTo } : {}),
    isRead: fields.isRead ?? false,
    // Each one a minute after the last, so "newest first" has an order to keep.
    receivedDateTime:
      fields.received ??
      new Date(Date.UTC(2026, 10, 23, 9, made)).toISOString(),
  };
}

/**
 * A stand-in for Microsoft Graph and its sign-in, holding General@'s Inbox. It answers only the
 * requests the board should make, records every one, and refuses anything without the token.
 */
function graph(messages: Stored[], options: { nextLink?: string } = {}) {
  const requests: string[] = [];
  const recipients = (list: string[]) =>
    list.map((address) => ({ emailAddress: { address, name: address } }));
  const rawHeaders = (m: Stored) => [
    { name: "To", value: m.rawTo ?? m.to.join(", ") },
    ...(m.cc.length ? [{ name: "Cc", value: m.cc.join(", ") }] : []),
    ...(m.inReplyTo ? [{ name: "In-Reply-To", value: m.inReplyTo }] : []),
  ];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    if (url.hostname === "login.microsoftonline.com") {
      const form = new URLSearchParams(String(init?.body));
      requests.push(`${method} ${url.pathname} ${form.get("grant_type")}`);
      const ok =
        url.pathname === `/${SETTINGS.tenantId}/oauth2/v2.0/token` &&
        form.get("client_id") === SETTINGS.clientId &&
        form.get("client_secret") === SETTINGS.clientSecret &&
        form.get("scope") === "https://graph.microsoft.com/.default";
      return ok
        ? Response.json({ access_token: "token-1", token_type: "Bearer" })
        : Response.json(
            {
              error: "invalid_client",
              error_description: `AADSTS7000215 for app ${form.get("client_id")}`,
            },
            { status: 401 },
          );
    }
    requests.push(`${method} ${url.pathname}${url.search ? "?…" : ""}`);
    if (headers.get("authorization") !== "Bearer token-1")
      return new Response("", { status: 401 });
    const base = "/v1.0/users/General%40blackark.uk";
    if (
      method === "GET" &&
      url.pathname === `${base}/mailFolders/inbox/messages`
    ) {
      const filter = url.searchParams.get("$filter") ?? "";
      const since = filter.match(/^receivedDateTime ge (\S+)$/)?.[1];
      if (
        !since ||
        url.searchParams.get("$orderby") !== "receivedDateTime desc"
      )
        return new Response("InefficientFilter", { status: 400 });
      const top = Number(url.searchParams.get("$top"));
      const skip = Number(url.searchParams.get("$skip") ?? 0);
      const recent = messages
        .filter((m) => m.receivedDateTime >= since)
        .sort((a, b) => b.receivedDateTime.localeCompare(a.receivedDateTime));
      const page = recent.slice(skip, skip + top);
      const next = new URL(url);
      next.searchParams.set("$skip", String(skip + top));
      return Response.json({
        value: page.map((m) => ({
          id: m.id,
          internetMessageId: m.internetMessageId,
          toRecipients: recipients(m.to),
          ccRecipients: recipients(m.cc),
          internetMessageHeaders: rawHeaders(m),
        })),
        ...(skip + top < recent.length
          ? { "@odata.nextLink": options.nextLink ?? next.toString() }
          : {}),
      });
    }
    const one = url.pathname.match(new RegExp(`^${base}/messages/([^/]+)$`));
    const stored =
      one &&
      messages.find((m) => m.id === decodeURIComponent(one[1] as string));
    if (stored && method === "GET") {
      const text = headers.get("prefer") === 'outlook.body-content-type="text"';
      return Response.json({
        id: stored.id,
        internetMessageId: stored.internetMessageId,
        subject: stored.subject,
        from: {
          emailAddress: { address: "customer@example.com", name: "A Customer" },
        },
        toRecipients: recipients(stored.to),
        ccRecipients: recipients(stored.cc),
        body: text
          ? { contentType: "text", content: stored.text }
          : { contentType: "html", content: `<p>${stored.text}</p>` },
        internetMessageHeaders: rawHeaders(stored),
      });
    }
    if (stored && method === "PATCH") {
      const body = JSON.parse(String(init?.body));
      if (JSON.stringify(body) !== '{"isRead":true}')
        return new Response("", { status: 400 });
      stored.isRead = true;
      return Response.json({ id: stored.id, isRead: true });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { requests, fetch: fetcher };
}

const NOW = () => Date.UTC(2026, 10, 23, 12, 0);

describe("General@ through Microsoft Graph, filtered on support@", () => {
  test("takes only messages sent to support@ (To or Cc), read or not; everything else is never fetched in full or marked read", async () => {
    const t = await testBoard();
    current = t;
    const inbox = [
      mail({
        to: ["support@blackark.uk"],
        subject: "Gmail stopped [customer:demo-shop]",
      }),
      mail({ subject: "An invoice from a supplier" }),
      mail({ cc: ["Support@BlackArk.uk"], subject: "Cc to support" }),
      mail({
        to: ["nosupport@blackark.uk"],
        subject: "Looks like support, is not",
      }),
      mail({
        to: ["support@blackark.uk"],
        subject: "Already read",
        isRead: true,
      }),
    ];
    const g = graph(inbox);
    const mailbox = graphMailbox(SETTINGS, { fetch: g.fetch, now: NOW });

    expect(await pollMailbox(t.sql, mailbox, t.clock.now)).toEqual([1, 2, 3]);
    expect(await getCase(t.sql, 1)).toMatchObject({
      customer_id: "demo-shop",
      channel: "email",
      subject: "Gmail stopped [customer:demo-shop]",
    });
    expect((await getCase(t.sql, 2))?.subject).toBe("Cc to support");
    expect((await notes(t.sql, 1))[0]?.body).toStartWith(
      "From: A Customer <customer@example.com>\nMessage-ID: m1@x\n",
    );
    expect(inbox.map((m) => [m.subject.slice(0, 12), m.isRead])).toEqual([
      ["Gmail stoppe", true],
      ["An invoice f", false],
      ["Cc to suppor", true],
      ["Looks like s", false],
      ["Already read", true],
    ]);
    // Opened in Outlook before the board saw it: still a case (live, 24 Nov).
    expect((await getCase(t.sql, 3))?.subject).toBe("Already read");
    // One sign-in, one list of ids and recipients, then only the two support@ messages, read in
    // full, then each marked read once its case is saved. Nothing else is asked for, changed,
    // moved, deleted or sent.
    expect(g.requests).toEqual([
      "POST /contoso-tenant-id/oauth2/v2.0/token client_credentials",
      "GET /v1.0/users/General%40blackark.uk/mailFolders/inbox/messages?…",
      "GET /v1.0/users/General%40blackark.uk/messages/g1?…",
      "GET /v1.0/users/General%40blackark.uk/messages/g3?…",
      "GET /v1.0/users/General%40blackark.uk/messages/g5?…",
      "PATCH /v1.0/users/General%40blackark.uk/messages/g1",
      "PATCH /v1.0/users/General%40blackark.uk/messages/g3",
      "PATCH /v1.0/users/General%40blackark.uk/messages/g5",
    ]);
    // The next run lists the Inbox again, and fetches nothing it already took.
    const before = g.requests.length;
    expect(await pollMailbox(t.sql, mailbox, t.clock.now)).toEqual([]);
    expect(
      g.requests.slice(before).filter((r) => r.includes("/messages/g")),
    ).toEqual([]);
  });

  test("a reply to a case's message becomes a note on it, even when both arrive in one run", async () => {
    const t = await testBoard();
    current = t;
    const first = mail({ to: ["support@blackark.uk"], subject: "Problem" });
    const g = graph([
      first,
      mail({
        to: ["support@blackark.uk"],
        subject: "Re: Problem",
        text: "More detail",
        inReplyTo: first.internetMessageId,
      }),
    ]);
    const mailbox = graphMailbox(SETTINGS, { fetch: g.fetch, now: NOW });
    expect(await pollMailbox(t.sql, mailbox, t.clock.now)).toEqual([1, 1]);
    expect((await notes(t.sql, 1)).at(-1)?.body.endsWith("More detail")).toBe(
      true,
    );
  });

  test("an answer to support@ that Exchange lists as General@ (the alias resolved), already read in Outlook, becomes a note on its case (live, 24 Nov)", async () => {
    const t = await testBoard();
    current = t;
    const first = mail({ to: ["support@blackark.uk"], subject: "STAFF TEST" });
    const g = graph([first]);
    const mailbox = graphMailbox(SETTINGS, { fetch: g.fetch, now: NOW });
    expect(await pollMailbox(t.sql, mailbox, t.clock.now)).toEqual([1]);
    const answer = mail({
      to: ["General@blackark.uk"],
      rawTo: "BlackArk Support <support@blackark.uk>",
      subject: "RE: [Case #1] STAFF TEST",
      text: "Got it.",
      isRead: true,
    });
    const g2 = graph([first, answer]);
    expect(
      await pollMailbox(
        t.sql,
        graphMailbox(SETTINGS, { fetch: g2.fetch, now: NOW }),
        t.clock.now,
      ),
    ).toEqual([1]);
    expect((await notes(t.sql, 1)).at(-1)?.body.endsWith("Got it.")).toBe(true);
    // A message to General@ only, with no support@ in any header, is still left alone.
    const plain = mail({ to: ["General@blackark.uk"], subject: "Supplier" });
    const g3 = graph([plain]);
    expect(
      await pollMailbox(
        t.sql,
        graphMailbox(SETTINGS, { fetch: g3.fetch, now: NOW }),
        t.clock.now,
      ),
    ).toEqual([]);
    expect(g3.requests.some((r) => r.includes(`/messages/${plain.id}`))).toBe(
      false,
    );
  });

  test("messages already taken do not use up a run: 7 for support@ go 5, then 2", async () => {
    const t = await testBoard();
    current = t;
    const g = graph(
      Array.from({ length: 7 }, () => mail({ to: ["support@blackark.uk"] })),
    );
    const mailbox = graphMailbox(SETTINGS, { fetch: g.fetch, now: NOW });
    expect((await pollMailbox(t.sql, mailbox, t.clock.now)).length).toBe(5);
    expect((await pollMailbox(t.sql, mailbox, t.clock.now)).length).toBe(2);
    expect(await pollMailbox(t.sql, mailbox, t.clock.now)).toEqual([]);
  });

  test("a refused sign-in reads nothing, and the error names neither the app nor the secret", async () => {
    const g = graph([mail({ to: ["support@blackark.uk"] })]);
    const mailbox = graphMailbox(
      { ...SETTINGS, clientSecret: "wrong-secret" },
      { fetch: g.fetch, now: NOW },
    );
    const error = await mailbox.unseen().catch((e: Error) => e);
    expect(String(error)).toBe("GraphError: sign-in refused (HTTP 401)");
    expect(String(error)).not.toContain("board-app-id");
    expect(g.requests).toEqual([
      "POST /contoso-tenant-id/oauth2/v2.0/token client_credentials",
    ]);
  });

  test("a tenant id that is not one is refused before any request", async () => {
    const g = graph([]);
    await expect(
      graphToken({ ...SETTINGS, tenantId: "evil.example/../x" }, g.fetch),
    ).rejects.toThrow("MS_TENANT_ID is not a tenant id");
    expect(g.requests).toEqual([]);
  });

  test("a run takes at most 5 messages, across pages; unread mail older than 14 days is left alone", async () => {
    const inbox = [
      mail({
        to: ["support@blackark.uk"],
        received: "2026-11-01T09:00:00.000Z",
      }),
      ...Array.from({ length: 120 }, (_, i) =>
        mail({
          to: [i % 30 === 29 ? "support@blackark.uk" : "general@blackark.uk"],
        }),
      ),
    ];
    const g = graph(inbox);
    const mailbox = graphMailbox(SETTINGS, { fetch: g.fetch, now: NOW });
    const taken = await mailbox.unseen();
    // Four support@ messages among 120 newer ones (three pages of 50), none of them 22 days old.
    expect(taken.map((m) => m.id)).toEqual([
      "m31@x",
      "m61@x",
      "m91@x",
      "m121@x",
    ]);
    expect(g.requests.filter((r) => r.includes("/mailFolders/")).length).toBe(
      3,
    );

    const many = graph(
      Array.from({ length: 8 }, () => mail({ to: ["support@blackark.uk"] })),
    );
    expect(
      (await graphMailbox(SETTINGS, { fetch: many.fetch, now: NOW }).unseen())
        .length,
    ).toBe(5);
  });

  test("a next page that points anywhere but Graph is not followed", async () => {
    const inbox = Array.from({ length: 60 }, () =>
      mail({ to: ["general@blackark.uk"] }),
    );
    const g = graph(inbox, {
      nextLink: "https://attacker.example/v1.0/users/x/messages",
    });
    const seen: string[] = [];
    const watched = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new URL(String(input)).hostname);
      return g.fetch(input, init);
    }) as typeof fetch;
    expect(
      await graphMailbox(SETTINGS, { fetch: watched, now: NOW }).unseen(),
    ).toEqual([]);
    expect(seen).not.toContain("attacker.example");
  });

  test("the body is asked for as text, so no HTML reaches a case", async () => {
    const g = graph([
      mail({ to: ["support@blackark.uk"], text: "Plain words" }),
    ]);
    const [one] = await graphMailbox(SETTINGS, {
      fetch: g.fetch,
      now: NOW,
    }).unseen();
    expect(one?.text).toBe("Plain words");
  });
});
