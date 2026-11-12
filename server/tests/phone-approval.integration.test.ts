import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { ApprovalRecord, ApprovalStore } from "../src/approvals/store";
import { createDatabase } from "../src/db/client";
import { phoneApprovalSettings, users } from "../src/db/schema";
import { simulatedPhoneProvider } from "../src/phone/provider";
import { createPhoneApprovals, PhoneSettingsError } from "../src/phone/service";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const userId = `phone-${randomUUID()}`;

afterAll(async () => {
  await database.delete(users).where(eq(users.id, userId));
  await database.$client.close();
});

function harness(records: ApprovalRecord[]) {
  const decided: [string, string][] = [];
  const events: { eventType: string; payload: Record<string, unknown> }[] = [];
  const approvals = {
    get: async (owner: string, id: string) =>
      records.find((r) => r.id === id && r.ownerUserId === owner) ?? null,
    decide: async (
      _owner: string,
      id: string,
      decision: "approve" | "reject",
    ) => {
      decided.push([id, decision]);
      return records[0] as ApprovalRecord;
    },
  } as unknown as ApprovalStore;
  const provider = simulatedPhoneProvider();
  const phone = createPhoneApprovals({
    database,
    approvals,
    audit: { insert: async (event) => void events.push(event) },
    provider,
  });
  return { phone, decided, events, provider };
}

function pending(over: Partial<ApprovalRecord>): ApprovalRecord {
  return {
    id: `approval-${randomUUID()}`,
    ownerUserId: userId,
    requestedByAgentId: "order-desk",
    requestedByName: "Order Desk",
    kind: "tool.call",
    targetAgentId: null,
    targetAgentName: null,
    targetId: null,
    summary: "Call send_message on Gmail, which changes something there.",
    payload: { server: "google-gmail", tool: "send_message", args: {} },
    status: "pending",
    result: null,
    createdAt: new Date(),
    expiresAt: new Date(),
    decidedAt: null,
    decidedBy: null,
    threadId: null,
    runId: null,
    channelId: null,
    ...over,
  };
}

describe("approving by phone, end to end on the simulated provider (P2 idea 10)", () => {
  test("off until the person sets a number, a PIN and the employees that may call", async () => {
    await database
      .insert(users)
      .values({ id: userId, email: `${userId}@example.test`, name: "Phone" });
    const ask = pending({});
    const { phone, provider } = harness([ask]);
    expect(await phone.callAbout(userId, ask.id)).toEqual({
      refused: "no-settings",
    });
    await expect(
      phone.saveSettings(userId, {
        phone: "6912345678",
        pin: "2468",
        agentIds: [],
      }),
    ).rejects.toBeInstanceOf(PhoneSettingsError);
    await phone.saveSettings(userId, {
      phone: "+30 691 234 5678",
      pin: "2468",
      agentIds: [],
    });
    expect(await phone.callAbout(userId, ask.id)).toEqual({
      refused: "off-for-employee",
    });
    expect(provider.placed).toHaveLength(0);

    const [row] = await database
      .select()
      .from(phoneApprovalSettings)
      .where(eq(phoneApprovalSettings.userId, userId));
    expect(row?.pinHash).not.toContain("2468");
  });

  test("rings, asks for the PIN, reads the request, and 1 approves it as the owner would", async () => {
    const ask = pending({});
    const { phone, decided, events, provider } = harness([ask]);
    await phone.saveSettings(userId, {
      phone: "+306912345678",
      agentIds: ["order-desk"],
    });
    const placed = await phone.callAbout(userId, ask.id);
    if (!("call" in placed)) throw new Error("expected a call");
    expect(provider.placed[0]?.to).toBe("+306912345678");

    const id = placed.call.id;
    expect((await phone.answer(userId, id))?.said).toContain("Enter your PIN");
    expect((await phone.press(userId, id, "1111#"))?.said).toContain(
      "not right",
    );
    expect((await phone.press(userId, id, "2468#"))?.said).toContain(
      "send_message on Gmail",
    );
    const done = await phone.press(userId, id, "1");
    expect(done?.state).toEqual({ step: "ended", outcome: "approved" });
    expect(decided).toEqual([[ask.id, "approve"]]);
    expect(events.map((event) => event.eventType)).toEqual([
      "phone.settings_changed",
      "phone.call_placed",
      "phone.call_answered",
      "phone.call_ended",
    ]);
    expect(events.at(-1)?.payload.outcome).toBe("approved");
    expect(await phone.active(userId)).toEqual([]);
  });

  test("device control never rings, whatever the settings say", async () => {
    const ask = pending({ kind: "computer.action" });
    const { phone, provider } = harness([ask]);
    expect(await phone.callAbout(userId, ask.id)).toEqual({
      refused: "device-control",
    });
    expect(provider.placed).toHaveLength(0);
  });

  test("hanging up decides nothing", async () => {
    const ask = pending({});
    const { phone, decided } = harness([ask]);
    const placed = await phone.callAbout(userId, ask.id);
    if (!("call" in placed)) throw new Error("expected a call");
    await phone.answer(userId, placed.call.id);
    await phone.hangUp(userId, placed.call.id);
    expect(decided).toEqual([]);
    expect(await phone.active(userId)).toEqual([]);
  });
});
