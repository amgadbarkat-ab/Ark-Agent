import { cutAtCodeUnits } from "../channels/text";
import { MAX_RESULT_CHARS, type McpCallResult, type McpTool } from "./mcp";

/**
 * Microsoft 365, read-only, reached over the Microsoft Graph REST API.
 *
 * Outlook mail, the calendar, Teams chats and SharePoint and OneDrive files, as whoever is asking.
 * There is no Microsoft-hosted MCP server a business can use for these without an extra licence, and
 * Graph is the generally available API underneath all four, so this is the same shape as Google
 * Drive's adapter: the interface {@link ./mcp} already had, `listTools` and `callTool`, chosen per
 * catalogue entry by {@link ./access} and looked up in {@link ./transport}.
 *
 * READ-ONLY ON PURPOSE, TWICE. The scopes this connector asks for are the `.Read` ones, so Microsoft
 * refuses a write whatever this code did, and nothing here offers one. Sending mail, creating an
 * event or posting to a chat is a different decision, made one tool at a time with its own review.
 *
 * NOT YET TRIED AGAINST A REAL MICROSOFT ACCOUNT. It is tested here against recorded shapes of
 * Graph's answers and nothing else, because connecting needs an app registered in Microsoft Entra,
 * which only the people who run the deployment can do. The screens say so until somebody has.
 *
 * Every request carries the caller's own token, so what comes back is what that person can see.
 */

/** Long enough for a slow mailbox search, short enough that a Bot's turn is not held open on it. */
const REQUEST_TIMEOUT_MS = 30_000;

const DEFAULT_RESULTS = 10;
const MAX_RESULTS = 25;
const MAX_CHAT_MESSAGES = 50;
/** How far ahead the calendar looks when nobody said. */
const DEFAULT_WINDOW_DAYS = 7;

const MAIL_FIELDS =
  "id,subject,from,receivedDateTime,bodyPreview,webLink,isRead";
const EVENT_FIELDS =
  "id,subject,start,end,location,organizer,isOnlineMeeting,onlineMeeting,webLink,isCancelled";

const TOOLS: readonly McpTool[] = Object.freeze([
  {
    name: "outlook_search_mail",
    description:
      "Search your Outlook mail by words in the subject, sender or text. Returns each message's subject, sender, date, a short preview and its id.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for." },
        top: {
          type: "number",
          description: `How many messages to return, at most ${MAX_RESULTS}. Defaults to ${DEFAULT_RESULTS}.`,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "outlook_read_mail",
    description:
      "Read one Outlook message in full, by the id outlook_search_mail gave.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "The message's id." },
      },
      required: ["messageId"],
    },
  },
  {
    name: "calendar_list_events",
    description:
      "List the events on your Outlook calendar between two moments, in time order. Times are in UTC. With no dates it lists the next seven days.",
    inputSchema: {
      type: "object",
      properties: {
        start: {
          type: "string",
          description: "From when, as an ISO 8601 date or date-time.",
        },
        end: {
          type: "string",
          description: "Until when, as an ISO 8601 date or date-time.",
        },
      },
    },
  },
  {
    name: "teams_list_chats",
    description:
      "List your Microsoft Teams chats, most recently active first, with the last message in each and the chat's id.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "teams_read_chat",
    description:
      "Read the latest messages in one Microsoft Teams chat, newest first, by the id teams_list_chats gave.",
    inputSchema: {
      type: "object",
      properties: {
        chatId: { type: "string", description: "The chat's id." },
        top: {
          type: "number",
          description: `How many messages to return, at most ${MAX_CHAT_MESSAGES}. Defaults to ${DEFAULT_RESULTS}.`,
        },
      },
      required: ["chatId"],
    },
  },
  {
    name: "sharepoint_search_files",
    description:
      "Search the files you can open in SharePoint and OneDrive, by name and text. Returns each file's name, last modified time and link.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for." },
      },
      required: ["query"],
    },
  },
]);

type Connection = { url: string; token?: string };

/** The list is this code, so no credential is needed to know it. See the Drive adapter. */
export const listNeedsCredential = false;

