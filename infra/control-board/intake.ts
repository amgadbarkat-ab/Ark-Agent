/**
 * Ways a support case can open by itself (#149, milestone 2). DESIGN STAGE: both are built and
 * tested against stand-ins, and neither is switched on (see .scratch/control-board/intake-design.md).
 *
 * 1. The app's future "Help & support" form: `POST /intake/app`, HMAC-signed like the check-in
 *    export (X-Ark-Time, X-Ark-Nonce, X-Ark-Signature over "<time>.<nonce>.<body>" with
 *    INTAKE_SECRET), within 5 minutes, each nonce once. Mounted only when INTAKE_SECRET is set.
 *    Who signs is the open question in the design: a secret built into every app can be read out
 *    of it, so the proposal is that blackark.uk signs, after checking the install's signed profile.
 * 2. A support mailbox, read by a poller through `MailSource`. Only a stand-in exists: a real IMAP
 *    client needs the mailbox and its password, after Amgad's yes.
 */
import type { Database } from "bun:sqlite";
import { createHmac, timingSafeEqual } from "node:crypto";
import { appendAudit } from "./audit";
import { CUSTOMER_ID, type Extension } from "./board";
import { addNote, findBySource, getCase, openCase } from "./cases";

const WINDOW_SECONDS = 300;
const MAX_PER_CUSTOMER_PER_DAY = 20;

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

export type AppRequest = {
  customerId: string;
  installId: string;
  appVersion: string;
  language: "el" | "en";
  subject: string;
  message: string;
};

function readAppRequest(value: unknown): AppRequest | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  const text = (key: string, max: number) =>
    typeof body[key] === "string" &&
    (body[key] as string).trim().length > 0 &&
    (body[key] as string).length <= max
      ? (body[key] as string).trim()
      : null;
  const customerId = text("customerId", 80);
  const installId = text("installId", 64);
  const appVersion = text("appVersion", 32);
  const subject = text("subject", 200);
  const message = text("message", 8000);
  const language =
    body.language === "el" || body.language === "en" ? body.language : null;
  if (
    !customerId ||
    !CUSTOMER_ID.test(customerId) ||
    !installId ||
    !appVersion ||
    !subject ||
    !message ||
    !language
  ) {
    return null;
  }
  return { customerId, installId, appVersion, language, subject, message };
}

/** `POST /intake/app`: a signed request from the app's form opens one case, channel in-app. */
export function appIntake(
  db: Database,
  options: { secret: string; now?: () => number },
): Extension {
  const now = options.now ?? Date.now;
  return {
    async handle() {
      return null;
    },
    async handlePublic(request, url) {
      if (url.pathname !== "/intake/app") return null;
      if (request.method !== "POST") return json(405, { error: "POST only." });
      if (Number(request.headers.get("content-length") ?? "0") > 16_384)
        return json(413, { error: "Too large." });
      const body = (await request.text()).slice(0, 16_385);
      if (body.length > 16_384) return json(413, { error: "Too large." });
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
      db.query("DELETE FROM intake_nonces WHERE at < ?").run(
        now() - 2 * WINDOW_SECONDS * 1000,
      );
      const taken = db
        .query("INSERT OR IGNORE INTO intake_nonces (nonce, at) VALUES (?, ?)")
        .run(nonce, now());
      if (taken.changes === 0) return json(409, { error: "Already used." });
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return json(400, { error: "Not JSON." });
      }
      const input = readAppRequest(parsed);
      if (!input) return json(400, { error: "Not a support request." });
      const today =
        db
          .query<{ n: number }, [string, string]>(
            "SELECT COUNT(*) AS n FROM cases WHERE customer_id = ? AND channel = 'in-app' AND created_at >= ?",
          )
          .get(input.customerId, new Date(now() - 86_400_000).toISOString())
          ?.n ?? 0;
      if (today >= MAX_PER_CUSTOMER_PER_DAY)
        return json(429, { error: "Too many today." });
      const made = openCase(
        db,
        {
          customerId: input.customerId,
          channel: "in-app",
          language: input.language,
          priority: "normal",
          subject: input.subject,
          note: `From install ${input.installId.slice(0, 8)} (v${input.appVersion}):\n${input.message}`,
          sourceRef: `app:${nonce}`,
        },
        "intake:app",
        now(),
      );
      appendAudit(
        db,
        {
          actor: "intake:app",
          action: "case.create",
          target: `case:${made.number}`,
          outcome: "ok",
          detail: `customer ${input.customerId}`,
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
  subject: string;
  text: string;
};

/** A mailbox: today only a stand-in. The real one is IMAP over TLS (see intake-design.md). */
export interface MailSource {
  unseen(): Promise<MailMessage[]>;
  markSeen(id: string): Promise<void>;
}

const CASE_TAG = /\[(?:Case|Υπόθεση) #(\d{1,9})\]/i;
const CUSTOMER_TAG = /\[customer:([A-Za-z0-9][A-Za-z0-9_-]{1,79})\]/;

/**
 * Reads the mailbox once: a reply (In-Reply-To a message we know, or "[Case #N]" in the subject)
 * becomes a note on that case; anything else opens a case, channel email. The customer id comes
 * from "[customer:<id>]" in the subject when present, otherwise "unmatched" for a person to set.
 * Each message is taken once (its Message-ID), then marked seen.
 */
export async function pollMailbox(
  db: Database,
  mailbox: MailSource,
  now: number,
): Promise<number[]> {
  const touched: number[] = [];
  for (const message of await mailbox.unseen()) {
    const ref = `mail:${message.id}`;
    if (
      findBySource(db, ref) ||
      db
        .query("SELECT 1 FROM case_notes WHERE instr(body, ?) > 0")
        .get(`Message-ID: ${message.id}\n`)
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
      ? findBySource(db, `mail:${message.inReplyTo}`)
      : null;
    const existing =
      repliedTo ?? (tagged ? getCase(db, Number(tagged[1])) : null);
    if (existing) {
      addNote(db, existing.number, "intake:mail", body, now);
      appendAudit(
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
      const made = openCase(
        db,
        {
          customerId,
          channel: "email",
          language: /[Ͱ-Ͽ]/.test(`${message.subject} ${message.text}`)
            ? "el"
            : "en",
          priority: "normal",
          subject: message.subject.slice(0, 200) || "(no subject)",
          note: body,
          sourceRef: ref,
        },
        "intake:mail",
        now,
      );
      appendAudit(
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
