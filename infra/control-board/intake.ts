/**
 * How a support case opens by itself (#149).
 *
 * 1. THE APP'S HELP & SUPPORT (Amgad, 18 Nov: the only support channel). The app posts to
 *    blackark.uk/checkin/support/, which checks the install's BlackArk-signed trial profile or
 *    licence, looks up the customer's plan, and forwards the request here, to `POST /intake/app`,
 *    signed with INTAKE_SECRET (X-Ark-Time, X-Ark-Nonce, X-Ark-Signature over
 *    "<time>.<nonce>.<body>"), within 5 minutes, each nonce once. Mounted only when INTAKE_SECRET
 *    is set. The app's own request id makes a retry return the same case, so a request the app had
 *    to queue never opens two.
 * 2. THE SUPPORT ADDRESS. support@blackark.uk is an alias delivering to General@; the poller
 *    (`pollMailbox`, with the Microsoft Graph reader in mail.ts) takes only what was sent to support@.
 */
import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";
import { appendAudit } from "./audit";
import { CUSTOMER_ID, type Extension } from "./board";
import type { Calendar } from "./business-hours";
import {
  addNote,
  findBySource,
  getCase,
  openCase,
  reachOf,
  setReach,
  UNVERIFIED_CUSTOMER,
} from "./cases";
import type { Sql } from "./sql";

const WINDOW_SECONDS = 300;
const MAX_PER_CUSTOMER_PER_DAY = 20;
/**
 * All installs that are not activated yet share one customer id, so they share their own daily
 * ceiling: blackark.uk already limits each to 3 a day per install and per address; this stops a
 * flood of new installs from filling the board.
 */
const MAX_UNVERIFIED_PER_DAY = 50;
const EMAIL =
  /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)+$/;
const MAX_BODY = 65_536;
const MAX_LOG_LINES = 200;

export function signIntake(
  secret: string,
  time: string,
  nonce: string,
  body: string,
): string {
  return createHmac("sha256", secret)
    .update(`${time}.${nonce}.${body}`)
    .digest("hex");
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

/**
 * A request blackark.uk signed with INTAKE_SECRET (X-Ark-Time, X-Ark-Nonce, X-Ark-Signature over
 * "<time>.<nonce>.<body>"), within 5 minutes, each nonce once. Gives back the parsed body, or the
 * refusal to send.
 */
export async function readSigned(
  db: Sql,
  request: Request,
  secret: string,
  now: number,
): Promise<{ json: unknown } | Response> {
  if (request.method !== "POST") return json(405, { error: "POST only." });
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY)
    return json(413, { error: "Too large." });
  const body = (await request.text()).slice(0, MAX_BODY + 1);
  if (body.length > MAX_BODY) return json(413, { error: "Too large." });
  const time = request.headers.get("x-ark-time") ?? "";
  const nonce = request.headers.get("x-ark-nonce") ?? "";
  const signature = Buffer.from(request.headers.get("x-ark-signature") ?? "");
  const expected = Buffer.from(signIntake(secret, time, nonce, body));
  if (
    !/^\d{1,12}$/.test(time) ||
    !/^[A-Za-z0-9_-]{16,64}$/.test(nonce) ||
    signature.length !== expected.length ||
    !timingSafeEqual(signature, expected)
  ) {
    return json(403, { error: "Bad signature." });
  }
  if (Math.abs(now / 1000 - Number(time)) > WINDOW_SECONDS)
    return json(403, { error: "Stale request." });
  await db.run(
    "DELETE FROM intake_nonces WHERE at < ?",
    now - 2 * WINDOW_SECONDS * 1000,
  );
  const taken = await db.run(
    "INSERT OR IGNORE INTO intake_nonces (nonce, at) VALUES (?, ?)",
    nonce,
    now,
  );
  if (taken.changes === 0) return json(409, { error: "Already used." });
  try {
    return { json: JSON.parse(body) };
  } catch {
    return json(400, { error: "Not JSON." });
  }
}

/** What the customer chose to send besides their words: never conversations, mail, files or keys. */
export type Diagnostics = {
  appVersion: string;
  os: string;
  /** Recent warning and error lines, scrubbed on the customer's computer before they saw them. */
  logs: string[];
};

