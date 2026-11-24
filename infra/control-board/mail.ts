/**
 * The General@ mailbox through Microsoft Graph, for support cases (Amgad, 23 Nov 2026, #149: Graph
 * in place of IMAP).
 *
 * support@blackark.uk is an alias of General@blackark.uk. The board signs in as an Entra app with
 * client credentials (MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET), never as a person, and takes
 * ONLY messages whose To or Cc holds support@blackark.uk:
 * - it lists the unread messages in General@'s Inbox, asking only for their ids and recipients;
 * - it fetches in full only the ones whose To or Cc holds support@ exactly. A GET never marks a
 *   message read;
 * - only a message the board took is marked read (`isRead: true`). Nothing else is ever changed: no
 *   message is moved, deleted, flagged or sent, and everything else in General@ stays as it was,
 *   unread.
 *
 * The app needs the application permission Mail.ReadWrite (to set isRead), with admin consent, and an
 * Exchange ApplicationAccessPolicy that limits it to General@ alone (README, "Support mailbox"). A run
 * looks at unread mail from the last 14 days, newest first, at most `pages` pages of 50, and takes at
 * most `limit` messages (5 by default), so it stays well inside a Worker's 50 subrequests:
 * 1 token + 4 pages + 5 reads + 5 marks = 15.
 */
import { Buffer } from "node:buffer";
import {
  type MailMessage,
  type MailSource,
  SUPPORT_ADDRESS,
  sentToSupport,
} from "./intake";
import type { OutgoingMail, ReplyMailer } from "./replies";

/** The Worker's log line names only the error's name, so it is set: never a message, never a secret. */
export class GraphError extends Error {
  override name = "GraphError";
}

export type GraphSettings = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** The mailbox to read: General@blackark.uk. */
  mailbox: string;
};

const LOGIN = "https://login.microsoftonline.com";
const GRAPH = "https://graph.microsoft.com/v1.0";
const PAGE = 50;

type Address = { emailAddress?: { address?: string; name?: string } };
type ListedMessage = {
  id: string;
  toRecipients?: Address[];
  ccRecipients?: Address[];
};
type FullMessage = ListedMessage & {
  internetMessageId?: string;
  subject?: string;
  from?: Address;
  body?: { contentType?: string; content?: string };
  internetMessageHeaders?: Array<{ name?: string; value?: string }>;
};

function bare(id: string | undefined): string | undefined {
  const text = id?.trim().replace(/^<|>$/g, "");
  return text ? text.slice(0, 300) : undefined;
}

function addresses(list: Address[] | undefined): string[] {
  return (list ?? [])
    .map((one) => one.emailAddress?.address?.trim().toLowerCase() ?? "")
    .filter(Boolean);
}

function sender(from: Address | undefined): string {
  const address = from?.emailAddress?.address?.trim() ?? "";
  const name = from?.emailAddress?.name?.trim() ?? "";
  return (name && name !== address ? `${name} <${address}>` : address).slice(
    0,
    300,
  );
}

/** The few characters a Graph tenant id or GUID may hold; anything else is refused before a request. */
const SAFE_TENANT = /^[A-Za-z0-9.-]{1,100}$/;

/**
 * An app-only token for Graph (client credentials). One per run: the Cron Trigger is a fresh
 * invocation each time, so there is nothing to keep it in.
 */
