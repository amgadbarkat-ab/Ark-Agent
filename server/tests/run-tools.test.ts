/**
 * What a run is handed for reaching past itself, built for that run.
 *
 * The DT Lab (v0.1.14) hired a lead and a colleague and asked the lead to have its colleague list some
 * risks. Its team_ask was refused every time: the team tools were built per request, before there was a
 * run to ask as, and the per-run tools did not include them.
 */
import { describe, expect, test } from "bun:test";
import type { RunAgentInput } from "@ag-ui/client";
import { HANDED_OVER } from "../../shared/handoff-markers";
import type { AgentProfile } from "../src/agents/profile-types";
import { createRunTools } from "../src/agents/run-tools";

const person = "owner-1";

const profile = (id: string, name: string, primary = false): AgentProfile =>
  ({
    id,
    name,
    title: `${name} title`,
    roleDescription: `${name} does ${name}'s work.`,
    primary,
    ownerUserId: person,
    hidden: false,
    deletedAt: null,
  }) as AgentProfile;

function harness() {
  const roster = [
    profile("lead", "Chief of Operations", true),
    profile("analyst", "Research Analyst"),
  ];
  const sent: unknown[] = [];
  const desk = {
    send: async (input: unknown) => {
      sent.push(input);
      return { ok: true as const, to: "analyst", toName: "Research Analyst" };
    },
  };
  const forRun = createRunTools({
    keyEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
    handoff: { maxDepth: 5, maxPerRun: 5 },
    desk: desk as never,
    botsReachableFrom: async () => [],
    team: {
      profiles: {
        list: async () => roster,
        get: async (_actor, id) => roster.find((p) => p.id === id) ?? null,
      },
      routines: { listFor: async () => [], setEnabled: async () => {} },
      approvals: { request: async () => ({}) as never },
      memories: { list: async () => [] },
      handoff: desk as never,
    },
  });
  return { forRun, sent };
}

const input = {
  threadId: "thread-of-the-person",
  runId: "run-1",
  messages: [],
  tools: [],
  context: [],
  state: {},
  forwardedProps: {},
} as unknown as RunAgentInput;

describe("the tools built for a run", () => {
  test("give the lead a team_ask that asks its colleague as this run", async () => {
    const { forRun, sent } = harness();
    const tools = await forRun(person)("lead", input);
    const ask = tools.find((tool) => tool.name === "team_ask");
    expect(ask).toBeDefined();
    const said = await ask?.execute({
      colleague: "Research Analyst",
      task: "List three risks of an unreceipted client dinner.",
    });
    expect(String(said).startsWith(HANDED_OVER)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      from: { botId: "lead", threadId: "thread-of-the-person", depth: 0 },
      target: "analyst",
    });
  });

  test("still give every run the way to ask its person", async () => {
    const { forRun } = harness();
    const names = (await forRun(person)("lead", input)).map((t) => t.name);
    expect(names).toContain("ask_person");
  });

  test("give somebody else's employee no team tools", async () => {
    const { forRun } = harness();
    const names = (await forRun("someone-else")("lead", input)).map(
      (t) => t.name,
    );
    expect(names.filter((name) => name.startsWith("team_"))).toEqual([]);
  });
});
