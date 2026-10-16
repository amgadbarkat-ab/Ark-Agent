import { afterAll, describe, expect, test } from "bun:test";
import {
  attempt,
  CASES,
  judge,
  type Message,
  render,
  summarise,
} from "./starter-model-toolcheck";

const servers: Array<{ stop: (force?: boolean) => unknown }> = [];
afterAll(() => {
  for (const server of servers) server.stop(true);
});

const byId = (id: string) => {
  const found = CASES.find((c) => c.id === id);
  if (!found) throw new Error(`no case ${id}`);
  return found;
};

const call = (name: string, args: unknown): Message => ({
  content: null,
  tool_calls: [
    {
      function: {
        name,
        arguments: typeof args === "string" ? args : JSON.stringify(args),
      },
    },
  ],
});

describe("judging an answer", () => {
  test("the right tool with complete arguments passes", () => {
    const verdict = judge(
      byId("email-en"),
      call("send_email", {
        to: "Anna@example.com",
        subject: "Invoice",
        body: "Invoice 1042 will be paid on Friday.",
      }),
    );
    expect(verdict).toEqual({ ok: true, why: "right tool, valid arguments" });
  });

  test("the wrong tool, invalid JSON, a missing argument and a wrong type each fail with their own reason", () => {
    expect(
      judge(byId("email-en"), call("search_web", { query: "x" })).why,
    ).toBe("called search_web, wanted send_email");
    expect(judge(byId("email-en"), call("send_email", "{not json")).why).toBe(
      "arguments are not valid JSON",
    );
    expect(
      judge(byId("email-en"), call("send_email", { to: "anna@example.com" }))
        .why,
    ).toBe("missing required argument subject");
    expect(
      judge(
        byId("calendar-en"),
        call("create_calendar_event", {
          title: "Supplier review",
          start: "2026-11-03T10:00",
          duration_minutes: "30",
        }),
      ).why,
    ).toBe("argument duration_minutes is string, wanted integer");
  });

  test("an argument that is present but wrong fails", () => {
    expect(
      judge(
        byId("calendar-en"),
        call("create_calendar_event", {
          title: "Supplier review",
          start: "2026-11-03T10:00",
          duration_minutes: 45,
        }),
      ).why,
    ).toBe("argument duration_minutes is 45, wanted 30");
    expect(
      judge(byId("file-en"), call("read_file", { path: "todo.txt" })).ok,
    ).toBe(false);
  });

  test("no tool call where one is needed fails", () => {
    expect(
      judge(byId("search-en"), { content: "I think it is about 80." }).why,
    ).toBe("no tool call");
  });

  test("words are right when no tool is wanted, and a tool then is wrong", () => {
    expect(judge(byId("words-en"), { content: "Hello!" }).ok).toBe(true);
    expect(
      judge(byId("words-en"), call("search_web", { query: "hello" })).why,
    ).toMatch(/called search_web when none was wanted/);
    expect(judge(byId("words-en"), { content: "" }).why).toBe(
      "no words and no tool",
    );
  });

  test("a Greek request answered without Greek letters fails", () => {
    expect(judge(byId("words-el"), { content: "Hello there" }).why).toBe(
      "answered a Greek request without Greek",
    );
    expect(judge(byId("words-el"), { content: "Γεια σου!" }).ok).toBe(true);
  });
});

describe("running against a server", () => {
  test("sends the tools and the person's words, and reads the answer", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        seen.push((await request.json()) as Record<string, unknown>);
        return Response.json({
          choices: [
            {
              message: call("search_web", { query: "Brent crude oil price" }),
            },
          ],
        });
      },
    });
    servers.push(server);
    const result = await attempt(
      {
        url: `http://127.0.0.1:${server.port}/v1`,
        model: "m",
        timeoutSeconds: 5,
      },
      byId("search-en"),
    );
    expect(result.verdict.ok).toBe(true);
    const body = seen[0] as {
      model: string;
      tools: unknown[];
      messages: { role: string; content: string }[];
    };
    expect(body.model).toBe("m");
    expect(body.tools.length).toBe(4);
    expect(body.messages[1]?.content).toBe(byId("search-en").prompt);
  });

  test("an error status is a failure with the status in it", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("busy", { status: 503 }),
    });
    servers.push(server);
    const result = await attempt(
      {
        url: `http://127.0.0.1:${server.port}/v1`,
        model: "m",
        timeoutSeconds: 5,
      },
      byId("search-en"),
    );
    expect(result.verdict).toEqual({ ok: false, why: "HTTP 503" });
  });
});

describe("the summary", () => {
  test("counts by language and groups repeated failures", () => {
    const summary = summarise([
      {
        caseId: "a",
        language: "english",
        verdict: { ok: true, why: "" },
        seconds: 1,
      },
      {
        caseId: "b",
        language: "greek",
        verdict: { ok: false, why: "no tool call" },
        seconds: 3,
      },
      {
        caseId: "b",
        language: "greek",
        verdict: { ok: false, why: "no tool call" },
        seconds: 3,
      },
    ]);
    expect(summary.passed).toBe(1);
    expect(summary.byLanguage.greek).toEqual({ total: 2, passed: 0 });
    const text = render(summary);
    expect(text).toContain("Passed 1 of 3 (33%)");
    expect(text).toContain("2x b: no tool call");
  });
});
