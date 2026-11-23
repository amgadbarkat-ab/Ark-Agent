/**
 * Replies to the customer (Gap 3, Amgad 23 Nov 2026, #149): staff answer a case from the board.
 *
 * - The customer's language first, then an English copy below it (GCC English, as staff write it).
 *   Staff write both: no text of a customer's case is sent to any model to translate.
 * - By email, when the case has an address: the sender of an email case, or the address a person
 *   gave before their install was activated. It goes from General@ through Microsoft Graph with From
 *   and Reply-To support@blackark.uk, in BlackArk's HTML look with a plain-text part, and
 *   "[Case #N]" in the subject so the customer's answer comes back to the same case (intake.ts).
 * - In the app, when the case came from an install: blackark.uk asks `POST /intake/replies`, signed
 *   with INTAKE_SECRET as the intake is, for one install's cases and their replies, after checking
 *   that install's proof (or, before activation, that it is the same unverified install).
 * - Each reply is kept as sent (never changed or removed), written into the case notes with its text,
 *   and into the audit log without it. A new or open case then waits for the customer.
 */
import { CUSTOMER_ID, type Extension } from "./board";
import { addNote, type Case, changeCase, reachOf } from "./cases";
import { json, readSigned } from "./intake";
import type { Sql } from "./sql";

export type Reply = {
  id: number;
  case_number: number;
  at: string;
  author: string;
  language: "el" | "en";
  body: string;
  english: string | null;
  emailed_to: string | null;
  email: "sent" | "failed" | "none";
};

export function repliesOf(sql: Sql, number: number): Promise<Reply[]> {
  return sql.all<Reply>(
    "SELECT * FROM case_replies WHERE case_number = ? ORDER BY id",
    number,
  );
}

/** One email to one customer. `text` is the plain-text part; `html` the same words, styled. */
export type OutgoingMail = {
  to: string;
  subject: string;
  text: string;
  html: string;
  language: "el" | "en";
  /** For the Message-ID, so a case's replies can be told apart in a mail log. */
  caseNumber: number;
};

export interface ReplyMailer {
  send(mail: OutgoingMail): Promise<void>;
}

export const MAX_REPLY = 8000;

/** "[Case #12] The line does not answer": the tag intake reads to thread the answer back. */
export function replySubject(row: Pick<Case, "number" | "subject">): string {
  const tag = `[Case #${row.number}]`;
  const subject = row.subject.replace(/^(?:re|fw|fwd|απ|σχετ)\s*:\s*/i, "");
  return (subject.includes(tag) ? subject : `${tag} ${subject}`.trim()).slice(
    0,
    250,
  );
}

const CLOSING: Record<"el" | "en", string> = {
  el: "Για να μας απαντήσετε, απαντήστε σε αυτό το email.\nBlackArk Support",
  en: "To answer us, reply to this email.\nBlackArk Support",
};

/**
 * The plain text of a reply email: the customer's language, then (for a Greek case) a line of "---"
 * and the English copy. The closing line is BlackArk's own, in the same two languages.
 */
export function replyText(
  language: "el" | "en",
  body: string,
  english: string | null,
): string {
  const first = `${body.trim()}\n\n${CLOSING[language]}`;
  return language === "en" || !english
    ? first
    : `${first}\n\n---\n\n${english.trim()}\n\n${CLOSING.en}`;
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ESCAPES[c] as string);

const FONT = "Geist,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/**
 * The same words in BlackArk's look: the same template as blackark.uk's low-balance email
 * (checkin/lib.php, `ark_email_html`), so every email a customer gets from BlackArk looks alike.
 * Paragraphs stay paragraphs, "---" divides the customer's language from the English copy, and a
 * line that is only an https address becomes a link. Inline styles only: mail apps drop the rest.
 */
