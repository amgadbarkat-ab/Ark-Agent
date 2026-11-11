import { describe, expect, test } from "bun:test";
import {
  capOutput,
  fetchWithModelLimits,
  outputCapFor,
  RATE_LIMITED_SENTENCE,
  sendWithModelLimits,
  waitFor,
} from "../src/models/rate-limit";

/** DT Lab, v0.1.31: Mercury 3 answered 429 "output token limit exceeded" and the turn said nothing. */
const MERCURY = "https://api.inceptionlabs.ai/v1/chat/completions";

const noWait = async () => {};

describe("the output cap", () => {
  test("is only for providers listed", () => {
    expect(outputCapFor(MERCURY)).toBe(8192);
    expect(outputCapFor("https://api.openai.com/v1/chat/completions")).toBe(
      undefined,
    );
  });

  test("a chat request that names no limit is given one", () => {
    const body = JSON.stringify({ model: "mercury-3", messages: [] });
    expect(JSON.parse(capOutput(body, 8192)).max_tokens).toBe(8192);
  });

  test("a Responses request gets the Responses field", () => {
    const body = JSON.stringify({ model: "m", input: "hi" });
    expect(JSON.parse(capOutput(body, 100)).max_output_tokens).toBe(100);
  });

  test("a larger limit is brought down, a smaller one is left alone", () => {
    expect(
      JSON.parse(capOutput(JSON.stringify({ max_tokens: 50_000 }), 8192))
        .max_tokens,
    ).toBe(8192);
    const small = JSON.stringify({ max_completion_tokens: 512 });
    expect(capOutput(small, 8192)).toBe(small);
  });

  test("a body that is not JSON goes as it was", () => {
    expect(capOutput("not json", 10)).toBe("not json");
  });
});

describe("a 429", () => {
  const limited = (headers: Record<string, string> = {}) =>
    new Response(
      '{"error":{"message":"Rate limit reached: output token limit exceeded"}}',
      {
        status: 429,
        headers,
      },
    );

  test("is retried, with the capped body, and the answer that follows is returned", async () => {
    const sent: string[] = [];
    let calls = 0;
    const response = await sendWithModelLimits(
      MERCURY,
      JSON.stringify({ messages: [] }),
      async (body) => {
        sent.push(body);
        calls += 1;
        return calls === 1 ? limited() : new Response("ok");
      },
      noWait,
    );
    expect(await response.text()).toBe("ok");
    expect(sent).toHaveLength(2);
    expect(sent.every((body) => JSON.parse(body).max_tokens === 8192)).toBe(
      true,
    );
  });

  test("that keeps coming becomes a sentence a person can act on", async () => {
    let calls = 0;
    const response = await sendWithModelLimits(
      MERCURY,
      "{}",
      async () => {
        calls += 1;
        return limited();
      },
      noWait,
    );
    expect(calls).toBe(3);
    expect(response.status).toBe(429);
    expect(
      ((await response.json()) as { error: { message: string } }).error.message,
    ).toBe(RATE_LIMITED_SENTENCE);
  });

  test("waits as long as the provider asks, never longer than 20 seconds", () => {
    expect(waitFor(limited({ "retry-after": "3" }), 0)).toBe(3000);
    expect(waitFor(limited({ "retry-after": "600" }), 0)).toBe(20_000);
    expect(waitFor(limited(), 0)).toBe(2000);
    expect(waitFor(limited(), 1)).toBe(6000);
  });

  test("from a provider with no cap is passed through untouched", async () => {
    let calls = 0;
    const response = await sendWithModelLimits(
      "https://api.openai.com/v1/chat/completions",
      "{}",
      async () => {
        calls += 1;
        return limited();
      },
      noWait,
    );
    expect(calls).toBe(1);
    expect(await response.text()).toContain("output token limit exceeded");
  });
});

describe("the fetch wrapper", () => {
  test("caps what an SDK sends to Mercury and leaves everything else alone", async () => {
    const bodies: string[] = [];
    const inner = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response("ok");
    }) as typeof fetch;
    const wrapped = fetchWithModelLimits(inner);
    await wrapped(MERCURY, { method: "POST", body: '{"messages":[]}' });
    await wrapped("https://example.test/v1/chat/completions", {
      method: "POST",
      body: '{"messages":[]}',
    });
    expect(JSON.parse(bodies[0] ?? "{}").max_tokens).toBe(8192);
    expect(bodies[1]).toBe('{"messages":[]}');
  });
});
