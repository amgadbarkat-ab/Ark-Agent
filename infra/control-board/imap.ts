/**
 * A minimal IMAP client (RFC 3501), written here because imapflow does not run in a Worker. It
 * speaks over any byte stream: Cloudflare's TCP sockets (`connect()` with TLS from the first byte,
 * port 993) in the Worker, an in-memory stand-in server in the tests.
 *
 * Only what the support mailbox needs, and nothing that changes General@ beyond one flag:
 *   LOGIN, SELECT INBOX,
 *   UID SEARCH UNSEEN OR TO <support@> CC <support@>,
 *   UID FETCH <uid> (BODY.PEEK[])          — PEEK: reading never marks a message read,
 *   UID STORE <uid> +FLAGS.SILENT (\Seen)  — only for a message the board took,
 *   LOGOUT.
 * No message is ever moved, copied, deleted or expunged.
 */

export type Transport = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): Promise<void>;
};

export type ImapConnection = {
  searchUnseenTo(address: string): Promise<number[]>;
  fetchRaw(uid: number): Promise<Uint8Array | null>;
  markSeen(uid: number): Promise<void>;
  logout(): Promise<void>;
};

export class ImapError extends Error {}

const CRLF = new Uint8Array([13, 10]);
const MAX_LITERAL = 2_000_000;

function quote(text: string): string {
  if (/[\r\n]/.test(text)) throw new ImapError("line breaks are not allowed");
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

type Response = { text: string; literals: Uint8Array[] };

class Session {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private buffer = new Uint8Array(0);
  private tag = 0;

  constructor(private transport: Transport) {
    this.reader = transport.readable.getReader();
    this.writer = transport.writable.getWriter();
  }

  private async fill(): Promise<void> {
    const { value, done } = await this.reader.read();
    if (done || !value) throw new ImapError("the server closed the connection");
    const next = new Uint8Array(this.buffer.length + value.length);
    next.set(this.buffer, 0);
    next.set(value, this.buffer.length);
    this.buffer = next;
  }

  private async line(): Promise<string> {
    for (;;) {
      for (let i = 0; i + 1 < this.buffer.length; i++) {
        if (this.buffer[i] === 13 && this.buffer[i + 1] === 10) {
          const text = new TextDecoder().decode(this.buffer.slice(0, i));
          this.buffer = this.buffer.slice(i + 2);
          return text;
        }
      }
      if (this.buffer.length > MAX_LITERAL)
        throw new ImapError("line too long");
      await this.fill();
    }
  }

  private async exact(n: number): Promise<Uint8Array> {
    while (this.buffer.length < n) await this.fill();
    const out = this.buffer.slice(0, n);
    this.buffer = this.buffer.slice(n);
    return out;
  }

  /** One server response, with any literals ({n} followed by n bytes) it carries. */
  private async response(): Promise<Response> {
    let text = await this.line();
    const literals: Uint8Array[] = [];
    for (;;) {
      const literal = text.match(/\{(\d+)\}$/);
      if (!literal) return { text, literals };
      const size = Number(literal[1]);
      if (size > MAX_LITERAL) throw new ImapError("message too large");
      literals.push(await this.exact(size));
      text += await this.line();
    }
  }

  async greeting(): Promise<void> {
    const first = await this.response();
    if (!/^\* (OK|PREAUTH)\b/i.test(first.text))
      throw new ImapError("no IMAP greeting");
  }

  async command(text: string): Promise<Response[]> {
    this.tag += 1;
    const tag = `A${this.tag}`;
    await this.writer.write(new TextEncoder().encode(`${tag} ${text}`));
    await this.writer.write(CRLF);
    const untagged: Response[] = [];
    for (;;) {
      const response = await this.response();
      if (response.text.startsWith(`${tag} `)) {
        const status = response.text.slice(tag.length + 1);
        if (!/^OK\b/i.test(status))
          throw new ImapError(
            `${text.split(" ")[0]} refused: ${status.slice(0, 80)}`,
          );
        return untagged;
      }
      untagged.push(response);
    }
  }

  async close(): Promise<void> {
    try {
      this.reader.releaseLock();
      this.writer.releaseLock();
    } catch {}
    await this.transport.close().catch(() => undefined);
  }
}

/** Signs in and opens INBOX. The password is sent only over the TLS the transport already has. */
export async function openImap(
  transport: Transport,
  user: string,
  password: string,
): Promise<ImapConnection> {
  const session = new Session(transport);
  try {
    await session.greeting();
    await session.command(`LOGIN ${quote(user)} ${quote(password)}`);
    await session.command("SELECT INBOX");
  } catch (error) {
    await session.close();
    throw error;
  }
  return {
    async searchUnseenTo(address) {
      const found = await session.command(
        `UID SEARCH UNSEEN OR TO ${quote(address)} CC ${quote(address)}`,
      );
      const uids: number[] = [];
      for (const response of found) {
        const match = response.text.match(/^\* SEARCH\b(.*)$/i);
        if (match)
          for (const n of (match[1] ?? "").trim().split(/\s+/).filter(Boolean))
            uids.push(Number(n));
      }
      return uids
        .filter((n) => Number.isInteger(n) && n > 0)
        .sort((a, b) => a - b);
    },
    async fetchRaw(uid) {
      const found = await session.command(`UID FETCH ${uid} (BODY.PEEK[])`);
      for (const response of found) {
        if (/^\* \d+ FETCH\b/i.test(response.text) && response.literals[0])
          return response.literals[0];
      }
      return null;
    },
    async markSeen(uid) {
      await session.command(`UID STORE ${uid} +FLAGS.SILENT (\\Seen)`);
    },
    async logout() {
      try {
        await session.command("LOGOUT");
      } catch {}
      await session.close();
    },
  };
}

// ---- Reading a message (MIME, the parts a support case needs) ----------------------------------

export type ParsedMail = {
  messageId?: string;
  inReplyTo?: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
};

function decodeBytes(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, "");
  return Uint8Array.from(
    atob(clean + "=".repeat((4 - (clean.length % 4)) % 4)),
    (c) => c.charCodeAt(0),
  );
}

