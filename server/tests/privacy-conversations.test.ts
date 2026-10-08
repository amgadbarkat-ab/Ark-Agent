import { describe, expect, test } from "bun:test";
import {
  ConversationServiceError,
  hubConversations,
} from "../src/privacy/conversations";

/** The hub client the privacy features use, against a fake hub that follows hub/src/rest.ts. */

type Call = { method: string; url: URL; headers: Headers; body: unknown };

function fakeHub(answer: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = {
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return answer(call);
  }) as unknown as typeof fetch;
  return {
    calls,
    client: hubConversations({
      apiUrl: "http://hub.test:7100/",
      apiKey: "the-key",
      fetchImpl,
    }),
  };
}

describe("listing a person's conversations", () => {
  test("asks for archived ones too, as them, with the key, and follows every page", async () => {
    const pages = [
      { threads: [{ id: "a" }, { id: "b" }], nextCursor: "c1" },
      { threads: [{ id: "c" }], nextCursor: null },
    ];
    const hub = fakeHub((call) =>
      Response.json(pages[call.url.searchParams.get("cursor") ? 1 : 0]),
    );
    const threads = await hub.client.threads("user-1");
    expect(threads.map((t) => t.id)).toEqual(["a", "b", "c"]);
    const first = hub.calls[0];
    expect(first?.url.origin).toBe("http://hub.test:7100");
    expect(first?.url.searchParams.get("userId")).toBe("user-1");
    expect(first?.url.searchParams.get("includeArchived")).toBe("true");
    expect(first?.headers.get("authorization")).toBe("Bearer the-key");
    expect(hub.calls[1]?.url.searchParams.get("cursor")).toBe("c1");
  });

  test("a refusal is an error with a sentence, not an empty list", async () => {
    const hub = fakeHub(() => new Response("no", { status: 401 }));
    await expect(hub.client.threads("u")).rejects.toBeInstanceOf(
      ConversationServiceError,
    );
  });

  test("an unreachable hub is an error", async () => {
    const client = hubConversations({
      apiUrl: "http://hub.test",
      apiKey: "k",
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    await expect(client.threads("u")).rejects.toThrow(/could not be reached/);
  });
});

describe("a conversation's messages and its removal", () => {
  test("messages are read as the person, and an id with odd characters stays in its path", async () => {
    const hub = fakeHub(() => Response.json({ messages: [{ role: "user" }] }));
    expect(await hub.client.messages("t/../x", "u 1")).toEqual([
      { role: "user" },
    ]);
    expect(hub.calls[0]?.url.pathname).toBe("/api/threads/t%2F..%2Fx/messages");
    expect(hub.calls[0]?.url.searchParams.get("userId")).toBe("u 1");
  });

  test("a conversation that is gone has no messages, and removing it again is fine", async () => {
    const hub = fakeHub(() => new Response("{}", { status: 404 }));
    expect(await hub.client.messages("t", "u")).toEqual([]);
    await hub.client.remove("t", "u");
  });

  test("removing sends the person's id, and a refusal is an error", async () => {
    const ok = fakeHub(() => Response.json({ deleted: true }));
    await ok.client.remove("t1", "user-1");
    expect(ok.calls[0]).toMatchObject({
      method: "DELETE",
      body: { userId: "user-1" },
    });
    expect(ok.calls[0]?.url.pathname).toBe("/api/threads/t1");

    const refused = fakeHub(() => new Response("boom", { status: 500 }));
    await expect(refused.client.remove("t1", "u")).rejects.toBeInstanceOf(
      ConversationServiceError,
    );
  });
});
