/**
 * Our own connectors' results, read back into items a card can draw (P2 idea 9A, desk #90).
 *
 * The Gmail, Microsoft 365 and Google Drive connectors answer a model in lines of text, one item
 * each, written by `gmail-rest.ts`, `microsoft-graph-rest.ts` and `google-drive-rest.ts`. The model
 * keeps reading exactly that; this only reads the same lines back so the chat can draw a list of
 * mail, events or files instead of a block of text. Each server file's tests run its own output
 * through these, so a change of format on one side fails a test rather than a card.
 *
 * ALL OR NOTHING. A result with any line that does not read as an item gives null, and the chat
 * draws the text as it always did: a card that silently dropped a message would be worse than none.
 */

export type MailItem = {
  id: string;
  subject: string;
  from: string;
  date: string;
  unread: boolean;
  preview: string;
  /** Where the message opens in the vendor's own web app. */
  link: string | null;
};

export type FileItem = {
  id: string;
  name: string;
  kind: string;
  modified: string;
  link: string | null;
};

export type EventItem = {
  title: string;
  when: string;
  where: string;
  organiser: string;
  joinUrl: string | null;
  cancelled: boolean;
  link: string | null;
};

const MARKDOWN_LINK = /^\[((?:\\.|[^\]\\])*)\]\((https:\/\/[^)\s]+)\)$/;

/** `[label](https://…)` or a bare label, unescaped. */
function linked(part: string): { label: string; link: string | null } {
  const match = MARKDOWN_LINK.exec(part.trim());
  if (!match) return { label: part.trim(), link: null };
  return {
    label: (match[1] ?? "").replace(/\\([[\]])/g, "$1"),
    link: match[2] ?? null,
  };
}

/** The `- ` items of a result, each with any indented lines under it joined on. */
function items(text: string): string[] | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const found: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    if (line.startsWith("- ")) {
      found.push(line.slice(2));
    } else if (line.startsWith("  ") && found.length > 0) {
      found[found.length - 1] += `\n${line.trim()}`;
    } else {
      return null;
    }
  }
  return found.length > 0 ? found : null;
}

const GMAIL_LINE =
  /^(?:(?<date>[^·\n]+?) · )?from (?<from>.+?) · "(?<subject>.*)"(?<unread> \(unread\))?(?: — (?<preview>.*))? · id: (?<id>[A-Za-z0-9_-]+)$/;

/** `gmail-rest.ts`'s `messageLine`, read back. */
export function gmailMessages(text: string): MailItem[] | null {
  const found = items(text);
  if (!found) return null;
  const mail: MailItem[] = [];
  for (const item of found) {
    const match = GMAIL_LINE.exec(item);
    if (!match?.groups) return null;
    const id = match.groups.id ?? "";
    mail.push({
      id,
      subject: match.groups.subject ?? "",
      from: match.groups.from ?? "",
      date: match.groups.date?.trim() ?? "",
      unread: Boolean(match.groups.unread),
      preview: match.groups.preview ?? "",
      link: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(id)}`,
    });
  }
  return mail;
}

/** `microsoft-graph-rest.ts`'s `mailLine`, read back. */
export function outlookMessages(text: string): MailItem[] | null {
  const found = items(text);
  if (!found) return null;
  const mail: MailItem[] = [];
  for (const item of found) {
    const [head = "", ...rest] = item.split("\n");
    const parts = head.split(" · ");
    const idPart = parts.at(-1) ?? "";
    if (!idPart.startsWith("id: ")) return null;
    const subject = linked(parts[0] ?? "");
    const from = parts.find((part) => part.startsWith("from "));
    const received = parts.find((part) => part.startsWith("received "));
    mail.push({
      id: idPart.slice(4),
      subject: subject.label,
      from: from ? from.slice(5) : "",
      date: received ? received.slice(9) : "",
      unread: false,
      preview: rest.join(" "),
      link: subject.link,
    });
  }
  return mail;
}

/** `google-drive-rest.ts`'s `fileLine`, read back. */
export function driveFiles(text: string): FileItem[] | null {
  const found = items(text);
  if (!found) return null;
  const files: FileItem[] = [];
  for (const item of found) {
    const parts = item.split(" · ");
    const idPart = parts.at(-1) ?? "";
    if (!idPart.startsWith("id: ")) return null;
    const name = linked(parts[0] ?? "");
    const modified = parts.find((part) => part.startsWith("modified "));
    const kind = parts
      .slice(1, -1)
      .find((part) => !part.startsWith("modified "));
    files.push({
      id: idPart.slice(4),
      name: name.label,
      kind: kind ?? "",
      modified: modified ? modified.slice(9) : "",
      link: name.link,
    });
  }
  return files;
}

/** `microsoft-graph-rest.ts`'s `eventLine`, read back. */
export function calendarEvents(text: string): EventItem[] | null {
  const found = items(text);
  if (!found) return null;
  const events: EventItem[] = [];
  for (const item of found) {
    const parts = item.split(" · ");
    const title = linked(parts[0] ?? "");
    const when = parts.find((part) => / to .* UTC$/.test(part));
    if (!when) return null;
    const where = parts.find((part) => part.startsWith("at "));
    const organiser = parts.find((part) => part.startsWith("organised by "));
    const online = parts.find((part) => part.startsWith("online: "));
    events.push({
      title: title.label,
      when,
      where: where ? where.slice(3) : "",
      organiser: organiser ? organiser.slice(13) : "",
      joinUrl: online?.slice(8).startsWith("https://") ? online.slice(8) : null,
      cancelled: parts.includes("cancelled"),
      link: title.link,
    });
  }
  return events;
}

/** Which card a tool's result belongs on, by the connector and tool that answered. */
export type ConnectorCard =
  | { kind: "mail"; items: MailItem[] }
  | { kind: "files"; items: FileItem[] }
  | { kind: "events"; items: EventItem[] };

export function connectorCard(
  server: string,
  tool: string,
  result: string,
): ConnectorCard | null {
  if (
    server === "google-gmail" &&
    (tool === "list_recent_messages" || tool === "search_messages")
  ) {
    const mail = gmailMessages(result);
    return mail ? { kind: "mail", items: mail } : null;
  }
  if (server === "microsoft-365" && tool === "outlook_search_mail") {
    const mail = outlookMessages(result);
    return mail ? { kind: "mail", items: mail } : null;
  }
  if (server === "microsoft-365" && tool === "calendar_list_events") {
    const events = calendarEvents(result);
    return events ? { kind: "events", items: events } : null;
  }
  if (
    server === "google-drive" &&
    (tool === "search_files" || tool === "list_recent_files")
  ) {
    const files = driveFiles(result);
    return files ? { kind: "files", items: files } : null;
  }
  return null;
}