export type AppRequest = {
  /** The app's own id for this request (a UUID), the same on every retry. */
  requestId: string;
  customerId: string;
  installId: string;
  appVersion: string;
  language: "el" | "en";
  subject: string;
  message: string;
  urgent: boolean;
  /**
   * From blackark.uk's licences, which signed the forward: paid when an active licence exists.
   * "none" only for an install that is not activated yet, whose customer id is "unverified".
   */
  plan: "trial" | "paid" | "none";
  diagnostics: Diagnostics | null;
  /** Only on an unverified request: an address the person chose to give, not checked by anyone. */
  contactEmail: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function readDiagnostics(value: unknown): Diagnostics | null | "bad" {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return "bad";
  const body = value as Record<string, unknown>;
  const logs = body.logs;
  if (
    typeof body.appVersion !== "string" ||
    body.appVersion.length > 32 ||
    typeof body.os !== "string" ||
    body.os.length > 80 ||
    !Array.isArray(logs) ||
    logs.length > MAX_LOG_LINES ||
    logs.some((line) => typeof line !== "string" || line.length > 500)
  ) {
    return "bad";
  }
  return { appVersion: body.appVersion, os: body.os, logs: logs as string[] };
}

export function readAppRequest(value: unknown): AppRequest | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  const text = (key: string, max: number) =>
    typeof body[key] === "string" &&
    (body[key] as string).trim().length > 0 &&
    (body[key] as string).length <= max
      ? (body[key] as string).trim()
      : null;
  const requestId = text("requestId", 36);
  const customerId = text("customerId", 80);
  const installId = text("installId", 64);
  const appVersion = text("appVersion", 32);
  const subject = text("subject", 200);
  const message = text("message", 8000);
  const language =
    body.language === "el" || body.language === "en" ? body.language : null;
  const plan =
    body.plan === "paid" || body.plan === "trial" || body.plan === "none"
      ? body.plan
      : null;
  const diagnostics = readDiagnostics(body.diagnostics);
  const unverified = customerId === UNVERIFIED_CUSTOMER;
  const contact = body.contactEmail;
  const contactEmail =
    typeof contact === "string" && contact.length <= 254 && EMAIL.test(contact)
      ? contact
      : null;
  if (
    !requestId ||
    !UUID.test(requestId) ||
    !customerId ||
    !CUSTOMER_ID.test(customerId) ||
    !installId ||
    !appVersion ||
    !subject ||
    !message ||
    !language ||
    !plan ||
    // An unverified request is plan "none", and only it; it alone may carry a contact address.
    unverified !== (plan === "none") ||
    (contact !== undefined &&
      contact !== null &&
      (!unverified || !contactEmail)) ||
    typeof body.urgent !== "boolean" ||
    diagnostics === "bad"
  ) {
    return null;
  }
  return {
    requestId,
    customerId,
    installId,
    appVersion,
    language,
    subject,
    message,
    urgent: body.urgent,
    plan,
    diagnostics,
    contactEmail: unverified ? contactEmail : null,
  };
}

/** `POST /intake/app`: a signed request forwarded by blackark.uk opens one in-app case. */
export function appIntake(
  db: Sql,
  options: { secret: string; now?: () => number; calendar?: Calendar },
): Extension {
  const now = options.now ?? Date.now;
  return {
    async handle() {
      return null;
    },
    async handlePublic(request, url) {
      if (url.pathname !== "/intake/app") return null;
      const signed = await readSigned(db, request, options.secret, now());
      if (signed instanceof Response) return signed;
      const parsed = signed.json;
      const input = readAppRequest(parsed);
      if (!input) return json(400, { error: "Not a support request." });
      const already = await findBySource(db, `app:${input.requestId}`);
      if (already) {
        if (already.customer_id !== input.customerId)
          return json(409, { error: "Already used." });
        return json(200, { case: already.number });
      }
      const today =
        (
          await db.first<{ n: number }>(
            "SELECT COUNT(*) AS n FROM cases WHERE customer_id = ? AND channel = 'in-app' AND created_at >= ?",
            input.customerId,
            new Date(now() - 86_400_000).toISOString(),
          )
        )?.n ?? 0;
      if (
        today >=
        (input.plan === "none"
          ? MAX_UNVERIFIED_PER_DAY
          : MAX_PER_CUSTOMER_PER_DAY)
      )
        return json(429, { error: "Too many today." });
      const from = `From install ${input.installId.slice(0, 8)} (v${input.appVersion}):`;
      const made = await openCase(
        db,
        {
          customerId: input.customerId,
          channel: "in-app",
          language: input.language,
          priority: input.urgent ? "urgent" : "normal",
          // The cases table takes trial or paid; "none" shows from the unverified customer id.
          plan: input.plan === "none" ? "trial" : input.plan,
          subject: input.subject,
          note:
            input.plan === "none"
              ? [
                  "UNVERIFIED: sent before this install was activated. No BlackArk proof says whose install it is.",
                  `Contact email given: ${input.contactEmail ?? "none"}${input.contactEmail ? " (not checked)" : ""}`,
                  from,
                  input.message,
                ].join("\n")
              : `${from}\n${input.message}`,
          sourceRef: `app:${input.requestId}`,
        },
        "intake:app",
        now(),
        options.calendar,
      );
      // So BlackArk's replies reach this install (and the address given before activation).
      await setReach(db, made.number, {
        installId: input.installId,
        email: input.contactEmail,
      });
      if (input.diagnostics) {
        const d = input.diagnostics;
        await addNote(
          db,
          made.number,
          "intake:app",
          [
            "Diagnostics the customer chose to send (scrubbed on their computer):",
            `App version: ${d.appVersion}`,
            `System: ${d.os}`,
            `Recent warnings and errors (${d.logs.length}):`,
            ...d.logs,
          ].join("\n"),
          now(),
        );
      }
      await appendAudit(
        db,
        {
          actor: "intake:app",
          action: "case.create",
          target: `case:${made.number}`,
          outcome: "ok",
          detail: `customer ${input.customerId}, ${input.plan}${input.urgent ? ", urgent" : ""}${input.diagnostics ? ", diagnostics" : ""}`,
        },
        now(),
      );
      return json(201, { case: made.number });
    },
  };
}