export async function listTools(_connection: Connection): Promise<McpTool[]> {
  return TOOLS.map((tool) => ({ ...tool }));
}

/**
 * One request to Graph, with the caller's own token.
 *
 * `Prefer` headers are how Graph is told to answer in text and in UTC, which is what a model can quote
 * without converting anything.
 */
async function request(
  connection: Connection,
  path: string,
  options: {
    query?: Record<string, string>;
    method?: "GET" | "POST";
    body?: unknown;
    prefer?: string[];
  } = {},
): Promise<{ ok: true; response: Response } | { ok: false; message: string }> {
  if (!connection.token) {
    return { ok: false, message: "No credential was available for this call." };
  }

  const url = new URL(`${connection.url.replace(/\/+$/, "")}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(key, value);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        authorization: `Bearer ${connection.token}`,
        accept: "application/json",
        ...(options.body === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...(options.prefer?.length
          ? { prefer: options.prefer.join(", ") }
          : {}),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error && error.name === "TimeoutError"
          ? "Microsoft 365 did not answer in time."
          : `Microsoft 365 could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!response.ok) {
    /*
     * Microsoft's own sentence, kept: for a 403 it says which permission the sign-in lacks, and for a
     * 401 that the sign-in has expired, which are the two fixes a person can act on.
     */
    const body = await response.text().catch(() => "");
    let detail = "";
    try {
      const parsed = JSON.parse(body) as { error?: { message?: unknown } };
      if (typeof parsed.error?.message === "string") {
        detail = parsed.error.message;
      }
    } catch {
      // Not JSON. The status alone is still worth saying.
    }
    const throttled =
      response.status === 429
        ? " Microsoft is asking for a pause: try again in a minute."
        : "";
    return {
      ok: false,
      message: `${
        detail
          ? `Microsoft 365 refused this request (${response.status}): ${detail}`
          : `Microsoft 365 refused this request (${response.status}).`
      }${throttled}`,
    };
  }

  return { ok: true, response };
}

const failure = (message: string): McpCallResult => ({
  text: message,
  isError: true,
  truncated: false,
});

/** Text as a result, saying so in words when there is none. See the Drive adapter's `asResult`. */
function asResult(text: string): McpCallResult {
  const joined = text.trim();
  if (joined === "") {
    return {
      text: "The tool returned no content. Nothing was found, so there is nothing here to answer from.",
      isError: false,
      truncated: false,
    };
  }
  if (joined.length <= MAX_RESULT_CHARS) {
    return { text: joined, isError: false, truncated: false };
  }
  return {
    text: `${cutAtCodeUnits(joined, MAX_RESULT_CHARS)}\n\n[truncated: the tool returned ${joined.length} characters]`,
    isError: false,
    truncated: true,
  };
}

