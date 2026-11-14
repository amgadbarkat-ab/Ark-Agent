/**
 * Gmail over Google's REST API, for the catalogue's `gmail` entry (desk #83: DT Lab needs a Gmail test
 * mailbox, and Gmail was listed as "Not yet").
 *
 * Search, list and read, and one write: `send_message` (desk #83, the Wine24 email scene). Nothing
 * deletes, labels or marks as read. The scopes are `gmail.readonly` and `gmail.send`, so Google
 * itself refuses anything else, and the tools below are the only things a digital employee is
 * offered. `send_message` is on the catalogue's write list, so every call to it is held for the
 * person to approve, with the message shown, before it goes.
 *
 * The same Google OAuth client an administrator set up for Google Drive works here; each person
 * connects their own mailbox, and an answer only ever comes from the mailbox of whoever asked.
 *
 * WHAT COMES BACK IS TEXT. A message is its headers and its plain-text body (or the HTML body with the
 * markup taken out, when a message has no plain part). Attachments are named, never fetched.
 */
import { cutAtCodeUnits } from "../channels/text";
import {
  bodyFrom,
  MAX_RECIPIENTS,
  recipientsFrom,
  subjectFrom,
} from "./mail-send";
import { MAX_RESULT_CHARS, type McpCallResult, type McpTool } from "./mcp";

const REQUEST_TIMEOUT_MS = 30_000;

/** How many messages one search or listing returns. */
const PAGE_SIZE = 20;

/** The headers a person reads a message by. */
const SUMMARY_HEADERS = ["From", "To", "Subject", "Date"] as const;

const TOOLS: readonly McpTool[] = Object.freeze([
  {
    name: "search_messages",
    description:
      "Search your Gmail with Gmail's own search words, for example: from:anna@example.com, subject:order, newer_than:7d, has:attachment, is:unread. Returns matching messages with sender, subject, date, a short preview and the message id.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What to search for, as you would type it in Gmail.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "list_recent_messages",
    description:
      "List the newest messages in your Gmail inbox, newest first, with sender, subject, date, a short preview and the message id.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_message",
    description:
      "Read one Gmail message by its id: who sent it, to whom, the subject, the date, the text and the names of any attachments.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "The message's Gmail id." },
      },
      required: ["messageId"],
    },
  },
  {
    name: "send_message",
    description:
      "Send an email from your Gmail. The person is shown the message and approves it before it is sent. Plain text. Use to and cc for addresses, separated by commas.",
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description:
            "Who it is to: one or more email addresses, separated by commas.",
        },
        cc: {
          type: "string",
          description:
            "Optional. Copied to: email addresses, separated by commas.",
        },
        subject: { type: "string", description: "The subject line." },
        body: { type: "string", description: "The message, as plain text." },
      },
      required: ["to", "subject", "body"],
    },
  },
]);

type Connection = { url: string; token?: string };

/** The tool list is fixed here, so listing needs nobody's mailbox. */
export const listNeedsCredential = false;

export async function listTools(_connection: Connection): Promise<McpTool[]> {
  return TOOLS.map((tool) => ({ ...tool }));
}

async function request(
  connection: Connection,
  path: string,
  query: Record<string, string | string[]>,
  post?: unknown,
): Promise<{ ok: true; body: unknown } | { ok: false; message: string }> {
  if (!connection.token) {
    return { ok: false, message: "No credential was available for this call." };
  }
  const url = new URL(`${connection.url.replace(/\/+$/, "")}${path}`);
  for (const [key, value] of Object.entries(query)) {
    for (const each of Array.isArray(value) ? value : [value]) {
      url.searchParams.append(key, each);
    }
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: post === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${connection.token}`,
        ...(post === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(post === undefined ? {} : { body: JSON.stringify(post) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error && error.name === "TimeoutError"
          ? "Gmail did not answer in time."
          : `Gmail could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!response.ok) {
    // Google's own sentence when it gives one, which is what tells a person what to fix.
    const text = await response.text().catch(() => "");
    let detail = "";
    try {
      const parsed = JSON.parse(text) as { error?: { message?: unknown } };
      if (typeof parsed.error?.message === "string") {
        detail = parsed.error.message;
      }
    } catch {
      // Not JSON: the status alone.
    }
    // A grant made before sending was added has no permission to send: the fix is to connect again.
    const reconnect =
      response.status === 403 && /insufficient|scope/i.test(detail)
        ? " Connect Gmail again in Settings, then Connected accounts, so it can ask for permission to send."
        : "";
    return {
      ok: false,
      message: `${
        detail
          ? `Gmail refused this request (${response.status}): ${detail}`
          : `Gmail refused this request (${response.status}).`
      }${reconnect}`,
    };
  }

  try {
    return { ok: true, body: await response.json() };
  } catch {
    return { ok: false, message: "Gmail answered with something unreadable." };
  }
}