export async function graphToken(
  settings: Pick<GraphSettings, "tenantId" | "clientId" | "clientSecret">,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  if (!SAFE_TENANT.test(settings.tenantId))
    throw new GraphError("MS_TENANT_ID is not a tenant id");
  const response = await fetcher(
    `${LOGIN}/${settings.tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: settings.clientId,
        client_secret: settings.clientSecret,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }).toString(),
    },
  );
  const json = (await response.json().catch(() => null)) as {
    access_token?: unknown;
  } | null;
  if (!response.ok || typeof json?.access_token !== "string")
    // The answer can name the app or tenant; only the status is passed on.
    throw new GraphError(`sign-in refused (HTTP ${response.status})`);
  return json.access_token;
}

/** Reads General@ through Graph. `fetcher` is a stand-in in the tests. */
export function graphMailbox(
  settings: GraphSettings,
  options: {
    supportAddress?: string;
    limit?: number;
    pages?: number;
    /** How far back to look, in days (14). Older unread mail is left for a person. */
    days?: number;
    fetch?: typeof fetch;
    now?: () => number;
  } = {},
): MailSource & { close(): Promise<void> } {
  const fetcher = options.fetch ?? fetch;
  const address = options.supportAddress ?? SUPPORT_ADDRESS;
  const box = `${GRAPH}/users/${encodeURIComponent(settings.mailbox)}`;
  const graphIdOf = new Map<string, string>();
  let token: string | null = null;

  const call = async (
    url: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    token ??= await graphToken(settings, fetcher);
    const response = await fetcher(url, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...((init.headers as Record<string, string> | undefined) ?? {}),
      },
    });
    if (!response.ok)
      throw new GraphError(
        `${init.method ?? "GET"} refused (HTTP ${response.status})`,
      );
    return response;
  };

  return {
    async unseen() {
      const limit = options.limit ?? 5;
      const chosen: string[] = [];
      const since = new Date(
        (options.now ?? Date.now)() - (options.days ?? 14) * 86_400_000,
      ).toISOString();
      // Graph sorts only on a property the filter names first, in the same order.
      let next: string | null =
        `${box}/mailFolders/inbox/messages?${new URLSearchParams({
          $filter: `receivedDateTime ge ${since} and isRead eq false`,
          $orderby: "receivedDateTime desc",
          $select: "id,toRecipients,ccRecipients",
          $top: String(PAGE),
        })}`;
      for (
        let page = 0;
        next && page < (options.pages ?? 4) && chosen.length < limit;
        page++
      ) {
        const listed = (await (await call(next)).json()) as {
          value?: ListedMessage[];
          "@odata.nextLink"?: string;
        };
        for (const one of listed.value ?? []) {
          if (chosen.length >= limit) break;
          const to = addresses(one.toRecipients);
          const cc = addresses(one.ccRecipients);
          if (typeof one.id === "string" && sentToSupport({ to, cc }, address))
            chosen.push(one.id);
        }
        const link = listed["@odata.nextLink"];
        // Follow only Graph's own next page, never a link to anywhere else.
        next = link?.startsWith(`${GRAPH}/`) ? link : null;
      }

      const out: MailMessage[] = [];
      // Newest were found first; they are handled oldest first, so a reply follows its original.
      for (const graphId of chosen.reverse()) {
        const full = (await (
          await call(
            `${box}/messages/${encodeURIComponent(graphId)}?${new URLSearchParams(
              {
                $select:
                  "id,internetMessageId,subject,from,toRecipients,ccRecipients,body,internetMessageHeaders",
              },
            )}`,
            { headers: { prefer: 'outlook.body-content-type="text"' } },
          )
        ).json()) as FullMessage;
        const to = addresses(full.toRecipients);
        const cc = addresses(full.ccRecipients);
        // Checked again on the message itself, exactly, before anything is done with it.
        if (!sentToSupport({ to, cc }, address)) continue;
        const id = bare(full.internetMessageId) ?? `graph-${graphId}`;
        graphIdOf.set(id, graphId);
        const inReplyTo = bare(
          full.internetMessageHeaders?.find(
            (header) => header.name?.toLowerCase() === "in-reply-to",
          )?.value,
        );
        out.push({
          id,
          ...(inReplyTo ? { inReplyTo } : {}),
          from: sender(full.from),
          to,
          cc,
          subject: (full.subject ?? "").slice(0, 300),
          text: (full.body?.content ?? "").slice(0, 20_000),
        });
      }
      return out;
    },
    async markSeen(id) {
      const graphId = graphIdOf.get(id);
      if (graphId === undefined) return;
      await call(`${box}/messages/${encodeURIComponent(graphId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isRead: true }),
      });
      graphIdOf.delete(id);
    },
    async close() {
      token = null;
    },
  };
}