// ---- The support mailbox -----------------------------------------------------------------------

export type MailMessage = {
  /** The Message-ID header, without the angle brackets. */
  id: string;
  inReplyTo?: string;
  from: string;
  /** The To and Cc addresses, lower-case. */
  to: string[];
  cc: string[];
  subject: string;
  text: string;
};

/**
 * A mailbox: `graphMailbox` in mail.ts (General@ through Microsoft Graph, only what was sent to support@), or the
 * in-memory stand-in below. `unseen` gives the messages not taken yet, read or not (a person may have
 * opened one in Outlook first: live, 24 Nov), asking `taken` by Message-ID so ones already taken do
 * not fill the run; it must not mark anything read. `markSeen` marks one message read.
 */
export interface MailSource {
  unseen(taken?: (id: string) => Promise<boolean>): Promise<MailMessage[]>;
  markSeen(id: string): Promise<void>;
}

/** Whether the board already took this Message-ID, as a case or as a note on one. */
export async function alreadyTaken(db: Sql, id: string): Promise<boolean> {
  return (
    (await findBySource(db, `mail:${id}`)) !== null ||
    (await db.first(
      "SELECT 1 AS found FROM case_notes WHERE instr(body, ?) > 0",
      `Message-ID: ${id}\n`,
    )) !== null
  );
}

export const SUPPORT_ADDRESS = "support@blackark.uk";

/** Whether a message was sent to the support address (To or Cc), not merely to General@. */
export function sentToSupport(
  message: Pick<MailMessage, "to" | "cc">,
  address = SUPPORT_ADDRESS,
): boolean {
  const want = address.toLowerCase();
  return [...message.to, ...message.cc].some(
    (one) => one.toLowerCase() === want,
  );
}

/** The address in "Name <address>" or a bare address; null when it is not one. */
export function senderAddress(from: string): string | null {
  const address = (from.match(/<([^<>]+)>\s*$/)?.[1] ?? from).trim();
  return address.length <= 254 && EMAIL.test(address) ? address : null;
}

