import { describe, expect, test } from "bun:test";
import type { RunAssertion } from "../src/agents/callback-token";
import { teamTools, type TeamToolDependencies } from "../src/agents/team-tools";
import type { AgentProfile } from "../src/agents/profile-types";
import type { RoutineSummary } from "../src/routines/store";

const person = "owner-1";

const profile = (
  id: string,
  name: string,
  overrides: Partial<AgentProfile> = {},
): AgentProfile =>
  ({
    id,
    name,
    title: `${name} title`,
    roleDescription: `${name} does ${name}'s work.`,
    primary: false,
    ownerUserId: person,
    hidden: false,
    deletedAt: null,
    ...overrides,
  }) as AgentProfile;

const routine = (id: string, agentId: string, enabled = true): RoutineSummary =>
  ({
    id,
    agentId,
    instruction: "Send the weekly report",
    schedule: "Weekdays at 09:00",
    timezone: "Europe/Athens",
    enabled,
    nextRunAt: new Date("2026-10-19T06:00:00Z"),
    channelId: "c1",
    channelName: "general",
    channelDeleted: false,
    lastRun: {
      status: "failed",
      finishedAt: new Date("2026-10-17T06:00:00Z"),
    },
  }) as RoutineSummary;

function harness(
  options: {
    roster?: AgentProfile[];
    routines?: RoutineSummary[];
    withHandoff?: boolean;
    approvalFails?: string;
  } = {},
) {
  const roster = options.roster ?? [
    profile("ana", "Ana", { primary: true }),
    profile("ben", "Ben"),
    profile("cy", "Cy"),
  ];
  const calls: {
    toggled: unknown[];
    requested: unknown[];
    sent: unknown[];
    audit: unknown[];
  } = {
    toggled: [],
    requested: [],
    sent: [],
    audit: [],
  };
  const deps: TeamToolDependencies = {
    profiles: {
      list: async () => roster,
      get: async (_actor, id) => roster.find((p) => p.id === id) ?? null,
    },
    routines: {
      listFor: async () => options.routines ?? [routine("r1", "ben")],
      setEnabled: async (...args: unknown[]) => {
        calls.toggled.push(args);
      },
    },
    approvals: {
      request: async (input) => {
        if (options.approvalFails) throw new Error(options.approvalFails);
        calls.requested.push(input);
        return {} as never;
      },
    },
    ...(options.withHandoff === false
      ? {}
      : {
          handoff: {
            send: async (input: unknown) => {
              calls.sent.push(input);
              return { ok: true as const, to: "ben", toName: "Ben" };
            },
          },
        }),
    auditStore: {
      insert: async (event: unknown) => {
        calls.audit.push(event);
      },
    } as never,
  };
  const tools = (botId = "ana", actorId = person, run?: RunAssertion) =>
    teamTools({ deps, botId, actorId, run });
  const call = async (name: string, args: unknown, run?: RunAssertion) => {
    const found = (await tools("ana", person, run)).find(
      (t) => t.name === name,
    );
    if (!found) throw new Error(`no tool ${name}`);
    return found.execute(args);
  };
  return { tools, call, calls };
}

const run: RunAssertion = {
  botId: "ana",
  actorId: person,
  runId: "run-1",
  threadId: "thread-1",
  depth: 0,
};

describe("who is offered the team tools", () => {
  test("the lead, working for its own owner", async () => {
    const { tools } = harness();
    expect((await tools()).map((t) => t.name)).toEqual([
      "team_list",
      "team_report",
      "team_pause_routine",
      "team_request_change",
      "team_ask",
    ]);
  });

  test("not a colleague that does not lead", async () => {
    expect(await harness().tools("ben")).toEqual([]);
  });

  test("not the lead when somebody else is using it", async () => {
    expect(await harness().tools("ana", "someone-else")).toEqual([]);
  });
});

describe("looking at the team", () => {
  test("team_list names colleagues, not itself", async () => {
    const text = await harness().call("team_list", {});
    expect(text).toContain("Ben (Ben title), id: ben");
    expect(text).toContain("Cy");
    expect(text).not.toContain("Ana");
  });

  test("team_report says what a colleague does and how it went", async () => {
    const { call, calls } = harness();
    const text = await call("team_report", { colleague: "ben" });
    expect(text).toContain("Ben (Ben title) has 1 routine, 1 failing");
    expect(text).toContain("Weekdays at 09:00 (Europe/Athens)");
    expect(text).toContain("id: r1");
    expect(JSON.stringify(calls.audit)).toContain("report");
  });

  test("a colleague by name works, in any case; an unknown one is refused", async () => {
    const { call } = harness();
    expect(await call("team_report", { colleague: "BEN" })).toContain("Ben");
    expect(await call("team_report", { colleague: "Zed" })).toContain(
      'no colleague called "Zed"',
    );
  });

  test("two colleagues with one name are told apart by id, not guessed at", async () => {
    const { call } = harness({
      roster: [
        profile("ana", "Ana", { primary: true }),
        profile("ben-1", "Ben"),
        profile("ben-2", "Ben"),
      ],
    });
    const text = await call("team_report", { colleague: "Ben" });
    expect(text).toContain("ben-1, ben-2");
  });

  test("somebody else's employee is not a colleague even if it shares a name", async () => {
    const { call } = harness({
      roster: [
        profile("ana", "Ana", { primary: true }),
        profile("x", "Xavier", { ownerUserId: "someone-else" }),
      ],
    });
    expect(await call("team_report", { colleague: "Xavier" })).toContain(
      "no colleague",
    );
  });
});