// ---- Replies (Gap 3) ---------------------------------------------------------------------------

const MIME_EMAIL = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9.-]{1,253}$/;

function base64Lines(text: string): string {
  const encoded = Buffer.from(text, "utf8").toString("base64");
  return encoded.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

/** A header value as RFC 2047 encoded words, each well under 76 characters. */
function encodedWords(text: string): string {
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  const words: string[] = [];
  let chunk = "";
  for (const char of text) {
    if (Buffer.byteLength(chunk + char, "utf8") > 42) {
      words.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk) words.push(chunk);
  return words
    .map(
      (word) => `=?UTF-8?B?${Buffer.from(word, "utf8").toString("base64")}?=`,
    )
    .join("\r\n ");
}

/**
 * One reply as a MIME message: plain text and HTML, From the mailbox that sends it (General@) and
 * Reply-To the support address. Built
 * here rather than as Graph's JSON message so the email carries both parts, and so nothing a person
 * typed can reach a header (the address is checked, the subject encoded).
 */
export function replyMime(
  mail: OutgoingMail,
  options: {
    from: string;
    replyTo: string;
    fromName?: string;
    now: number;
    random: string;
  },
): string {
  if (
    !MIME_EMAIL.test(mail.to) ||
    !MIME_EMAIL.test(options.from) ||
    !MIME_EMAIL.test(options.replyTo)
  )
    throw new GraphError("not an email address");
  const boundary = `ark-${options.random}`;
  const name = options.fromName ?? "BlackArk Support";
  const date = new Date(options.now).toUTCString().replace("GMT", "+0000");
  return [
    `From: ${name} <${options.from}>`,
    `Reply-To: ${name} <${options.replyTo}>`,
    `To: <${mail.to}>`,
    `Subject: ${encodedWords(mail.subject.replace(/[\r\n]+/g, " "))}`,
    `Date: ${date}`,
    `Message-ID: <case-${mail.caseNumber}.${options.random}@blackark.uk>`,
    `Content-Language: ${mail.language}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(mail.text),
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(mail.html),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

/**
 * Sends replies from General@ through Graph `sendMail` (application permission Mail.Send, limited
 * to General@ by the same ApplicationAccessPolicy as the reader). From is General@ itself (Amgad,
 * 24 Nov 2026: support@ is not a sending address; Exchange sent it as General@ anyway), Reply-To is
 * support@, which lands in General@ too, so the customer's answer comes back to the case by its
 * "[Case #N]" tag. A copy stays in General@'s Sent Items.
 */
export function graphSender(
  settings: GraphSettings,
  options: {
    /** Where answers go: support@ (an alias of General@). */
    replyTo?: string;
    fetch?: typeof fetch;
    now?: () => number;
    random?: () => string;
  } = {},
): ReplyMailer {
  const fetcher = options.fetch ?? fetch;
  const replyTo = options.replyTo ?? SUPPORT_ADDRESS;
  return {
    async send(mail) {
      const mime = replyMime(mail, {
        from: settings.mailbox,
        replyTo,
        now: (options.now ?? Date.now)(),
        random:
          options.random?.() ??
          Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString(
            "hex",
          ),
      });
      const token = await graphToken(settings, fetcher);
      const response = await fetcher(
        `${GRAPH}/users/${encodeURIComponent(settings.mailbox)}/sendMail`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "text/plain",
          },
          body: Buffer.from(mime, "utf8").toString("base64"),
        },
      );
      if (response.status !== 202 && !response.ok)
        throw new GraphError(`sendMail refused (HTTP ${response.status})`);
    },
  };
}