type Header = { name?: string; value?: string };
type Part = {
  mimeType?: string;
  filename?: string;
  headers?: Header[];
  body?: { data?: string; size?: number };
  parts?: Part[];
};
type Message = {
  id?: string;
  threadId?: string;
  snippet?: string;
  labelIds?: string[];
  payload?: Part;
};

function header(message: Message, name: string): string | undefined {
  const lower = name.toLowerCase();
  return message.payload?.headers?.find(
    (each) => each.name?.toLowerCase() === lower,
  )?.value;
}

/** Text as base64url, which is how Gmail takes a whole message. */
function base64url(text: string): string {
  return Buffer.from(text, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** A header value in UTF-8, as RFC 2047 says to write one that is not plain ASCII. */
function encodedWord(text: string): string {
  return /^[\x20-\x7e]*$/.test(text)
    ? text
    : `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

/**
 * One plain-text message as RFC 5322 text. Every header value here has already been checked to be
 * on one line (see `mail-send.ts`), so nothing in it can add a header the person did not approve.
 */
export function rfc822(message: {
  to: string[];
  cc: string[];
  subject: string;
  body: string;
}): string {
  const body = Buffer.from(message.body.replace(/\r?\n/g, "\r\n"), "utf8")
    .toString("base64")
    .replace(/.{1,76}/g, "$&\r\n");
  return [
    `To: ${message.to.join(", ")}`,
    ...(message.cc.length > 0 ? [`Cc: ${message.cc.join(", ")}`] : []),
    `Subject: ${encodedWord(message.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    body,
  ].join("\r\n");
}

/** Gmail's base64url body data, as text. */
export function decodeBody(data: string): string {
  const normal = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normal, "base64").toString("utf8");
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** An HTML body as readable text: block ends become line breaks, tags go, entities are decoded. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, body: string) => {
      if (body[0] === "#") {
        const code =
          body[1] === "x" || body[1] === "X"
            ? Number.parseInt(body.slice(2), 16)
            : Number.parseInt(body.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES[body.toLowerCase()] ?? whole;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Every part of a message, depth first. */
function partsOf(part: Part | undefined): Part[] {
  if (!part) return [];
  return [part, ...(part.parts ?? []).flatMap(partsOf)];
}

/** The message's text: its plain part, or its HTML part with the markup taken out. */
export function bodyText(message: Message): string {
  const parts = partsOf(message.payload);
  const isBody = (part: Part, type: string) =>
    part.mimeType?.toLowerCase() === type &&
    !part.filename &&
    typeof part.body?.data === "string";
  const plain = parts.find((part) => isBody(part, "text/plain"));
  if (plain?.body?.data) return decodeBody(plain.body.data).trim();
  const html = parts.find((part) => isBody(part, "text/html"));
  if (html?.body?.data) return htmlToText(decodeBody(html.body.data));
  return "";
}

function attachmentNames(message: Message): string[] {
  return partsOf(message.payload)
    .map((part) => part.filename?.trim())
    .filter((name): name is string => Boolean(name));
}

/**
 * Gmail sends a message's snippet HTML-escaped ("didn&#39;t"), and the card that shows it and the
 * model that reads it both want the characters (#109, DT Lab). `&amp;` last, so "&amp;lt;" stays
 * the text "&lt;" rather than becoming "<".
 */
export function unescapeHtml(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_whole, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_whole, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** One line per message in a listing. */
function messageLine(message: Message): string {
  const parts = [
    header(message, "Date"),
    `from ${header(message, "From") ?? "(unknown)"}`,
    `"${header(message, "Subject") ?? "(no subject)"}"`,
  ].filter(Boolean);
  const unread = message.labelIds?.includes("UNREAD") ? " (unread)" : "";
  const preview = message.snippet ? ` — ${unescapeHtml(message.snippet)}` : "";
  return `- ${parts.join(" · ")}${unread}${preview} · id: ${message.id}`;
}

function asResult(text: string): McpCallResult {
  const joined = text.trim();
  if (joined === "") {
    return {
      text: "Nothing was found, so there is nothing here to answer from.",
      isError: false,
      truncated: false,
    };
  }
  if (joined.length <= MAX_RESULT_CHARS) {
    return { text: joined, isError: false, truncated: false };
  }
  return {
    text: `${cutAtCodeUnits(joined, MAX_RESULT_CHARS)}\n\n[truncated: the message is longer than this]`,
    isError: false,
    truncated: true,
  };
}

const failure = (message: string): McpCallResult => ({
  text: message,
  isError: true,
  truncated: false,
});

/** The messages a search found, each fetched with the headers a listing shows. */
async function listing(
  connection: Connection,
  query: Record<string, string | string[]>,
): Promise<McpCallResult> {
  const found = await request(connection, "/users/me/messages", {
    maxResults: String(PAGE_SIZE),
    ...query,
  });
  if (!found.ok) return failure(found.message);
  const ids = ((found.body as { messages?: { id?: string }[] }).messages ?? [])
    .map((each) => each.id)
    .filter((id): id is string => Boolean(id));
  if (ids.length === 0) return asResult("");

  // One request each, in parallel: Gmail's list answers ids only.
  const messages = await Promise.all(
    ids.map((id) =>
      request(connection, `/users/me/messages/${encodeURIComponent(id)}`, {
        format: "metadata",
        metadataHeaders: [...SUMMARY_HEADERS],
      }),
    ),
  );
  const lines = messages.map((each, index) =>
    each.ok
      ? messageLine(each.body as Message)
      : `- (message ${ids[index]} could not be read: ${each.message})`,
  );
  return asResult(lines.join("\n"));
}

export async function callTool(
  connection: Connection,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  const stringArg = (key: string): string | null => {
    const value = args[key];
    return typeof value === "string" && value.trim() !== ""
      ? value.trim()
      : null;
  };

  if (toolName === "search_messages") {
    const query = stringArg("query");
    if (!query) return failure("A search needs something to search for.");
    return listing(connection, { q: query });
  }

  if (toolName === "list_recent_messages") {
    return listing(connection, { labelIds: "INBOX" });
  }

  if (toolName === "read_message") {
    const messageId = stringArg("messageId");
    if (!messageId) return failure("A message id is needed to read a message.");
    const result = await request(
      connection,
      `/users/me/messages/${encodeURIComponent(messageId)}`,
      { format: "full" },
    );
    if (!result.ok) return failure(result.message);
    const message = result.body as Message;
    const lines = [
      `From: ${header(message, "From") ?? "(unknown)"}`,
      `To: ${header(message, "To") ?? "(unknown)"}`,
      header(message, "Cc") ? `Cc: ${header(message, "Cc")}` : null,
      `Date: ${header(message, "Date") ?? "(unknown)"}`,
      `Subject: ${header(message, "Subject") ?? "(no subject)"}`,
    ].filter((line): line is string => line !== null);
    const attachments = attachmentNames(message);
    if (attachments.length > 0) {
      lines.push(`Attachments (not opened): ${attachments.join(", ")}`);
    }
    const text = bodyText(message);
    lines.push("", text || "(This message has no text.)");
    return asResult(lines.join("\n"));
  }

  if (toolName === "send_message") {
    const to = recipientsFrom(args.to, "to");
    if (!to.ok) return failure(to.message);
    const cc = recipientsFrom(args.cc, "cc");
    if (!cc.ok) return failure(cc.message);
    if (to.addresses.length === 0) {
      return failure("A message needs at least one address to send to.");
    }
    if (to.addresses.length + cc.addresses.length > MAX_RECIPIENTS) {
      return failure(
        `A message may go to at most ${MAX_RECIPIENTS} addresses in all.`,
      );
    }
    const subject = subjectFrom(args.subject);
    if (!subject) return failure("A message needs a subject.");
    const body = bodyFrom(args.body);
    if (!body) return failure("A message needs some text to send.");
    const raw = base64url(
      rfc822({ to: to.addresses, cc: cc.addresses, subject, body }),
    );
    const result = await request(
      connection,
      "/users/me/messages/send",
      {},
      { raw },
    );
    if (!result.ok) return failure(result.message);
    const sent = result.body as { id?: string };
    return asResult(
      `Sent to ${[...to.addresses, ...cc.addresses].join(", ")}: "${subject}".${sent.id ? ` Message id: ${sent.id}.` : ""}`,
    );
  }

  return failure(
    `${toolName} is not a tool this connector implements. The stored tool list is out of date; refresh it on the Plugins page.`,
  );
}
