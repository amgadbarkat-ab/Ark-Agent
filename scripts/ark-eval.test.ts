/**
 * `ark-eval run` and `tune` (#116) against a stand-in for the model endpoint on this computer. No
 * network, no real key: the stand-in answers by markers in the instruction text, judges by looking
 * for one phrase, and records every request so the tests can see what was sent.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProfile } from "../shared/trial";
import { type Deps, main } from "./ark-eval";
import {
  assertAllowedEndpoint,
  assertAllowedModel,
  makeClient,
  PROVIDERS,
  redact,
} from "./eval/model";
import { aiWordIn, checkRules, pricesIn } from "./eval/rules";

const KEY = "gsk_test_ONLY_not_a_real_key_7f3a9c";
const GOOD = "Παρακαλώ πείτε μου τον αριθμό παραγγελίας σας.";
const BAD = "Η παραγγελία σας θα έρθει αύριο.";

type Seen = { authorization: string | null; body: string };
const seen: Seen[] = [];
let proposerReply = "MODE:GOOD (proposed)";
let refuseWith401 = false;
let server: ReturnType<typeof Bun.serve>;

function reply(message: Record<string, unknown>) {
  return Response.json({ choices: [{ message }] });
}

function answerFor(instruction: string, ask: string, afterTool: boolean) {
  if (instruction.includes("MODE:SEND") && !afterTool) {
    return reply({
      content: null,
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: {
            name: "send_message",
            arguments: JSON.stringify({
              to: "a@example.com",
              subject: "x",
              body: "y",
            }),
          },
        },
      ],
    });
  }
  if (instruction.includes("MODE:GOOD") || instruction.includes("MODE:SEND")) {
    return reply({ content: GOOD });
  }
  if (instruction.includes("MODE:LEAK")) {
    // Fixes the two cases that failed and leaks a number in them: the same score, a new rule failure.
    return reply({
      content: ask.includes("(easy)") ? GOOD : `${GOOD} ΑΜΚΑ 12345678901.`,
    });
  }
  if (instruction.includes("MODE:BASE") && ask.includes("(easy)")) {
    return reply({ content: GOOD });
  }
  return reply({ content: BAD });
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const body = await request.text();
      seen.push({ authorization: request.headers.get("authorization"), body });
      if (refuseWith401) {
        return new Response(`{"error":"invalid api key ${KEY}"}`, {
          status: 401,
        });
      }
      const { messages } = JSON.parse(body) as {
        messages: { role: string; content: string | null }[];
      };
      const system = messages[0]?.content ?? "";
      if (system.startsWith("You grade")) {
        const { answer, checklist } = JSON.parse(
          messages[1]?.content ?? "{}",
        ) as {
          answer: string;
          checklist: { id: string }[];
        };
        return reply({
          content: JSON.stringify({
            verdicts: checklist.map(({ id }) => ({
              id,
              ok: id.startsWith("M")
                ? answer.includes("αριθμό παραγγελίας")
                : !answer.includes("αύριο"),
              why: "stand-in judge",
            })),
          }),
        });
      }
      if (system.startsWith("You improve")) {
        return reply({
          content: JSON.stringify({
            instructions: proposerReply,
            summary: "Ask for the order number every time.",
          }),
        });
      }
      const ask = messages[1]?.content ?? "";
      return answerFor(
        system,
        ask,
        messages.some((m) => m.role === "tool"),
      );
    },
  });
});

afterAll(() => server.stop(true));

let dir: string;
let output: string[];

beforeEach(() => {
  seen.length = 0;
  proposerReply = "MODE:GOOD (proposed)";
  refuseWith401 = false;
  output = [];
  dir = mkdtempSync(join(tmpdir(), "ark-eval-"));
});

const testCase = (
  id: string,
  ask: string,
  rules?: Record<string, unknown>,
) => ({
  id,
  ask,
  must: ["asks for the order number"],
  mustNot: ["promises a delivery date"],
  ...(rules ? { rules } : {}),
});

function writeProfile(instructions = "MODE:BASE Ask what you need.") {
  const profile = {
    v: 1,
    customer: { id: "demo-shop", name: "Demo Shop" },
    issuedAt: "2026-11-15T10:00:00Z",
    startsAt: "2026-11-16T00:00:00+02:00",
    endsAt: "2026-12-16T00:00:00+02:00",
    plan: "team",
    createBlocked: true,
    mailBlockAmka: true,
    roster: [
      {
        key: "orders",
        name: "Orders",
        title: "Orders",
        roleDescription: "Answers order questions.",
        instructions,
        mail: {},
        tests: [
          testCase("easy-one", "Πού είναι η παραγγελία μου; (easy)", {
            toolsNever: ["send_message"],
          }),
          testCase("easy-two", "Πότε έρχεται το δέμα; (easy)"),
          testCase("hard-one", "Η παραγγελία άργησε."),
          testCase("hard-two", "Έχετε νέα για την αποστολή;"),
          testCase("hard-three", "Πότε θα την παραλάβω;"),
        ],
      },
    ],
  };
  const path = join(dir, "demo-shop.json");
  writeFileSync(path, JSON.stringify(profile));
  return path;
}

function writeChange(instructions: string) {
  const path = join(dir, "change.json");
  writeFileSync(
    path,
    JSON.stringify({
      format: "arkchange/1",
      customer: "demo-shop",
      employee: "orders",
      instructions,
    }),
  );
  return path;
}

function deps(extra: Partial<Deps> = {}): Deps {
  return {
    env: { ARK_EVAL_API_KEY: KEY },
    cwd: dir,
    out: (text) => output.push(text),
    err: (text) => output.push(text),
    endpoint: {
      baseUrl: `http://127.0.0.1:${server.port}`,
      label: "the test stand-in",
    },
    sleep: async () => {},
    now: () => new Date("2026-11-20T09:00:00Z"),
    ...extra,
  };
}

function filesIn(folder: string) {
  return readdirSync(folder).sort();
}

function report(): string {
  const name = filesIn(dir).find((file) => file.endsWith(".md"));
  if (!name) throw new Error("no report written");
  return readFileSync(join(dir, name), "utf8");
}

function draft(): Record<string, unknown> & { notes: string[] } {
  const name = filesIn(dir).find((file) => file.includes("-draft-"));
  if (!name) throw new Error("no draft written");
  return JSON.parse(readFileSync(join(dir, name), "utf8"));
}

describe("ark-eval run", () => {
  test("without a proposal it scores the current instruction and writes the report", async () => {
    const profile = writeProfile();
    const code = await main(["run", "--profile", profile], deps());
    expect(code).toBe(0);
    const text = report();
    expect(text).toContain("**Score:** 2/5 (40%)");
    expect(text).toContain("| `easy-one` | pass |");
    expect(text).toContain("did not: asks for the order number");
    expect(output.join("")).toContain(text.trim());
    expect(filesIn(dir).some((file) => file.includes("-draft-"))).toBe(false);
    // Every request was the key in the header and nothing else of it.
    expect(seen.length).toBeGreaterThan(0);
    for (const request of seen) {
      expect(request.authorization).toBe(`Bearer ${KEY}`);
      expect(request.body).not.toContain(KEY);
    }
  });

  test("a better proposal passes and becomes an unsigned draft with a note", async () => {
    const profile = writeProfile();
    const before = readFileSync(profile, "utf8");
    const change = writeChange("MODE:GOOD Always ask for the order number.");
    const code = await main(
      ["run", "--profile", profile, "--proposed", change],
      deps(),
    );
    expect(code).toBe(0);
    const text = report();
    expect(text).toContain("**Before:** 2/5 (40%) · **After:** 5/5 (100%)");
    expect(text).toContain("**Passed.**");
    expect(text).toContain("+ MODE:GOOD Always ask for the order number.");
    const written = draft();
    expect(written.issuedAt).toBeUndefined();
    expect(written.notes).toHaveLength(1);
    expect(written.notes[0]).toContain("2/5 (40%) before and 5/5 (100%) after");
    const signed = readProfile({
      ...written,
      issuedAt: "2026-11-20T09:00:00Z",
    });
    expect(signed.roster[0]?.instructions).toBe(
      "MODE:GOOD Always ask for the order number.",
    );
    expect(readFileSync(profile, "utf8")).toBe(before);
  });

  test("a worse proposal is blocked: exit 2 and no draft", async () => {
    const profile = writeProfile();
    const change = writeChange("MODE:BAD Promise tomorrow.");
    const code = await main(
      ["run", "--profile", profile, "--proposed", change],
      deps(),
    );
    expect(code).toBe(2);
    const text = report();
    expect(text).toContain("**BLOCKED.**");
    expect(text).toContain("it scores lower: 2/5 (40%) before, 0/5 (0%) after");
    expect(filesIn(dir).some((file) => file.includes("-draft-"))).toBe(false);
  });

  test("a written reason lets a blocked change on and is recorded in the notes", async () => {
    const profile = writeProfile();
    const change = writeChange("MODE:BAD Promise tomorrow.");
    const reason =
      "The customer asked for this wording; DT spot-checks it on Monday.";
    const code = await main(
      ["run", "--profile", profile, "--proposed", change, "--reason", reason],
      deps(),
    );
    expect(code).toBe(0);
    const text = report();
    expect(text).toContain("**Overridden with a written reason.**");
    expect(text).toContain(`Reason given: "${reason}"`);
    const notes = draft().notes;
    expect(notes[0]).toContain(`sent on with the written reason: ${reason}`);
  });

  test("a proposal that adds a rule failure is blocked even when the score holds", async () => {
    const profile = writeProfile();
    const change = writeChange("MODE:LEAK Ask for the order number.");
    const code = await main(
      ["run", "--profile", profile, "--proposed", change],
      deps(),
    );
    expect(code).toBe(2);
    const text = report();
    expect(text).toContain("**BLOCKED.**");
    expect(text).toContain("**Before:** 2/5 (40%) · **After:** 2/5 (40%)");
    expect(text).toContain(
      "it adds a rule failure on `hard-one`: amka, wrote an AMKA-shaped (11-digit) number",
    );
    expect(text).not.toContain("it scores lower");
    expect(filesIn(dir).some((file) => file.includes("-draft-"))).toBe(false);
  });

  test("a forbidden tool call fails the case by rule", async () => {
    const profile = writeProfile("MODE:SEND Send it straight away.");
    expect(await main(["run", "--profile", profile], deps())).toBe(0);
    const text = report();
    expect(text).toContain(
      "rule tools: called send_message, which it must never call here",
    );
    expect(text).toContain("**Score:** 4/5 (80%)");
  });

  test("the key never appears in the output, the report or the draft", async () => {
    const profile = writeProfile();
    const change = writeChange("MODE:BAD Promise tomorrow.");
    await main(
      [
        "run",
        "--profile",
        profile,
        "--proposed",
        change,
        "--reason",
        "Testing.",
      ],
      deps(),
    );
    const everything = [
      output.join(""),
      ...filesIn(dir).map((file) => readFileSync(join(dir, file), "utf8")),
    ].join("\n");
    expect(everything).toContain("Testing.");
    expect(everything).not.toContain(KEY);
  });

  test("an endpoint that echoes the key back in an error does not get it printed", async () => {
    refuseWith401 = true;
    const profile = writeProfile();
    expect(await main(["run", "--profile", profile], deps())).toBe(1);
    const printed = output.join("");
    expect(printed).toContain("401 (the key was refused)");
    expect(printed).toContain("[key hidden]");
    expect(printed).not.toContain(KEY);
  });

  test("a typed key is hidden the same way", async () => {
    refuseWith401 = true;
    const profile = writeProfile();
    const code = await main(
      ["run", "--profile", profile],
      deps({ env: {}, readKey: async () => KEY }),
    );
    expect(code).toBe(1);
    expect(output.join("")).not.toContain(KEY);
  });

  test("the key is refused on the command line and nothing is sent", async () => {
    const profile = writeProfile();
    const code = await main(
      ["run", "--profile", profile, "--api-key", KEY],
      deps(),
    );
    expect(code).toBe(1);
    expect(output.join("")).toContain("never taken from the command line");
    expect(seen).toHaveLength(0);
  });

  test("--reason without a proposal is refused", async () => {
    const profile = writeProfile();
    expect(
      await main(["run", "--profile", profile, "--reason", "x"], deps()),
    ).toBe(1);
    expect(seen).toHaveLength(0);
  });
});

describe("ark-eval tune", () => {
  function asker(answers: string[]) {
    const asked: string[] = [];
    return {
      asked,
      ask: async (question: string) => {
        asked.push(question);
        return answers.shift() ?? "n";
      },
    };
  }

  test("says it needs Amgad's yes, and stops without it before anything is sent", async () => {
    const profile = writeProfile();
    const { ask } = asker(["n"]);
    const code = await main(
      ["tune", "--profile", profile, "--employee", "orders", "--rounds", "1"],
      deps({ ask }),
    );
    expect(code).toBe(1);
    expect(output.join("")).toContain(
      "USING IT NEEDS AMGAD'S YES FOR THE PROPOSER",
    );
    expect(seen).toHaveLength(0);
    expect(filesIn(dir)).toEqual(["demo-shop.json"]);
  });

  test("never writes a proposal the person did not approve", async () => {
    const profile = writeProfile();
    const { ask, asked } = asker(["y", "n"]);
    const code = await main(
      ["tune", "--profile", profile, "--employee", "orders", "--rounds", "1"],
      deps({ ask }),
    );
    expect(code).toBe(0);
    expect(asked).toHaveLength(2);
    expect(asked[1]).toContain("Write this proposal to");
    expect(output.join("")).toContain("2/5 (40%) → 5/5 (100%)");
    expect(output.join("")).toContain("Not written.");
    expect(filesIn(dir)).toEqual(["demo-shop.json"]);
  });

  test("writes an approved proposal as a change file, and never touches the profile", async () => {
    const profile = writeProfile();
    const before = readFileSync(profile, "utf8");
    const { ask } = asker(["y", "y"]);
    const code = await main(
      ["tune", "--profile", profile, "--employee", "orders", "--rounds", "2"],
      deps({ ask }),
    );
    expect(code).toBe(0);
    const proposals = filesIn(dir).filter((file) =>
      file.includes("-proposal-"),
    );
    expect(proposals).toHaveLength(1);
    const change = JSON.parse(readFileSync(join(dir, proposals[0]!), "utf8"));
    expect(change).toMatchObject({
      format: "arkchange/1",
      customer: "demo-shop",
      employee: "orders",
      instructions: "MODE:GOOD (proposed)",
      source: "tune",
    });
    expect(output.join("")).toContain("Every case passes");
    expect(readFileSync(profile, "utf8")).toBe(before);
    expect(output.join("")).not.toContain(KEY);
  });

  test("a proposal that does not beat the current one is never offered", async () => {
    proposerReply = "MODE:BAD (proposed)";
    const profile = writeProfile();
    const { ask, asked } = asker(["y", "y"]);
    await main(
      ["tune", "--profile", profile, "--employee", "orders", "--rounds", "1"],
      deps({ ask }),
    );
    expect(asked).toHaveLength(1);
    expect(output.join("")).toContain("not better, discarded");
    expect(filesIn(dir)).toEqual(["demo-shop.json"]);
  });

  test("without a terminal to ask a person, tune refuses", async () => {
    const profile = writeProfile();
    const code = await main(
      ["tune", "--profile", profile, "--employee", "orders"],
      deps(),
    );
    expect(code).toBe(1);
    expect(output.join("")).toContain("runs only in a terminal");
    expect(seen).toHaveLength(0);
  });
});

describe("the endpoint", () => {
  test("refuses Anthropic, DeepSeek and an Anthropic key", () => {
    expect(() =>
      assertAllowedEndpoint("https://api.anthropic.com/v1", "x"),
    ).toThrow("never uses Anthropic");
    expect(() =>
      assertAllowedEndpoint("https://api.deepseek.com/v1", "x"),
    ).toThrow("DeepSeek");
    expect(() =>
      makeClient({
        baseUrl: "https://api.groq.com/openai/v1",
        apiKey: "sk-ant-api03-something",
        label: "Groq",
      }),
    ).toThrow("Anthropic key");
  });

  test("OpenRouter is the default, and its Anthropic and DeepSeek models are refused", () => {
    expect(PROVIDERS.openrouter.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(PROVIDERS.openrouter.defaultModel).toEndWith(":free");
    expect(() =>
      assertAllowedModel(PROVIDERS.openrouter.defaultModel),
    ).not.toThrow();
    for (const model of [
      "anthropic/claude-3.5-sonnet",
      "Anthropic/Claude-Haiku",
      "deepseek/deepseek-chat-v3:free",
      "tngtech/deepseek-r1t-chimera:free",
    ]) {
      expect(() => assertAllowedModel(model)).toThrow("never");
    }
  });

  test("redact hides every copy of the key", () => {
    expect(redact(`a ${KEY} b ${KEY}`, KEY)).toBe(
      "a [key hidden] b [key hidden]",
    );
  });

  test("a busy endpoint is retried after the time it asks for", async () => {
    const waits: number[] = [];
    let calls = 0;
    const client = makeClient({
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: KEY,
      label: "Groq",
      sleep: async (ms) => {
        waits.push(ms);
      },
      fetch: async () => {
        calls++;
        return calls === 1
          ? new Response("busy", {
              status: 429,
              headers: { "retry-after": "2" },
            })
          : Response.json({ choices: [{ message: { content: "ok" } }] });
      },
    });
    expect((await client.chat({ model: "m", messages: [] })).content).toBe(
      "ok",
    );
    expect(waits).toEqual([2000]);
  });
});

describe("rule checks", () => {
  test("reads prices written the Greek and the English way", () => {
    expect(pricesIn("Κοστίζει 15,90 € ή €1.200,50, και 9.90 EUR.")).toEqual([
      1590, 990, 120050,
    ]);
    expect(
      pricesIn("Τηλέφωνο 2101234567, ώρες 08:00-12:00, 1,5 λίτρο"),
    ).toEqual([]);
  });

  test("a price not in the list fails, and so does any price where none may be given", () => {
    const run = (prices: string[], answer: string) =>
      checkRules({
        rules: { prices },
        amkaAlways: false,
        answer,
        toolUses: [],
      });
    expect(run(["6,40 €"], "Η τιμή είναι 6,40 €.")).toEqual([]);
    expect(run(["6,40 €"], "Η τιμή είναι 6,10 €.")[0]?.detail).toBe(
      "gave 6,10 €, which is not in the price list",
    );
    expect(run([], "Περίπου 5 ευρώ.")[0]?.rule).toBe("prices");
  });

  test("finds AI and bot words in Greek and English, not inside other words", () => {
    expect(aiWordIn("Είμαι ένα chatbot.")).toBe("chatbot");
    expect(aiWordIn("I am an AI assistant.")).toBe("AI");
    expect(aiWordIn("Είμαι τεχνητή νοημοσύνη.")).toBe("τεχνητή νοημοσύνη");
    expect(aiWordIn("Δεν είμαι ρομπότ.")).toBe("ρομπότ");
    expect(
      aiWordIn("Είμαι ο ψηφιακός υπάλληλος της υποδοχής. Said robots.txt"),
    ).toBe(undefined);
    expect(aiWordIn("Η αιμοληψία γίνεται στο AIRPORT office")).toBe(undefined);
  });

  test("checks what was written through tools too", () => {
    const failures = checkRules({
      rules: { noAmka: true, toolsShould: ["save_draft"] },
      amkaAlways: false,
      answer: "Έτοιμο.",
      toolUses: [
        {
          name: "send_message",
          arguments: JSON.stringify({ body: "ΑΜΚΑ 12345678901" }),
        },
      ],
    });
    expect(failures.map((failure) => failure.rule)).toEqual(["amka", "tools"]);
    expect(JSON.stringify(failures)).not.toContain("12345678901");
  });
});