/** Teams hands back HTML. A model wants the words. */
function plain(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type Person = {
  emailAddress?: { name?: string; address?: string };
  user?: { displayName?: string };
};

function who(person: Person | undefined): string {
  const address = person?.emailAddress;
  if (address?.name && address.address) {
    return `${address.name} <${address.address}>`;
  }
  return address?.address ?? address?.name ?? person?.user?.displayName ?? "";
}

/** A link a person can open, with brackets escaped so a name cannot close it early. */
function link(label: string, url: string | undefined): string {
  const text = label.replace(/\[/g, "\\[").replace(/\]/g, "\\]");
  return url ? `[${text}](${url})` : text;
}

type Message = {
  id?: string;
  subject?: string;
  from?: Person;
  toRecipients?: Person[];
  ccRecipients?: Person[];
  receivedDateTime?: string;
  bodyPreview?: string;
  body?: { content?: string; contentType?: string };
  webLink?: string;
  isRead?: boolean;
  hasAttachments?: boolean;
};

function mailLine(message: Message): string {
  const parts = [
    link(message.subject?.trim() || "(no subject)", message.webLink),
    who(message.from) && `from ${who(message.from)}`,
    message.receivedDateTime && `received ${message.receivedDateTime}`,
    message.id && `id: ${message.id}`,
  ].filter(Boolean);
  const preview = message.bodyPreview?.replace(/\s+/g, " ").trim();
  return `- ${parts.join(" · ")}${preview ? `\n  ${preview}` : ""}`;
}

/** What somebody typed, inside the double quotes `$search` wants, without being able to leave them. */
const searchTerm = (query: string) => `"${query.replace(/["\\]/g, " ")}"`;

/** A date or date-time as an ISO instant, or null when it is neither. */
function instant(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function count(value: unknown, fallback: number, max: number): number {
  const wanted = typeof value === "number" ? Math.floor(value) : fallback;
  return Math.min(Math.max(wanted, 1), max);
}

type CalendarEvent = {
  subject?: string;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  location?: { displayName?: string };
  organizer?: Person;
  isOnlineMeeting?: boolean;
  onlineMeeting?: { joinUrl?: string };
  webLink?: string;
  isCancelled?: boolean;
};

function eventLine(event: CalendarEvent): string {
  const parts = [
    link(event.subject?.trim() || "(no title)", event.webLink),
    event.start?.dateTime &&
      `${event.start.dateTime} to ${event.end?.dateTime ?? "?"} UTC`,
    event.location?.displayName && `at ${event.location.displayName}`,
    who(event.organizer) && `organised by ${who(event.organizer)}`,
    event.isOnlineMeeting && event.onlineMeeting?.joinUrl
      ? `online: ${event.onlineMeeting.joinUrl}`
      : null,
    event.isCancelled ? "cancelled" : null,
  ].filter(Boolean);
  return `- ${parts.join(" · ")}`;
}

type Chat = {
  id?: string;
  topic?: string | null;
  chatType?: string;
  lastMessagePreview?: {
    createdDateTime?: string;
    from?: Person;
    body?: { content?: string };
  };
};

type ChatMessage = {
  createdDateTime?: string;
  from?: Person;
  body?: { content?: string; contentType?: string };
  messageType?: string;
};

type SearchResponse = {
  value?: Array<{
    hitsContainers?: Array<{
      hits?: Array<{
        summary?: string;
        resource?: {
          name?: string;
          webUrl?: string;
          lastModifiedDateTime?: string;
          id?: string;
        };
      }>;
    }>;
  }>;
};

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

  if (toolName === "outlook_search_mail") {
    const query = stringArg("query");
    if (!query) return failure("A search needs something to search for.");
    const result = await request(connection, "/me/messages", {
      query: {
        $search: searchTerm(query),
        $top: String(count(args.top, DEFAULT_RESULTS, MAX_RESULTS)),
        $select: MAIL_FIELDS,
      },
    });
    if (!result.ok) return failure(result.message);
    const body = (await result.response.json()) as { value?: Message[] };
    return asResult((body.value ?? []).map(mailLine).join("\n"));
  }

  if (toolName === "outlook_read_mail") {
    const messageId = stringArg("messageId");
    if (!messageId) return failure("A message id is needed to read a message.");
    const result = await request(
      connection,
      `/me/messages/${encodeURIComponent(messageId)}`,
      {
        query: {
          $select:
            "id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,webLink,hasAttachments",
        },
        prefer: ['outlook.body-content-type="text"'],
      },
    );
    if (!result.ok) return failure(result.message);
    const message = (await result.response.json()) as Message;
    const content = message.body?.content ?? message.bodyPreview ?? "";
    return asResult(
      [
        mailLine({ ...message, bodyPreview: undefined }),
        message.toRecipients?.length
          ? `to: ${message.toRecipients.map(who).join(", ")}`
          : null,
        message.ccRecipients?.length
          ? `cc: ${message.ccRecipients.map(who).join(", ")}`
          : null,
        message.hasAttachments
          ? "It has attachments, which this connector does not read."
          : null,
        "",
        message.body?.contentType === "html" ? plain(content) : content,
      ]
        .filter((line) => line !== null)
        .join("\n"),
    );
  }

  if (toolName === "calendar_list_events") {
    const start = instant(args.start) ?? new Date().toISOString();
    const end =
      instant(args.end) ??
      new Date(
        new Date(start).getTime() + DEFAULT_WINDOW_DAYS * 86_400_000,
      ).toISOString();
    if (new Date(end) <= new Date(start)) {
      return failure("The end has to be after the start.");
    }
    const result = await request(connection, "/me/calendarView", {
      query: {
        startDateTime: start,
        endDateTime: end,
        $top: "50",
        $orderby: "start/dateTime",
        $select: EVENT_FIELDS,
      },
      prefer: ['outlook.timezone="UTC"'],
    });
    if (!result.ok) return failure(result.message);
    const body = (await result.response.json()) as { value?: CalendarEvent[] };
    return asResult(
      (body.value ?? []).map(eventLine).join("\n") ||
        `Nothing is on the calendar between ${start} and ${end}.`,
    );
  }

  if (toolName === "teams_list_chats") {
    const result = await request(connection, "/me/chats", {
      query: {
        $top: String(MAX_RESULTS),
        $expand: "lastMessagePreview",
        $orderby: "lastMessagePreview/createdDateTime desc",
      },
    });
    if (!result.ok) return failure(result.message);
    const body = (await result.response.json()) as { value?: Chat[] };
    return asResult(
      (body.value ?? [])
        .map((chat) => {
          const last = chat.lastMessagePreview;
          const said = last?.body?.content
            ? plain(last.body.content).replace(/\s+/g, " ")
            : "";
          return `- ${[
            chat.topic?.trim() || `(${chat.chatType ?? "chat"} with no name)`,
            last?.createdDateTime && `last active ${last.createdDateTime}`,
            last?.from && who(last.from) && `last from ${who(last.from)}`,
            chat.id && `id: ${chat.id}`,
          ]
            .filter(Boolean)
            .join(" · ")}${said ? `\n  ${said}` : ""}`;
        })
        .join("\n"),
    );
  }

  if (toolName === "teams_read_chat") {
    const chatId = stringArg("chatId");
    if (!chatId) return failure("A chat id is needed to read a chat.");
    const result = await request(
      connection,
      `/me/chats/${encodeURIComponent(chatId)}/messages`,
      {
        query: {
          $top: String(count(args.top, DEFAULT_RESULTS, MAX_CHAT_MESSAGES)),
        },
      },
    );
    if (!result.ok) return failure(result.message);
    const body = (await result.response.json()) as { value?: ChatMessage[] };
    return asResult(
      (body.value ?? [])
        // System events ("X joined the chat") are not something anybody said.
        .filter((message) => message.messageType === "message")
        .map((message) => {
          const content = message.body?.content ?? "";
          const text =
            message.body?.contentType === "html" ? plain(content) : content;
          return `- ${[who(message.from) || "someone", message.createdDateTime]
            .filter(Boolean)
            .join(" · ")}\n  ${text.replace(/\n/g, "\n  ")}`;
        })
        .join("\n"),
    );
  }

  if (toolName === "sharepoint_search_files") {
    const query = stringArg("query");
    if (!query) return failure("A search needs something to search for.");
    const result = await request(connection, "/search/query", {
      method: "POST",
      body: {
        requests: [
          {
            entityTypes: ["driveItem"],
            query: { queryString: query },
            from: 0,
            size: DEFAULT_RESULTS,
          },
        ],
      },
    });
    if (!result.ok) return failure(result.message);
    const body = (await result.response.json()) as SearchResponse;
    const hits = (body.value ?? []).flatMap((entry) =>
      (entry.hitsContainers ?? []).flatMap((container) => container.hits ?? []),
    );
    return asResult(
      hits
        .map((hit) => {
          const file = hit.resource;
          const summary = hit.summary ? plain(hit.summary) : "";
          return `- ${[
            link(file?.name ?? "(untitled)", file?.webUrl),
            file?.lastModifiedDateTime &&
              `modified ${file.lastModifiedDateTime}`,
          ]
            .filter(Boolean)
            .join(" · ")}${summary ? `\n  ${summary}` : ""}`;
        })
        .join("\n"),
    );
  }

  return failure(
    `${toolName} is not a tool this connector implements. The stored tool list is out of date; refresh it on the Plugins page.`,
  );
}