const CASE_TAG = /\[(?:Case|Υπόθεση) #(\d{1,9})\]/i;

/**
 * The addresses this board knows for a customer (security review of v0.1.54, F8): the one their
 * 24/7 support order was bought with, and the administrator's in the team their app last sent.
 */
export async function knownAddresses(
  db: Sql,
  customerId: string,
): Promise<Set<string>> {
  const found = new Set<string>();
  const orders = await db.all<{ email: string | null }>(
    "SELECT email FROM support_orders WHERE customer_id = ?",
    customerId,
  );
  for (const row of orders)
    if (row.email) found.add(row.email.trim().toLowerCase());
  const team = await db.first<{ members: string }>(
    "SELECT members FROM customer_teams WHERE customer_id = ?",
    customerId,
  );
  try {
    for (const member of JSON.parse(team?.members ?? "[]") as {
      email?: unknown;
      role?: unknown;
    }[])
      if (member.role === "admin" && typeof member.email === "string")
        found.add(member.email.trim().toLowerCase());
  } catch {}
  return found;
}

/** What staff see first on a note or case whose sender the board could not match. */
export const UNCONFIRMED_SENDER =
  "UNCONFIRMED SENDER: this address is not one the board knows for this customer. Check who it is before replying with any customer details.";
const CUSTOMER_TAG = /\[customer:([A-Za-z0-9][A-Za-z0-9_-]{1,79})\]/;

/**
 * Reads the mailbox once: a reply (In-Reply-To a message we know, or "[Case #N]" in the subject)
 * becomes a note on that case; anything else opens a case, channel email. The customer id comes
 * from "[customer:<id>]" in the subject when present, otherwise "unmatched" for a person to set.
 * Each message is taken once (its Message-ID), read or not, then marked read. A message not sent to
 * the support address is left alone, as it was, even if the mailbox handed it over.
 */
export async function pollMailbox(
  db: Sql,
  mailbox: MailSource,
  now: number,
  options: { supportAddress?: string; calendar?: Calendar } = {},
): Promise<number[]> {
  const touched: number[] = [];
  for (const message of await mailbox.unseen((id) => alreadyTaken(db, id))) {
    if (!sentToSupport(message, options.supportAddress)) continue;
    const ref = `mail:${message.id}`;
    if (await alreadyTaken(db, message.id)) {
      await mailbox.markSeen(message.id);
      continue;
    }
    const body =
      `From: ${message.from}\nMessage-ID: ${message.id}\nSubject: ${message.subject}\n\n${message.text}`.slice(
        0,
        8000,
      );
    const tagged = message.subject.match(CASE_TAG);
    const repliedTo = message.inReplyTo
      ? await findBySource(db, `mail:${message.inReplyTo}`)
      : null;
    const existing =
      repliedTo ?? (tagged ? await getCase(db, Number(tagged[1])) : null);
    const sender = senderAddress(message.from)?.toLowerCase() ?? null;
    if (existing) {
      // A reply to the board's own mail is threaded by Message-ID; a subject tag anybody can write.
      const reach = await reachOf(db, existing.number);
      const known = await knownAddresses(db, existing.customer_id);
      if (reach?.email) known.add(reach.email.toLowerCase());
      const confirmed = sender !== null && known.has(sender);
      await addNote(
        db,
        existing.number,
        "intake:mail",
        confirmed ? body : `${UNCONFIRMED_SENDER}\n\n${body}`.slice(0, 8000),
        now,
      );
      await appendAudit(
        db,
        {
          actor: "intake:mail",
          action: "case.note",
          target: `case:${existing.number}`,
          outcome: "ok",
          ...(confirmed ? {} : { detail: "sender not confirmed" }),
        },
        now,
      );
      touched.push(existing.number);
    } else {
      // A customer tag is believed only from an address the board knows for that customer.
      const named = message.subject.match(CUSTOMER_TAG)?.[1] ?? null;
      const trusted =
        named !== null &&
        sender !== null &&
        (await knownAddresses(db, named)).has(sender);
      const customerId = trusted ? (named as string) : "unmatched";
      const made = await openCase(
        db,
        {
          customerId,
          channel: "email",
          language: /[Ͱ-Ͽ]/.test(`${message.subject} ${message.text}`)
            ? "el"
            : "en",
          priority: "normal",
          // Mail carries no signed plan; a person changes the urgency if the customer pays.
          plan: "trial",
          subject: message.subject.slice(0, 200) || "(no subject)",
          note:
            named !== null && !trusted
              ? `${UNCONFIRMED_SENDER} It names customer ${named}.\n\n${body}`.slice(
                  0,
                  8000,
                )
              : body,
          sourceRef: ref,
        },
        "intake:mail",
        now,
        options.calendar,
      );
      await appendAudit(
        db,
        {
          actor: "intake:mail",
          action: "case.create",
          target: `case:${made.number}`,
          outcome: "ok",
          detail: `customer ${customerId}`,
        },
        now,
      );
      const address = senderAddress(message.from);
      if (address) await setReach(db, made.number, { email: address });
      touched.push(made.number);
    }
    await mailbox.markSeen(message.id);
  }
  return touched;
}

/** A mailbox in memory, for the tests and the design. */
export function standInMailbox(
  messages: MailMessage[],
): MailSource & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    async unseen() {
      return messages.filter((message) => !seen.includes(message.id));
    },
    async markSeen(id) {
      seen.push(id);
    },
  };
}
