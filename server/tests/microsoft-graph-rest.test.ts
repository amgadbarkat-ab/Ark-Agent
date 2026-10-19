import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { accessFor } from "../src/plugins/access";
import { catalogueEntry } from "../src/plugins/catalogue";
import { callTool, listTools } from "../src/plugins/microsoft-graph-rest";
import { MAX_RESULT_CHARS } from "../src/plugins/mcp";
import { transportFor } from "../src/plugins/transport";

/**
 * The Microsoft 365 adapter, asserted without Microsoft.
 *
 * `fetch` is replaced, because what is under test is the translation: which Graph request a tool
 * becomes, what Microsoft's refusals read as, and that an empty answer says so in words. Nothing here
 * has been tried against a real Microsoft account, and these tests are not a claim that it has.
 */

const connection = {
  url: "https://graph.microsoft.com/v1.0",
  token: "test-token",
};

const realFetch = globalThis.fetch;
let escapedToNetwork: string[] = [];

type Seen = {
  url: URL;
  method: string;
  authorization: string | null;
  prefer: string | null;
  body: unknown;
};

beforeEach(() => {
  escapedToNetwork = [];
  globalThis.fetch = (async (input: string | URL): Promise<Response> => {
    escapedToNetwork.push(String(input));
    throw new Error(`unstubbed fetch escaped to the network: ${String(input)}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  expect(escapedToNetwork).toEqual([]);
});

function stubFetch(body: unknown, init: { status?: number } = {}) {
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: string | URL, options?: RequestInit) => {
    const headers = new Headers(options?.headers);
    seen.push({
      url: new URL(String(input)),
      method: options?.method ?? "GET",
      authorization: headers.get("authorization"),
      prefer: headers.get("prefer"),
      body: options?.body ? JSON.parse(String(options.body)) : undefined,
    });
    return new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return seen;
}

describe("the entry and the transport", () => {
  test("Microsoft 365 is a read-only, per-person connector reached over Graph", () => {
    const entry = catalogueEntry("microsoft-365");
    expect(entry?.transport).toBe("microsoft-graph-rest");
    expect(entry?.host).toBe("https://graph.microsoft.com");
    expect(entry?.auth.kind).toBe("user-oauth");
    if (entry?.auth.kind !== "user-oauth") throw new Error("not user-oauth");
    // Only `.Read` scopes, plus the two that are not about a resource at all.
    for (const scope of entry.auth.scopes) {
      expect(
        scope === "offline_access" ||
          scope === "User.Read" ||
          scope.endsWith(".Read") ||
          scope.endsWith(".Read.All"),
      ).toBe(true);
    }
    expect(entry.auth.scopes).toContain("offline_access");
    expect(
      transportFor(
        accessFor(
          { provenance: "first-party", url: "https://graph.microsoft.com" },
          entry,
        ).transport,
      ).callTool,
    ).toBe(callTool);
  });

  test("it advertises exactly the tools it handles, and none of them writes", async () => {
    const tools = await listTools(connection);
    expect(tools.map((tool) => tool.name)).toEqual([
      "outlook_search_mail",
      "outlook_read_mail",
      "calendar_list_events",
      "teams_list_chats",
      "teams_read_chat",
      "sharepoint_search_files",
    ]);
    const entry = catalogueEntry("microsoft-365");
    for (const tool of tools) {
      expect(entry?.writeTools).not.toContain(tool.name);
    }
  });

  test("every advertised tool is one the dispatcher handles", async () => {
    stubFetch({ value: [] });
    for (const tool of await listTools(connection)) {
      const required: unknown[] = Array.isArray(tool.inputSchema.required)
        ? tool.inputSchema.required
        : [];
      const args = Object.fromEntries(
        required.map((name) => [String(name), "given"]),
      );
      const result = await callTool(connection, tool.name, args);
      expect(result.text).not.toContain("is not a tool this connector");
    }
  });
});

describe("Outlook mail", () => {
  test("a search asks Graph for the person's messages, with their own token", async () => {
    const seen = stubFetch({
      value: [
        {
          id: "AAMk=",
          subject: "Invoice 42",
          from: { emailAddress: { name: "Ana", address: "ana@example.com" } },
          receivedDateTime: "2026-10-01T08:00:00Z",
          bodyPreview: "Please find   the invoice",
          webLink: "https://outlook.office.com/mail/id/AAMk=",
        },
      ],
    });
    const result = await callTool(connection, "outlook_search_mail", {
      query: 'invoice "42"',
      top: 3,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url.pathname).toBe("/v1.0/me/messages");
    expect(seen[0]?.url.searchParams.get("$search")).toBe('"invoice  42 "');
    expect(seen[0]?.url.searchParams.get("$top")).toBe("3");
    expect(seen[0]?.authorization).toBe("Bearer test-token");
    expect(result.isError).toBe(false);
    expect(result.text).toContain(
      "[Invoice 42](https://outlook.office.com/mail/id/AAMk=)",
    );
    expect(result.text).toContain("from Ana <ana@example.com>");
    expect(result.text).toContain("id: AAMk=");
    expect(result.text).toContain("Please find the invoice");
  });

  test("a quote in the search cannot leave the quotes Graph wants", async () => {
    const seen = stubFetch({ value: [] });
    await callTool(connection, "outlook_search_mail", { query: 'a" OR b' });
    expect(seen[0]?.url.searchParams.get("$search")).toBe('"a  OR b"');
  });

  test("the number of results is bounded however much is asked for", async () => {
    const seen = stubFetch({ value: [] });
    await callTool(connection, "outlook_search_mail", {
      query: "x",
      top: 5000,
    });
    expect(seen[0]?.url.searchParams.get("$top")).toBe("25");
    await callTool(connection, "outlook_search_mail", { query: "x", top: -3 });
    expect(seen[1]?.url.searchParams.get("$top")).toBe("1");
  });

  test("a search that matched nothing says so, so it is not filled in from memory", async () => {
    stubFetch({ value: [] });
    const result = await callTool(connection, "outlook_search_mail", {
      query: "nothing",
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("Nothing was found");
  });

  test("a message is read as text, with who it went to", async () => {
    const seen = stubFetch({
      id: "AAMk=",
      subject: "Plan",
      from: { emailAddress: { name: "Ana", address: "ana@example.com" } },
      toRecipients: [{ emailAddress: { address: "me@example.com" } }],
      body: { contentType: "text", content: "See you at nine." },
      hasAttachments: true,
    });
    const result = await callTool(connection, "outlook_read_mail", {
      messageId: "AAMk=/odd id",
    });
    expect(seen[0]?.url.pathname).toBe("/v1.0/me/messages/AAMk%3D%2Fodd%20id");
    expect(seen[0]?.prefer).toBe('outlook.body-content-type="text"');
    expect(result.text).toContain("to: me@example.com");
    expect(result.text).toContain("See you at nine.");
    expect(result.text).toContain(
      "attachments, which this connector does not read",
    );
  });

  test("a long message is cut and says it was", async () => {
    stubFetch({
      id: "1",
      subject: "Long",
      body: { contentType: "text", content: "x".repeat(MAX_RESULT_CHARS * 2) },
    });
    const result = await callTool(connection, "outlook_read_mail", {
      messageId: "1",
    });
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("[truncated");
  });
});

describe("the calendar", () => {
  test("lists the window asked for, in UTC and in time order", async () => {
    const seen = stubFetch({
      value: [
        {
          subject: "Standup",
          start: { dateTime: "2026-10-20T09:00:00.0000000" },
          end: { dateTime: "2026-10-20T09:15:00.0000000" },
          location: { displayName: "Room 4" },
          organizer: {
            emailAddress: { name: "Ben", address: "ben@example.com" },
          },
          isOnlineMeeting: true,
          onlineMeeting: { joinUrl: "https://teams.example/join" },
        },
      ],
    });
    const result = await callTool(connection, "calendar_list_events", {
      start: "2026-10-20",
      end: "2026-10-21",
    });
    expect(seen[0]?.url.pathname).toBe("/v1.0/me/calendarView");
    expect(seen[0]?.url.searchParams.get("startDateTime")).toBe(
      "2026-10-20T00:00:00.000Z",
    );
    expect(seen[0]?.url.searchParams.get("endDateTime")).toBe(
      "2026-10-21T00:00:00.000Z",
    );
    expect(seen[0]?.url.searchParams.get("$orderby")).toBe("start/dateTime");
    expect(seen[0]?.prefer).toBe('outlook.timezone="UTC"');
    expect(result.text).toContain("Standup");
    expect(result.text).toContain("at Room 4");
    expect(result.text).toContain("online: https://teams.example/join");
  });

  test("with no dates it looks seven days ahead", async () => {
    const seen = stubFetch({ value: [] });
    await callTool(connection, "calendar_list_events", {});
    const start = new Date(
      String(seen[0]?.url.searchParams.get("startDateTime")),
    );
    const end = new Date(String(seen[0]?.url.searchParams.get("endDateTime")));
    expect(Math.round((end.getTime() - start.getTime()) / 86_400_000)).toBe(7);
  });

  test("an empty calendar says so for the window it looked at", async () => {
    stubFetch({ value: [] });
    const result = await callTool(connection, "calendar_list_events", {
      start: "2026-10-20",
      end: "2026-10-21",
    });
    expect(result.text).toContain("Nothing is on the calendar between");
  });

  test("an end before the start is refused before anything is asked", async () => {
    const result = await callTool(connection, "calendar_list_events", {
      start: "2026-10-21",
      end: "2026-10-20",
    });
    expect(result.isError).toBe(true);
  });
});

describe("Teams", () => {
  test("chats are listed most recent first, with the last thing said in each", async () => {
    const seen = stubFetch({
      value: [
        {
          id: "19:abc",
          topic: "Launch",
          chatType: "group",
          lastMessagePreview: {
            createdDateTime: "2026-10-18T10:00:00Z",
            from: { user: { displayName: "Cy" } },
            body: { content: "<p>Ship it &amp; relax</p>" },
          },
        },
      ],
    });
    const result = await callTool(connection, "teams_list_chats", {});
    expect(seen[0]?.url.pathname).toBe("/v1.0/me/chats");
    expect(seen[0]?.url.searchParams.get("$expand")).toBe("lastMessagePreview");
    expect(result.text).toContain("Launch");
    expect(result.text).toContain("id: 19:abc");
    expect(result.text).toContain("Ship it & relax");
  });

  test("a chat is read as words, and the system events in it are not messages", async () => {
    const seen = stubFetch({
      value: [
        {
          messageType: "message",
          createdDateTime: "2026-10-18T10:00:00Z",
          from: { user: { displayName: "Cy" } },
          body: { contentType: "html", content: "<div>Hello<br>there</div>" },
        },
        {
          messageType: "systemEventMessage",
          from: null,
          body: { content: "Cy added Dee" },
        },
      ],
    });
    const result = await callTool(connection, "teams_read_chat", {
      chatId: "19:abc",
      top: 2,
    });
    expect(seen[0]?.url.pathname).toBe("/v1.0/me/chats/19%3Aabc/messages");
    expect(seen[0]?.url.searchParams.get("$top")).toBe("2");
    expect(result.text).toContain("Cy");
    expect(result.text).toContain("Hello");
    expect(result.text).not.toContain("<div>");
    expect(result.text).not.toContain("added Dee");
  });
});

describe("SharePoint and OneDrive", () => {
  test("a search posts one file query and lists what came back with links", async () => {
    const seen = stubFetch({
      value: [
        {
          hitsContainers: [
            {
              hits: [
                {
                  summary: "the <c0>budget</c0> for 2027",
                  resource: {
                    name: "Budget [draft].xlsx",
                    webUrl: "https://contoso.sharepoint.com/budget",
                    lastModifiedDateTime: "2026-09-30T12:00:00Z",
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    const result = await callTool(connection, "sharepoint_search_files", {
      query: "budget",
    });
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.url.pathname).toBe("/v1.0/search/query");
    expect(seen[0]?.body).toEqual({
      requests: [
        {
          entityTypes: ["driveItem"],
          query: { queryString: "budget" },
          from: 0,
          size: 10,
        },
      ],
    });
    expect(result.text).toContain(
      "[Budget \\[draft\\].xlsx](https://contoso.sharepoint.com/budget)",
    );
    expect(result.text).toContain("the budget for 2027");
  });
});

describe("when Microsoft says no", () => {
  test("its own sentence is kept, with the status", async () => {
    stubFetch(
      {
        error: {
          code: "Forbidden",
          message: "Insufficient privileges to complete the operation.",
        },
      },
      { status: 403 },
    );
    const result = await callTool(connection, "teams_list_chats", {});
    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      "Microsoft 365 refused this request (403): Insufficient privileges to complete the operation.",
    );
  });

  test("a pause request is said as one", async () => {
    stubFetch({ error: { message: "Too many requests" } }, { status: 429 });
    const result = await callTool(connection, "outlook_search_mail", {
      query: "x",
    });
    expect(result.text).toContain("(429)");
    expect(result.text).toContain("try again in a minute");
  });

  test("a call with no credential is named, not sent as 'Bearer undefined'", async () => {
    const result = await callTool(
      { url: connection.url },
      "teams_list_chats",
      {},
    );
    expect(result.isError).toBe(true);
    expect(result.text).toContain("No credential was available");
  });

  test("a missing required argument is refused before Graph is asked", async () => {
    for (const [tool, args] of [
      ["outlook_search_mail", {}],
      ["outlook_read_mail", {}],
      ["teams_read_chat", {}],
      ["sharepoint_search_files", { query: "  " }],
    ] as const) {
      const result = await callTool(connection, tool, args);
      expect(result.isError).toBe(true);
    }
  });

  test("a tool that is not here is refused by name", async () => {
    const result = await callTool(connection, "outlook_send_mail", {
      to: "x@example.com",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("is not a tool this connector implements");
  });
});
