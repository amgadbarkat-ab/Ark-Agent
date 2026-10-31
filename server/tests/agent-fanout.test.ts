import { describe, expect, test } from "bun:test";
import type { RunAssertion } from "../src/agents/callback-token";
import { fanOut } from "../src/agents/fanout";
import type { HandoffDesk } from "../src/agents/handoff";
import type { AuditStore } from "../src/audit";

const RUN: RunAssertion = {
  botId: "chief-of-operations",
  actorId: "user-1",
  runId: "run-1",
  threadId: "thread-1",
};

function fixture(refuse: readonly string[] = []) {
  const sent: Array<Parameters<HandoffDesk["send"]>[0]> = [];
  const desk: HandoffDesk = {
    async send(input) {
      sent.push(input);
      return refuse.includes(input.target)
        ? { ok: false, refusal: `no ${input.target}` }
        : { ok: true, to: input.target, toName: input.target };
    },
  };
  const rows: Array<Record<string, unknown>> = [];
  const auditStore = {
    insert: async (row: Record<string, unknown>) => {
      rows.push(row);
    },
  } as unknown as AuditStore;
  return { desk, sent, rows, auditStore };
}

describe("a message the person sent to several colleagues (desk #87)", () => {
  test("asks each of them, in order, with the person's own words and the fan-out mark", async () => {
    const { desk, sent, auditStore } = fixture();

    const outcome = await fanOut({
      desk,
      run: RUN,
      targets: ["marketing", "sales", "accounting"],
      task: "What do we need for the Athens fair?",
      auditStore,
    });

    expect(outcome.asked).toEqual(["marketing", "sales", "accounting"]);
    expect(sent.map((input) => input.target)).toEqual([
      "marketing",
      "sales",
      "accounting",
    ]);
    for (const input of sent) {
      expect(input.from).toBe(RUN);
      expect(input.envelope).toEqual({
        task: "What do we need for the Athens fair?",
        fanout: true,
      });
    }
  });

  test("drops repeats and the lead itself", async () => {
    const { desk, sent, auditStore } = fixture();

    await fanOut({
      desk,
      run: RUN,
      targets: ["sales", " sales ", "chief-of-operations", "", "marketing"],
      task: "hello",
      auditStore,
    });

    expect(sent.map((input) => input.target)).toEqual(["sales", "marketing"]);
  });

  test("says which were refused, and records one row naming ids and never the words", async () => {
    const { desk, rows, auditStore } = fixture(["legal"]);

    const outcome = await fanOut({
      desk,
      run: RUN,
      targets: ["sales", "legal"],
      task: "the secret launch date",
      auditStore,
    });

    expect(outcome).toEqual({
      asked: ["sales"],
      refused: [{ target: "legal", refusal: "no legal" }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventType: "team.fanout",
      targetId: "chief-of-operations",
      actorUserId: "user-1",
      payload: { asked: ["sales"], refused: ["legal"], run: "run-1" },
    });
    expect(JSON.stringify(rows[0])).not.toContain("secret launch");
  });
});
