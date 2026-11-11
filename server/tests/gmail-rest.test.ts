import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { accessFor } from "../src/plugins/access";
import { catalogueEntry, hostAdmissible } from "../src/plugins/catalogue";
import {
  bodyText,
  callTool,
  decodeBody,
  htmlToText,
  listTools,
  rfc822,
} from "../src/plugins/gmail-rest";
import { MAX_RESULT_CHARS } from "../src/plugins/mcp";
import { transportFor } from "../src/plugins/transport";

/**
 * The Gmail adapter (desk #83), asserted without Google.
 *
 * `fetch` is replaced, because what is under test is the translation: which Gmail request a tool
 * becomes, how a message's parts become text, and what Google's refusals read as. Nothing here has
 * been tried against a real mailbox, and these tests are not a claim that it has.
 */

const connection = {
  url: "https://gmail.googleapis.com/gmail/v1",
  token: "test-token",
};

const realFetch = globalThis.fetch;
let escapedToNetwork: string[] = [];

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

type Seen = {
  url: URL;
  method: string;
  authorization: string | null;
  body?: unknown;
};

/** Answers by path: the listing, then each message by id. */
function stubGmail(
  answer: (url: URL) => { body: unknown; status?: number },
): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: string | URL, options?: RequestInit) => {
    const url = new URL(String(input));
    seen.push({
      url,
      method: options?.method ?? "GET",
      authorization: new Headers(options?.headers).get("authorization"),
      body: options?.body ? JSON.parse(String(options.body)) : undefined,
    });
    const { body, status } = answer(url);
    return new Response(JSON.stringify(body), {
      status: status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return seen;
}

const b64 = (text: string) =>
  Buffer.from(text, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const headers = (values: Record<string, string>) =>
  Object.entries(values).map(([name, value]) => ({ name, value }));

describe("the entry and the transport", () => {
  test("Gmail is a per-person connector on Gmail's own host: read, plus send", () => {
    const entry = catalogueEntry("google-gmail");
    expect(entry?.transport).toBe("gmail-rest");
    expect(entry?.host).toBe("https://gmail.googleapis.com");
    expect(entry?.path).toBe("/gmail/v1");
    if (entry?.auth.kind !== "user-oauth") throw new Error("not user-oauth");
    expect(entry.auth.scopes).toEqual([
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
    ]);
    expect(entry.auth.authorizationParams).toEqual({
      access_type: "offline",
      prompt: "consent",
    });
    expect(hostAdmissible(entry, "https://gmail.googleapis.com")).toBe(true);
    expect(hostAdmissible(entry, "https://www.googleapis.com")).toBe(false);
    expect(
      transportFor(
        accessFor(
          { provenance: "first-party", url: "https://gmail.googleapis.com" },
          entry,
        ).transport,
      ).callTool,
    ).toBe(callTool);
  });

  test("it advertises exactly the tools it handles, and only sending writes", async () => {
    const tools = await listTools(connection);
    expect(tools.map((tool) => tool.name)).toEqual([
      "search_messages",
      "list_recent_messages",
      "read_message",
      "send_message",
    ]);
    const entry = catalogueEntry("google-gmail");
    for (const tool of tools) {
      if (tool.name === "send_message") {
        // On the write list, so every send is held for the person's approval.
        expect(entry?.writeTools).toContain(tool.name);
      } else {
        expect(entry?.writeTools).not.toContain(tool.name);
      }
    }
  });

  test("every advertised tool is one the dispatcher handles", async () => {
    stubGmail(() => ({ body: { messages: [] } }));
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

describe("searching and listing", () => {
  test("a search sends Gmail's own words, with the person's token, and lists what it found", async () => {
    const seen = stubGmail((url) => {
      if (url.pathname.endsWith("/users/me/messages")) {
        return { body: { messages: [{ id: "m1" }, { id: "m2" }] } };
      }
      const id = url.pathname.split("/").pop();
      return {
        body: {
          id,
          snippet: id === "m1" ? "Two cases of Assyrtiko" : "Delivery Friday",
          labelIds: id === "m1" ? ["INBOX", "UNREAD"] : ["INBOX"],
          payload: {
            headers: headers({
              From: "Anna <anna@example.com>",
              Subject: id === "m1" ? "Order 42" : "Re: Order 42",
              Date: "Tue, 10 Nov 2026 09:00:00 +0200",
            }),
          },
        },
      };
    });

    const result = await callTool(connection, "search_messages", {
      query: "from:anna@example.com newer_than:7d",
    });

    expect(result.isError).toBe(false);
    expect(seen[0]?.url.pathname).toBe("/gmail/v1/users/me/messages");
    expect(seen[0]?.url.searchParams.get("q")).toBe(
      "from:anna@example.com newer_than:7d",
    );
    expect(seen[0]?.url.searchParams.get("maxResults")).toBe("20");
    expect(
      seen.every((each) => each.authorization === "Bearer test-token"),
    ).toBe(true);
    expect(seen.every((each) => each.method === "GET")).toBe(true);
    // Each message is fetched for its headers only, never its body.
    const detail = seen[1]?.url;
    expect(detail?.searchParams.get("format")).toBe("metadata");
    expect(detail?.searchParams.getAll("metadataHeaders")).toEqual([
      "From",
      "To",
      "Subject",
      "Date",
    ]);
    expect(result.text).toContain(
      'from Anna <anna@example.com> · "Order 42" (unread)',
    );
    expect(result.text).toContain("Two cases of Assyrtiko");
    expect(result.text).toContain("id: m1");
    expect(result.text).toContain('"Re: Order 42"');
  });

  test("the recent list is the inbox", async () => {
    const seen = stubGmail(() => ({ body: {} }));
    const result = await callTool(connection, "list_recent_messages", {});
    expect(seen[0]?.url.searchParams.get("labelIds")).toBe("INBOX");
    expect(seen[0]?.url.searchParams.has("q")).toBe(false);
    expect(result.isError).toBe(false);
    expect(result.text).toContain("Nothing was found");
  });

  test("a search with nothing to search for is refused without asking Google", async () => {
    const result = await callTool(connection, "search_messages", {
      query: "   ",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("something to search for");
  });

  test("one message that cannot be read does not lose the others", async () => {
    stubGmail((url) => {
      if (url.pathname.endsWith("/users/me/messages")) {
        return { body: { messages: [{ id: "ok" }, { id: "gone" }] } };
      }
      if (url.pathname.endsWith("/gone")) {
        return {
          body: { error: { message: "Requested entity was not found." } },
          status: 404,
        };
      }
      return {
        body: {
          id: "ok",
          payload: { headers: headers({ Subject: "Still here" }) },
        },
      };
    });
    const result = await callTool(connection, "search_messages", {
      query: "x",
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain('"Still here"');
    expect(result.text).toContain(
      "message gone could not be read: Gmail refused this request (404): Requested entity was not found.",
    );
  });

  test("Google's refusal is passed on in Google's words", async () => {
    stubGmail(() => ({
      body: {
        error: {
          message:
            "Gmail API has not been used in project 123 before or it is disabled.",
        },
      },
      status: 403,
    }));
    const result = await callTool(connection, "list_recent_messages", {});
    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      "Gmail refused this request (403): Gmail API has not been used in project 123 before or it is disabled.",
    );
  });

  test("no token, no request", async () => {
    const result = await callTool(
      { url: connection.url },
      "list_recent_messages",
      {},
    );
    expect(result.isError).toBe(true);
    expect(result.text).toContain("No credential");
  });
});

describe("reading one message", () => {
  test("headers, the plain text, and the names of attachments", async () => {
    const seen = stubGmail(() => ({
      body: {
        id: "m1",
        payload: {
          mimeType: "multipart/mixed",
          headers: headers({
            From: "Anna <anna@example.com>",
            To: "orders@wine24.example",
            Cc: "desk@wine24.example",
            Subject: "Παραγγελία 42",
            Date: "Tue, 10 Nov 2026 09:00:00 +0200",
          }),
          parts: [
            {
              mimeType: "multipart/alternative",
              parts: [
                {
                  mimeType: "text/plain",
                  body: { data: b64("Καλημέρα,\n\nδύο κιβώτια Ασύρτικο.\n") },
                },
                {
                  mimeType: "text/html",
                  body: { data: b64("<p>Καλημέρα</p>") },
                },
              ],
            },
            {
              mimeType: "application/pdf",
              filename: "invoice-42.pdf",
              body: { size: 1234 },
            },
          ],
        },
      },
    }));

    const result = await callTool(connection, "read_message", {
      messageId: "m1",
    });

    expect(seen[0]?.url.pathname).toBe("/gmail/v1/users/me/messages/m1");
    expect(seen[0]?.url.searchParams.get("format")).toBe("full");
    expect(result.isError).toBe(false);
    expect(result.text).toBe(
      [
        "From: Anna <anna@example.com>",
        "To: orders@wine24.example",
        "Cc: desk@wine24.example",
        "Date: Tue, 10 Nov 2026 09:00:00 +0200",
        "Subject: Παραγγελία 42",
        "Attachments (not opened): invoice-42.pdf",
        "",
        "Καλημέρα,\n\nδύο κιβώτια Ασύρτικο.",
      ].join("\n"),
    );
  });

  test("a message that is only HTML is read as its text", () => {
    const text = bodyText({
      payload: {
        mimeType: "text/html",
        body: {
          data: b64(
            "<html><head><style>p{}</style></head><body><p>Hello&nbsp;Anna,</p><ul><li>Two &amp; three</li></ul><br>Thanks</body></html>",
          ),
        },
      },
    });
    expect(text).toBe("Hello Anna,\n- Two & three\n\nThanks");
  });

  test("an id that is not given is refused without asking Google", async () => {
    const result = await callTool(connection, "read_message", {});
    expect(result.isError).toBe(true);
  });

  test("an id is never a path", async () => {
    const seen = stubGmail(() => ({ body: { id: "x" } }));
    await callTool(connection, "read_message", { messageId: "../../settings" });
    expect(seen[0]?.url.pathname).toBe(
      "/gmail/v1/users/me/messages/..%2F..%2Fsettings",
    );
  });

  test("a long message is cut and says so", async () => {
    stubGmail(() => ({
      body: {
        id: "long",
        payload: {
          mimeType: "text/plain",
          body: { data: b64("a".repeat(MAX_RESULT_CHARS + 500)) },
        },
      },
    }));
    const result = await callTool(connection, "read_message", {
      messageId: "long",
    });
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("[truncated");
  });
});

describe("decoding", () => {
  test("Gmail's base64url decodes to UTF-8", () => {
    expect(decodeBody(b64("Ωραία ~ ? >"))).toBe("Ωραία ~ ? >");
  });

  test("numeric entities and unknown ones", () => {
    expect(htmlToText("&#937;&#x3c9; &bogus;")).toBe("Ωω &bogus;");
  });
});

describe("sending a message (desk #83, the Wine24 email scene)", () => {
  const fromRaw = (raw: string) =>
    Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "utf8",
    );

  test("goes to Gmail's send endpoint as one plain-text message, Greek intact", async () => {
    const seen = stubGmail(() => ({ body: { id: "sent-1" } }));
    const result = await callTool(connection, "send_message", {
      to: "anna@example.com, desk@wine24.example",
      cc: "boss@wine24.example",
      subject: "Παραγγελία 42",
      body: "Καλημέρα,\nη παραγγελία στάλθηκε.",
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain(
      "Sent to anna@example.com, desk@wine24.example, boss@wine24.example",
    );
    expect(result.text).toContain("sent-1");
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.url.pathname).toBe("/gmail/v1/users/me/messages/send");
    expect(seen[0]?.authorization).toBe("Bearer test-token");
    const message = fromRaw((seen[0]?.body as { raw: string }).raw);
    expect(message).toContain("To: anna@example.com, desk@wine24.example\r\n");
    expect(message).toContain("Cc: boss@wine24.example\r\n");
    expect(message).toContain(
      `Subject: =?UTF-8?B?${Buffer.from("Παραγγελία 42").toString("base64")}?=\r\n`,
    );
    const body = message.split("\r\n\r\n")[1] ?? "";
    expect(
      Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8"),
    ).toBe("Καλημέρα,\r\nη παραγγελία στάλθηκε.");
  });

  test("an address with a line break in it is refused before Google is asked", async () => {
    for (const to of [
      "anna@example.com\nBcc: thief@evil.test",
      "Anna <anna@example.com>",
      "not an address",
    ]) {
      const result = await callTool(connection, "send_message", {
        to,
        subject: "x",
        body: "y",
      });
      expect(result.isError).toBe(true);
    }
  });

  test("a subject cannot add a header", () => {
    const message = rfc822({
      to: ["a@example.com"],
      cc: [],
      subject: "Hello",
      body: "x",
    });
    expect(message.split("\r\n\r\n")[0]?.split("\r\n")).toHaveLength(5);
  });

  test("a message with no recipient, subject or text is refused", async () => {
    for (const args of [
      { subject: "s", body: "b" },
      { to: "a@example.com", body: "b" },
      { to: "a@example.com", subject: "s", body: "  " },
    ]) {
      expect((await callTool(connection, "send_message", args)).isError).toBe(
        true,
      );
    }
  });

  test("a grant made before sending existed says to connect again", async () => {
    stubGmail(() => ({
      body: {
        error: { message: "Request had insufficient authentication scopes." },
      },
      status: 403,
    }));
    const result = await callTool(connection, "send_message", {
      to: "a@example.com",
      subject: "s",
      body: "b",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Connect Gmail again");
  });
});
