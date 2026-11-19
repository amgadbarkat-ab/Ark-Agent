/**
 * The General@ mailbox over IMAP, for support cases (Amgad, 18 Nov 2026, #149).
 *
 * support@blackark.uk is only an alias that delivers to General@blackark.uk. The board signs in to
 * General@ and takes ONLY messages whose To or Cc holds support@blackark.uk:
 * - the IMAP search asks the server for unread messages to or cc support@ only;
 * - each one is fetched with BODY.PEEK, which never marks it read;
 * - its parsed To and Cc are checked again, exactly, before anything is done with it;
 * - only a message the board took is marked read (\Seen). Nothing else is ever changed: no message
 *   is moved, deleted or flagged, and everything else in General@ stays as it was, unread.
 *
 * The client is imap.ts, over Cloudflare's TCP sockets (`connect()`, TLS on port 993) in the
 * Worker. A run takes at most `limit` messages (5 by default), to stay inside the Cron Trigger's
 * 10 ms of CPU.
 */
import { type ImapConnection, openImap, parseMail } from "./imap";
import {
  type MailMessage,
  type MailSource,
  SUPPORT_ADDRESS,
  sentToSupport,
} from "./intake";
import type { Connect } from "./workers";

function bare(id: string | undefined): string | undefined {
  const text = id?.trim().replace(/^<|>$/g, "");
  return text ? text.slice(0, 300) : undefined;
}

/** Reads General@ through `open`, which gives a signed-in connection (a stand-in in tests). */
export function imapMailbox(
  open: () => Promise<ImapConnection>,
  options: { supportAddress?: string; limit?: number } = {},
): MailSource & { close(): Promise<void> } {
  const address = options.supportAddress ?? SUPPORT_ADDRESS;
  const uidOf = new Map<string, number>();
  let connection: ImapConnection | null = null;
  const ready = async () => {
    connection ??= await open();
    return connection;
  };
  return {
    async unseen() {
      const imap = await ready();
      const out: MailMessage[] = [];
      for (const uid of (await imap.searchUnseenTo(address)).slice(
        0,
        options.limit ?? 5,
      )) {
        const raw = await imap.fetchRaw(uid);
        if (!raw) continue;
        const parsed = parseMail(raw);
        if (!sentToSupport(parsed, address)) continue;
        const id = bare(parsed.messageId) ?? `imap-uid-${uid}`;
        uidOf.set(id, uid);
        const inReplyTo = bare(parsed.inReplyTo);
        out.push({
          id,
          ...(inReplyTo ? { inReplyTo } : {}),
          from: parsed.from.slice(0, 300),
          to: parsed.to,
          cc: parsed.cc,
          subject: parsed.subject.slice(0, 300),
          text: parsed.text.slice(0, 20_000),
        });
      }
      return out;
    },
    async markSeen(id) {
      const uid = uidOf.get(id);
      if (uid === undefined) return;
      await (await ready()).markSeen(uid);
      uidOf.delete(id);
    },
    async close() {
      if (connection) await connection.logout();
      connection = null;
    },
  };
}

export type MailSettings = {
  host: string;
  port: number;
  user: string;
  password: string;
};

/** A TLS connection from the Worker (port 993: TLS from the first byte; port 25 is blocked). */
export function socketImap(
  connect: Connect,
  settings: MailSettings,
): () => Promise<ImapConnection> {
  return async () => {
    const socket = connect(
      { hostname: settings.host, port: settings.port },
      { secureTransport: "on" },
    );
    await socket.opened;
    return openImap(
      {
        readable: socket.readable,
        writable: socket.writable,
        close: () => socket.close(),
      },
      settings.user,
      settings.password,
    );
  };
}