describe("switching a routine", () => {
  test("off, for a colleague's routine, recorded", async () => {
    const { call, calls } = harness();
    const text = await call("team_pause_routine", {
      routineId: "r1",
      enabled: false,
    });
    expect(text).toContain("switched off");
    expect(calls.toggled).toEqual([[person, "r1", false]]);
    expect(JSON.stringify(calls.audit)).toContain("pause_routine");
  });

  test("not a routine of its own, and not one that does not exist", async () => {
    const { call, calls } = harness({
      routines: [routine("mine", "ana"), routine("r1", "ben")],
    });
    expect(
      await call("team_pause_routine", { routineId: "mine", enabled: false }),
    ).toContain("Refused.");
    expect(
      await call("team_pause_routine", { routineId: "nope", enabled: false }),
    ).toContain("Refused.");
    expect(calls.toggled).toEqual([]);
  });
});

describe("asking for a change", () => {
  test("deleting a routine becomes a request and changes nothing", async () => {
    const { call, calls } = harness();
    const text = await call("team_request_change", {
      kind: "delete_routine",
      routineId: "r1",
      reason: "It has failed for a week",
    });
    expect(text).toContain("Nothing has changed");
    expect(calls.toggled).toEqual([]);
    expect(calls.requested[0]).toMatchObject({
      ownerUserId: person,
      requestedByAgentId: "ana",
      kind: "routine.delete",
      targetAgentId: "ben",
      targetId: "r1",
      payload: { routineId: "r1" },
    });
    const summary = (calls.requested[0] as { summary: string }).summary;
    expect(summary).toContain("Delete Ben's routine");
    expect(summary).toContain("It has failed for a week");
  });

  test("a routine change carries only what was asked", async () => {
    const { call, calls } = harness();
    await call("team_request_change", {
      kind: "update_routine",
      routineId: "r1",
      cron: "0 10 * * 1-5",
      reason: "Ben is slow at nine",
    });
    expect(calls.requested[0]).toMatchObject({
      kind: "routine.update",
      payload: { routineId: "r1", patch: { cron: "0 10 * * 1-5" } },
    });
  });

  test("a routine change that changes nothing is refused before it is asked", async () => {
    const { call, calls } = harness();
    const text = await call("team_request_change", {
      kind: "update_routine",
      routineId: "r1",
      reason: "x",
    });
    expect(text).toContain("Refused.");
    expect(calls.requested).toEqual([]);
  });

  test("new instructions for a colleague are a request, with the text in full in the payload", async () => {
    const { call, calls } = harness();
    await call("team_request_change", {
      kind: "replace_instructions",
      colleague: "Cy",
      newInstructions: "Always answer in Greek.",
      reason: "Customers are Greek",
    });
    expect(calls.requested[0]).toMatchObject({
      kind: "instructions.update",
      targetAgentId: "cy",
      payload: { persona: "Always answer in Greek." },
    });
  });

  test("a refusal from the inbox reaches the model as a sentence", async () => {
    const { call } = harness({
      approvalFails: "You already have 10 requests waiting.",
    });
    const text = await call("team_request_change", {
      kind: "delete_routine",
      routineId: "r1",
      reason: "x",
    });
    expect(text).toBe("Refused. You already have 10 requests waiting.");
  });
});

describe("asking a colleague for work", () => {
  test("goes through the desk by id, as the signed run", async () => {
    const { call, calls } = harness();
    const text = await call(
      "team_ask",
      { colleague: "Ben", task: "Summarise last week", expecting: "A list" },
      run,
    );
    expect(text).toContain("Ben");
    expect(calls.sent).toEqual([
      {
        from: run,
        target: "ben",
        envelope: { task: "Summarise last week", expecting: "A list" },
      },
    ]);
  });

  test("without a run it says what it can do instead, and sends nothing", async () => {
    const { call, calls } = harness();
    const text = await call("team_ask", { colleague: "Ben", task: "x" });
    expect(text).toContain("Refused.");
    expect(calls.sent).toEqual([]);
  });

  test("where hand-offs are switched off it says so", async () => {
    const { call } = harness({ withHandoff: false });
    expect(
      await call("team_ask", { colleague: "Ben", task: "x" }, run),
    ).toContain("does not let digital employees ask each other");
  });
});
