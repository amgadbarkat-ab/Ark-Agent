/**
 * What the Gmail and Microsoft 365 send tools share: reading recipients out of what a model wrote,
 * strictly (desk #83, the Wine24 email scene).
 *
 * A send tool is a write, so every call is held for the person to approve first (see
 * `call-outcome.ts`), and the card shows exactly these arguments. What is checked here is the shape:
 * that each recipient is one address and nothing else, because a recipient or a subject with a line
 * break in it is how a message grows headers nobody approved (a Bcc, most of all).
 */

/** The most recipients one message may have across To and Cc. A demo email, not a mailing list. */
export const MAX_RECIPIENTS = 20;

/** The most characters a subject may have. */
export const MAX_SUBJECT = 300;

/** The most characters a body may have. */
export const MAX_BODY = 50_000;

/** One plain address: something, an at sign, a domain with a dot. No spaces, angle brackets or line breaks. */
const ADDRESS =
  /^[^\s@<>(),;:"\\[\]]+@[^\s@<>(),;:"\\[\]]+\.[^\s@<>(),;:"\\[\]]+$/;

export type Recipients =
  | { ok: true; addresses: string[] }
  | { ok: false; message: string };

/** The addresses in a string ("a@x.gr, b@y.gr") or a list, each checked. Empty is an empty list. */
export function recipientsFrom(value: unknown, field: string): Recipients {
  if (value === undefined || value === null || value === "") {
    return { ok: true, addresses: [] };
  }
  const parts = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,;]/)
      : null;
  if (!parts) {
    return {
      ok: false,
      message: `${field} must be one or more email addresses.`,
    };
  }
  const addresses: string[] = [];
  for (const part of parts) {
    if (typeof part !== "string") {
      return {
        ok: false,
        message: `${field} must be one or more email addresses.`,
      };
    }
    const address = part.trim();
    if (address === "") continue;
    if (!ADDRESS.test(address)) {
      return {
        ok: false,
        message: `"${address.slice(0, 80)}" in ${field} is not one email address. Give plain addresses, separated by commas.`,
      };
    }
    addresses.push(address);
  }
  return { ok: true, addresses };
}

/** A subject on one line, within its length. Null when there is none. */
export function subjectFrom(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const subject = value.replace(/[\r\n]+/g, " ").trim();
  return subject ? subject.slice(0, MAX_SUBJECT) : null;
}

/** A body within its length. Null when there is none. */
export function bodyFrom(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  return value.slice(0, MAX_BODY);
}