function fromQuotedPrintable(
  text: string,
  underscoreIsSpace = false,
): Uint8Array {
  const source = (underscoreIsSpace ? text.replace(/_/g, " ") : text).replace(
    /=\r?\n/g,
    "",
  );
  const out: number[] = [];
  for (let i = 0; i < source.length; i++) {
    const hex = source.slice(i + 1, i + 3);
    if (source[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      out.push(Number.parseInt(hex, 16));
      i += 2;
    } else {
      out.push(source.charCodeAt(i) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/** RFC 2047 encoded words in a header: =?charset?B|Q?text?= */
function decodeWords(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(
      /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
      (_, charset: string, kind: string, text: string) =>
        decodeBytes(
          kind.toUpperCase() === "B"
            ? fromBase64(text)
            : fromQuotedPrintable(text, true),
          charset,
        ),
    );
}

type Part = { headers: Map<string, string>; body: string };

function split(raw: string): Part {
  const end = raw.search(/\r?\n\r?\n/);
  const head = end < 0 ? raw : raw.slice(0, end);
  const body = end < 0 ? "" : raw.slice(end).replace(/^\r?\n\r?\n/, "");
  const headers = new Map<string, string>();
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      const name = line.slice(0, colon).trim().toLowerCase();
      if (!headers.has(name)) headers.set(name, line.slice(colon + 1).trim());
    }
  }
  return { headers, body };
}

function parameter(header: string, name: string): string {
  return (
    header
      .match(new RegExp(`${name}\\s*=\\s*"?([^";]+)"?`, "i"))?.[1]
      ?.trim() ?? ""
  );
}

function partText(part: Part): string {
  const encoding = (
    part.headers.get("content-transfer-encoding") ?? ""
  ).toLowerCase();
  const charset = parameter(part.headers.get("content-type") ?? "", "charset");
  if (encoding === "base64") return decodeBytes(fromBase64(part.body), charset);
  if (encoding === "quoted-printable")
    return decodeBytes(fromQuotedPrintable(part.body), charset);
  return decodeBytes(
    Uint8Array.from(part.body, (c) => c.charCodeAt(0) & 0xff),
    charset,
  );
}

/** The first text/plain part (or text/html, without its tags), and how many attachments were left out. */
function body(
  part: Part,
  depth = 0,
): { text: string | null; html: string | null; attachments: number } {
  const type = (part.headers.get("content-type") ?? "text/plain").toLowerCase();
  const disposition = (
    part.headers.get("content-disposition") ?? ""
  ).toLowerCase();
  if (type.startsWith("multipart/") && depth < 5) {
    const boundary = parameter(
      part.headers.get("content-type") ?? "",
      "boundary",
    );
    if (!boundary) return { text: null, html: null, attachments: 0 };
    let text: string | null = null;
    let html: string | null = null;
    let attachments = 0;
    for (const chunk of part.body.split(`--${boundary}`).slice(1)) {
      if (chunk.startsWith("--")) break;
      const inner = body(split(chunk.replace(/^\r?\n/, "")), depth + 1);
      text ??= inner.text;
      html ??= inner.html;
      attachments += inner.attachments;
    }
    return { text, html, attachments };
  }
  if (disposition.startsWith("attachment"))
    return { text: null, html: null, attachments: 1 };
  if (type.startsWith("text/plain"))
    return { text: partText(part), html: null, attachments: 0 };
  if (type.startsWith("text/html"))
    return { text: null, html: partText(part), attachments: 0 };
  return { text: null, html: null, attachments: 1 };
}

function addresses(value: string | undefined): string[] {
  return [...(value ?? "").matchAll(/[\w.+'-]+@[\w-]+(?:\.[\w-]+)+/g)].map(
    (m) => m[0].toLowerCase(),
  );
}

export function parseMail(raw: Uint8Array): ParsedMail {
  // Headers and 7/8-bit bodies byte for byte; each part decodes its own charset.
  const message = split(
    Array.from(raw, (b) => String.fromCharCode(b)).join(""),
  );
  const found = body(message);
  const text = (
    found.text ??
    found.html
      ?.replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim() ??
    ""
  ).trim();
  const header = (name: string) => {
    const value = message.headers.get(name);
    return value === undefined
      ? undefined
      : decodeWords(
          decodeBytes(
            Uint8Array.from(value, (c) => c.charCodeAt(0) & 0xff),
            "utf-8",
          ),
        );
  };
  return {
    ...(header("message-id") ? { messageId: header("message-id") } : {}),
    ...(header("in-reply-to") ? { inReplyTo: header("in-reply-to") } : {}),
    from: header("from") ?? "",
    to: addresses(header("to")),
    cc: addresses(header("cc")),
    subject: header("subject") ?? "",
    text: found.attachments
      ? `${text}\n\n(${found.attachments} attachment(s) not kept)`
      : text,
  };
}
