/**
 * The General@ mailbox over IMAP, for support cases (Amgad, 18 Nov 2026, #149).
 *
 * support@blackark.uk is only an alias that delivers to General@blackark.uk. The board signs in to
 * General@ and takes ONLY messages whose To or Cc holds support@blackark.uk:
 * - the IMAP search asks the server for unread messages to or cc support@ only;
 * - each one is fetched with BODY.PEEK (imapflow's `source`), which never marks it read;
 * - its parsed To and Cc are checked again, exactly, before anything is done with it;
 * - only a message the board took is marked read (\Seen), and nothing else is ever changed: no
 *   message is moved, deleted or flagged, and everything else in General@ stays as it was, unread.
 *
 * imapflow and mailparser are the versions the server workspace already uses (root bun.lock); no
 * package is added. They are loaded from the server workspace at run time, so the board's own files
 * still need nothing installed and its tests run against a stand-in client.
 */
import { createRequire } from "node:module";
import {
  type MailMessage,
  type MailSource,
  SUPPORT_ADDRESS,
  sentToSupport,
} from "./intake";

/** The part of imapflow's ImapFlow the board uses. A stand-in implements the same in tests. */
export type ImapClient = {
  connect(): Promise<void>;
  getMailboxLock(path: string): Promise<{ release(): void }>;
  search(
    query: Record<string, unknown>,
    options: { uid: true },
  ): Promise<number[] | false | undefined>;
  fetchOne(
    range: string,
    query: { source: true; uid: true },
    options: { uid: true },
  ): Promise<{ uid: number; source?: Buffer } | false>;
  messageFlagsAdd(
    range: string,
    flags: string[],
    options: { uid: true },
  ): Promise<boolean>;
  logout(): Promise<void>;
};

export type ParsedMail = {
  messageId?: string;
  inReplyTo?: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
};

export type MailSettings = {
  host: string;
  port: number;
  user: string;
  password: string;
  supportAddress?: string;
  /** At most this many messages a run, oldest first. */
  limit?: number;
};

function bare(id: string | undefined): string | undefined {
  const text = id?.trim().replace(/^<|>$/g, "");
  return text ? text.slice(0, 300) : undefined;
}

/** Reads General@ through `connect`, which gives a signed-in client (a stand-in in tests). */
export function imapMailbox(
  connect: () => Promise<ImapClient>,
  parse: (source: Buffer) => Promise<ParsedMail>,
  options: { supportAddress?: string; limit?: number } = {},
): MailSource & { close(): Promise<void> } {
  const address = options.supportAddress ?? SUPPORT_ADDRESS;
  const uidOf = new Map<string, number>();
  let client: ImapClient | null = null;
  const ready = async () => {
    client ??= await connect();
    return client;
  };
  return {
    async unseen() {
      const imap = await ready();
      const lock = await imap.getMailboxLock("INBOX");
      const out: MailMessage[] = [];
      try {
        const uids =
          (await imap.search(
            { seen: false, or: [{ to: address }, { cc: address }] },
            { uid: true },
          )) || [];
        for (const uid of uids
          .sort((a, b) => a - b)
          .slice(0, options.limit ?? 50)) {
          const message = await imap.fetchOne(
            String(uid),
            { source: true, uid: true },
            { uid: true },
          );
          if (message === false || !message.source) continue;
          const parsed = await parse(message.source);
          const to = parsed.to.map((one) => one.toLowerCase());
          const cc = parsed.cc.map((one) => one.toLowerCase());
          if (!sentToSupport({ to, cc }, address)) continue;
          const id = bare(parsed.messageId) ?? `imap-uid-${uid}`;
          uidOf.set(id, uid);
          out.push({
            id,
            ...(bare(parsed.inReplyTo)
              ? { inReplyTo: bare(parsed.inReplyTo) }
              : {}),
            from: parsed.from.slice(0, 300),
            to,
            cc,
            subject: parsed.subject.slice(0, 300),
            text: parsed.text.slice(0, 20_000),
          });
        }
      } finally {
        lock.release();
      }
      return out;
    },
    async markSeen(id) {
      const uid = uidOf.get(id);
      if (uid === undefined) return;
      const imap = await ready();
      const lock = await imap.getMailboxLock("INBOX");
      try {
        await imap.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
        uidOf.delete(id);
      } finally {
        lock.release();
      }
    },
    async close() {
      if (client) await client.logout().catch(() => undefined);
      client = null;
    },
  };
}

// ---- The real client, from the server workspace ------------------------------------------------

/**
 * Loads a package the server workspace depends on, at the version in the root bun.lock: from the
 * board's own node_modules in the image (copied there by mail-deps.ts), or from the server
 * workspace in a checkout.
 */
function fromServerWorkspace(name: string): unknown {
  try {
    return createRequire(import.meta.url)(name);
  } catch {
    return createRequire(new URL("../../server/package.json", import.meta.url))(
      name,
    );
  }
}

/** imapflow, signed in over TLS on port 993 (one.com: imap.one.com:993). */
export function imapflowConnect(
  settings: MailSettings,
): () => Promise<ImapClient> {
  return async () => {
    const { ImapFlow } = fromServerWorkspace("imapflow") as {
      ImapFlow: new (options: Record<string, unknown>) => ImapClient;
    };
    const client = new ImapFlow({
      host: settings.host,
      port: settings.port,
      secure: settings.port === 993,
      ...(settings.port === 993 ? {} : { doSTARTTLS: true }),
      auth: { user: settings.user, pass: settings.password },
      logger: false,
      socketTimeout: 30_000,
      connectionTimeout: 30_000,
      greetingTimeout: 30_000,
    });
    await client.connect();
    return client;
  };
}

type Addresses =
  | { value?: Array<{ address?: string }> }
  | Array<{ value?: Array<{ address?: string }> }>
  | undefined;

function addresses(field: Addresses): string[] {
  const groups = Array.isArray(field) ? field : field ? [field] : [];
  return groups.flatMap((group) =>
    (group.value ?? []).map((one) => one.address ?? "").filter(Boolean),
  );
}

/** mailparser's simpleParser, reduced to what a case needs. Attachments are dropped. */
export async function mailparserParse(source: Buffer): Promise<ParsedMail> {
  const { simpleParser } = fromServerWorkspace("mailparser") as {
    simpleParser: (source: Buffer) => Promise<{
      messageId?: string;
      inReplyTo?: string;
      from?: { text?: string };
      to?: Addresses;
      cc?: Addresses;
      subject?: string;
      text?: string;
      html?: string | false;
      attachments?: unknown[];
    }>;
  };
  const parsed = await simpleParser(source);
  const text =
    parsed.text?.trim() ||
    (typeof parsed.html === "string"
      ? parsed.html
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
      : "");
  const dropped = parsed.attachments?.length ?? 0;
  return {
    messageId: parsed.messageId,
    inReplyTo: parsed.inReplyTo,
    from: parsed.from?.text ?? "",
    to: addresses(parsed.to),
    cc: addresses(parsed.cc),
    subject: parsed.subject ?? "",
    text: dropped ? `${text}\n\n(${dropped} attachment(s) not kept)` : text,
  };
}