export function replyHtml(
  text: string,
  language: "el" | "en",
  title: string,
  brandBase = "https://blackark.uk/checkin",
): string {
  const sections = text.replace(/\r\n/g, "\n").split(/\n-{3,}\n/);
  const parts = sections.map((section, index) => {
    const lang = index === 0 ? language : "en";
    const paragraphs = section
      .trim()
      .split(/\n{2,}/)
      .map((paragraph) => {
        const lines = paragraph.split("\n").map((raw) => {
          const line = raw.trim();
          return /^https:\/\/[^\s<>"]+$/.test(line)
            ? `<a href="${escapeHtml(line)}" style="color:#ff9a3c;text-decoration:underline;word-break:break-all;">${escapeHtml(line)}</a>`
            : escapeHtml(line);
        });
        return `<p style="margin:0 0 16px;">${lines.join("<br>")}</p>`;
      });
    return `<div lang="${lang}">${paragraphs.join("")}</div>`;
  });
  const rule =
    '<hr style="border:0;border-top:1px solid #2a211b;margin:24px 0;">';
  return (
    `<!doctype html><html lang="${language}"><head><meta charset="utf-8">` +
    '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark">' +
    `<title>${escapeHtml(title)}</title></head>` +
    '<body style="margin:0;padding:0;background:#070504;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#070504;"><tr><td align="center" style="padding:24px 12px;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">' +
    `<tr><td style="padding:0 4px 20px;font-family:${FONT};font-size:16px;font-weight:600;color:#f3f2ef;">` +
    `<img src="${escapeHtml(`${brandBase.replace(/\/+$/, "")}/brand/favicon-192.png`)}" width="28" height="28" alt="" style="vertical-align:middle;border:0;border-radius:6px;margin-right:10px;">BlackArk</td></tr>` +
    `<tr><td style="background:#110b07;border:1px solid #2a211b;border-radius:12px;padding:28px 24px;font-family:${FONT};font-size:15px;line-height:1.6;color:#f3f2ef;">` +
    '<div style="height:3px;width:56px;border-radius:2px;background:#ff7a1a;background-image:linear-gradient(105deg,#ffb067,#ff7a1a 38%,#f2551b 78%,#e5481a);margin:0 0 20px;"></div>' +
    parts.join(rule) +
    "</td></tr>" +
    `<tr><td style="padding:16px 4px 0;font-family:${FONT};font-size:12px;color:#9b9893;">BlackArk · <a href="https://blackark.uk/" style="color:#9b9893;">blackark.uk</a></td></tr>` +
    "</table></td></tr></table></body></html>"
  );
}

/** How a reply to this case would reach the customer, before anyone writes it. */
export async function replyRoute(
  sql: Sql,
  row: Case,
  mailer: ReplyMailer | null,
): Promise<{ email: string | null; app: boolean; mailReady: boolean }> {
  const reach = await reachOf(sql, row.number);
  return {
    email: reach?.email ?? null,
    app: row.channel === "in-app" && !!reach?.install_id,
    mailReady: mailer !== null,
  };
}

export type ReplyOutcome = {
  reply: Reply;
  /** For the audit log: how it went, never the words. */
  detail: string;
};

/**
 * Sends (when it can) and keeps one reply. Refused with null when the case has no way back to the
 * customer at all, so nobody writes a reply that goes nowhere.
 */
export async function replyToCase(
  sql: Sql,
  mailer: ReplyMailer | null,
  row: Case,
  by: string,
  words: { body: string; english: string | null },
  now: number,
): Promise<ReplyOutcome | null> {
  const route = await replyRoute(sql, row, mailer);
  const english = row.language === "el" ? words.english : null;
  if (!route.app && !(route.email && mailer)) return null;
  let email: Reply["email"] = "none";
  let failure = "";
  if (route.email && mailer) {
    const subject = replySubject(row);
    const text = replyText(row.language, words.body, english);
    try {
      await mailer.send({
        to: route.email,
        subject,
        text,
        html: replyHtml(text, row.language, subject),
        language: row.language,
        caseNumber: row.number,
      });
      email = "sent";
    } catch (error) {
      email = "failed";
      // GraphError carries only the HTTP status; nothing else is kept.
      failure =
        error instanceof Error && error.name === "GraphError"
          ? error.message
          : "the mail service did not answer";
    }
  }
  const at = new Date(now).toISOString();
  const made = await sql.run(
    "INSERT INTO case_replies (case_number, at, author, language, body, english, emailed_to, email) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    row.number,
    at,
    by,
    row.language,
    words.body,
    english,
    email === "none" ? null : route.email,
    email,
  );
  const how = [
    email === "sent" ? `emailed to ${route.email}` : "",
    email === "failed" ? `NOT emailed to ${route.email}: ${failure}` : "",
    route.app ? "shown in the app" : "",
  ]
    .filter(Boolean)
    .join("; ");
  await addNote(
    sql,
    row.number,
    by,
    `Reply to the customer (${how}):\n\n${words.body}${english ? `\n\n--- English copy ---\n${english}` : ""}`,
    now,
  );
  if (row.status === "new" || row.status === "open")
    await changeCase(sql, row, { status: "waiting" }, now);
  const reply = (await sql.first<Reply>(
    "SELECT * FROM case_replies WHERE id = ?",
    made.lastRowId,
  )) as Reply;
  return {
    reply,
    detail: [
      email === "sent" ? "emailed" : "",
      email === "failed" ? `email failed (${failure})` : "",
      route.app ? "app" : "",
    ]
      .filter(Boolean)
      .join(", "),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_CASES = 20;

/**
 * `POST /intake/replies`: blackark.uk, having checked the install, asks for that install's own
 * in-app cases and BlackArk's replies to them. Only cases opened from this install AND for this
 * customer id come back, newest first, at most 20; never a note.
 */
export function appReplies(
  db: Sql,
  options: { secret: string; now?: () => number },
): Extension {
  const now = options.now ?? Date.now;
  return {
    async handle() {
      return null;
    },
    async handlePublic(request, url) {
      if (url.pathname !== "/intake/replies") return null;
      const signed = await readSigned(db, request, options.secret, now());
      if (signed instanceof Response) return signed;
      const body = signed.json as Record<string, unknown> | null;
      const customerId = body?.customerId;
      const installId = body?.installId;
      if (
        typeof customerId !== "string" ||
        !CUSTOMER_ID.test(customerId) ||
        typeof installId !== "string" ||
        !UUID.test(installId)
      )
        return json(400, { error: "Not a replies request." });
      const cases = await db.all<
        Pick<Case, "number" | "subject" | "status" | "created_at">
      >(
        `SELECT c.number, c.subject, c.status, c.created_at FROM cases c
         JOIN case_reach r ON r.case_number = c.number
         WHERE r.install_id = ? AND c.customer_id = ? AND c.channel = 'in-app'
         ORDER BY c.number DESC LIMIT ${MAX_CASES}`,
        installId,
        customerId,
      );
      const out = [];
      for (const one of cases) {
        out.push({
          case: one.number,
          subject: one.subject,
          status: one.status,
          openedAt: one.created_at,
          replies: (await repliesOf(db, one.number)).map((reply) => ({
            at: reply.at,
            language: reply.language,
            text: reply.body,
            english: reply.english,
          })),
        });
      }
      return json(200, { cases: out });
    },
  };
}
