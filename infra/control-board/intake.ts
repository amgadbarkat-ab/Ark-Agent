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
 *    (`pollMailbox`, with the IMAP reader in mail.ts) takes only what was sent to support@.
 */
import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";
import { appendAudit } from "./audit";
import { CUSTOMER_ID, type Extension } from "./board";
import type { Calendar } from "./business-hours";
import { addNote, findBySource, getCase, openCase } from "./cases";
import type { Sql } from "./sql";

const WINDOW_SECONDS = 300;
const MAX_PER_CUSTOMER_PER_DAY = 20;
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

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
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
  /** From blackark.uk's licences, which signed the forward: paid when an active licence exists. */
  plan: "trial" | "paid";
  diagnostics: Diagnostics | null;
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
  const plan = body.plan === "paid" || body.plan === "trial" ? body.plan : null;
  const diagnostics = readDiagnostics(body.diagnostics);
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
      if (request.method !== "POST") return json(405, { error: "POST only." });
      if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY)
        return json(413, { error: "Too large." });
      const body = (await request.text()).slice(0, MAX_BODY + 1);
      if (body.length > MAX_BODY) return json(413, { error: "Too large." });
      const time = request.headers.get("x-ark-time") ?? "";
      const nonce = request.headers.get("x-ark-nonce") ?? "";
      const signature = Buffer.from(
        request.headers.get("x-ark-signature") ?? "",
      );
      const expected = Buffer.from(
        signIntake(options.secret, time, nonce, body),
      );
      if (
        !/^\d{1,12}$/.test(time) ||
        !/^[A-Za-z0-9_-]{16,64}$/.test(nonce) ||
        signature.length !== expected.length ||
        !timingSafeEqual(signature, expected)
      ) {
        return json(403, { error: "Bad signature." });
      }
      if (Math.abs(now() / 1000 - Number(time)) > WINDOW_SECONDS)
        return json(403, { error: "Stale request." });
      await db.run(
        "DELETE FROM intake_nonces WHERE at < ?",
        now() - 2 * WINDOW_SECONDS * 1000,
      );
      const taken = await db.run(
        "INSERT OR IGNORE INTO intake_nonces (nonce, at) VALUES (?, ?)",
        nonce,
        now(),
      );
      if (taken.changes === 0) return json(409, { error: "Already used." });
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return json(400, { error: "Not JSON." });
      }
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
      if (today >= MAX_PER_CUSTOMER_PER_DAY)
        return json(429, { error: "Too many today." });
      const made = await openCase(
        db,
        {
          customerId: input.customerId,
          channel: "in-app",
          language: input.language,
          priority: input.urgent ? "urgent" : "normal",
          plan: input.plan,
          subject: input.subject,
          note: `From install ${input.installId.slice(0, 8)} (v${input.appVersion}):\n${input.message}`,
          sourceRef: `app:${input.requestId}`,
        },
        "intake:app",
        now(),
        options.calendar,
      );
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
 * A mailbox: `imapMailbox` in mail.ts (General@ over IMAP, only what was sent to support@), or the
 * in-memory stand-in below. `unseen` must not mark anything read; `markSeen` marks one message.
 */
export interface MailSource {
  unseen(): Promise<MailMessage[]>;
  markSeen(id: string): Promise<void>;
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

const CASE_TAG = /\[(?:Case|Υπόθεση) #(\d{1,9})\]/i;
const CUSTOMER_TAG = /\[customer:([A-Za-z0-9][A-Za-z0-9_-]{1,79})\]/;

/**
 * Reads the mailbox once: a reply (In-Reply-To a message we know, or "[Case #N]" in the subject)
 * becomes a note on that case; anything else opens a case, channel email. The customer id comes
 * from "[customer:<id>]" in the subject when present, otherwise "unmatched" for a person to set.
 * Each message is taken once (its Message-ID), then marked seen. A message not sent to the support
 * address is left alone, unread, even if the mailbox handed it over.
 */
export async function pollMailbox(
  db: Sql,
  mailbox: MailSource,
  now: number,
  options: { supportAddress?: string; calendar?: Calendar } = {},
): Promise<number[]> {
  const touched: number[] = [];
  for (const message of await mailbox.unseen()) {
    if (!sentToSupport(message, options.supportAddress)) continue;
    const ref = `mail:${message.id}`;
    if (
      (await findBySource(db, ref)) ||
      (await db.first(
        "SELECT 1 AS found FROM case_notes WHERE instr(body, ?) > 0",
        `Message-ID: ${message.id}\n`,
      ))
    ) {
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
    if (existing) {
      await addNote(db, existing.number, "intake:mail", body, now);
      await appendAudit(
        db,
        {
          actor: "intake:mail",
          action: "case.note",
          target: `case:${existing.number}`,
          outcome: "ok",
        },
        now,
      );
      touched.push(existing.number);
    } else {
      const customerId =
        message.subject.match(CUSTOMER_TAG)?.[1] ?? "unmatched";
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
          note: body,
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
