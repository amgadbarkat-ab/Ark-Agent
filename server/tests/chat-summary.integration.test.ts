import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  CHUNK_CHARACTERS,
  createChatSummaryService,
  DEACTIVATE_WARNING,
  inCleanupWindow,
  type SummaryModel,
  summaryGuidance,
  transcriptChunks,
} from "../src/chat-summary/service";
import { createDatabase } from "../src/db/client";
import {
  agentChatSummaries,
  agents,
  channelAgents,
  channelMemberships,
  channels,
  chatSummaryEpoch,
  intelligenceChannelMappings,
  users,
} from "../src/db/schema";
import type { ConversationService } from "../src/privacy/conversations";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const made = { users: [] as string[], agents: [] as string[] };
afterAll(async () => {
  if (made.users.length)
    await database.delete(users).where(inArray(users.id, made.users));
  if (made.agents.length)
    await database.delete(agents).where(inArray(agents.id, made.agents));
  await database.$client.close();
});

// Sunday 29 Nov 2026, 03:00 Athens (01:00 UTC): inside the window.
const SUNDAY_NIGHT = Date.parse("2026-11-29T01:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

/** The conversation service, in memory: every thread's messages, and every delete it was asked. */
function conversationService(threads: Record<string, unknown[]>) {
  const removed: string[] = [];
  let failOn: string | null = null;
  const service: ConversationService = {
    threads: async () => [],
    messages: async (threadId) => threads[threadId] ?? [],
    remove: async (threadId) => {
      if (threadId === failOn)
        throw new Error("the conversation service is down");
      removed.push(threadId);
      delete threads[threadId];
    },
  };
  return {
    service,
    removed,
    failOn: (id: string | null) => {
      failOn = id;
    },
  };
}

const said = (role: "user" | "assistant", content: string) => ({
  id: randomUUID(),
  role,
  content,
});

async function person() {
  const id = `user-${randomUUID()}`;
  await database
    .insert(users)
    .values({ id, email: `${id}@example.test`, name: "Maria" });
  made.users.push(id);
  return id;
}

async function employee(createdAt?: Date) {
  const id = `agent-${randomUUID()}`;
  await database.insert(agents).values({
    id,
    name: "Front Desk",
    type: "built_in",
    configuration: {},
    ...(createdAt ? { createdAt } : {}),
  });
  made.agents.push(id);
  return id;
}

/** A conversation of `userId` with these employees, mapped to a thread, last active `lastAt`. */
async function conversation(
  userId: string,
  agentIds: string[],
  lastAt: Date,
): Promise<{ channelId: string; threadId: string }> {
  const channelId = `ch-${randomUUID()}`;
  const threadId = randomUUID();
  await database.insert(channels).values({
    id: channelId,
    name: "Chat",
    description: "",
    lastMessageAt: lastAt,
  });
  await database.insert(channelMemberships).values({ channelId, userId });
  for (const agentId of agentIds)
    await database.insert(channelAgents).values({ channelId, agentId });
  await database
    .insert(intelligenceChannelMappings)
    .values({ userId, channelId, threadId });
  return { channelId, threadId };
}

async function deleted(channelId: string) {
  const [row] = await database
    .select({ deletedAt: channels.deletedAt })
    .from(channels)
    .where(eq(channels.id, channelId));
  return row?.deletedAt !== null;
}

function model(answers: Array<string | null>) {
  const asked: string[] = [];
  const ask: SummaryModel = async (_userId, _instruction, text) => {
    asked.push(text);
    return answers.length ? (answers.shift() as string | null) : null;
  };
  return { ask, asked };
}

const SUMMARY =
  "Facts: Maria runs Demo Shop.\nOpen tasks: send the 2027 price list by 4 Dec.";

let clock = SUNDAY_NIGHT;
beforeEach(() => {
  clock = SUNDAY_NIGHT;
});

describe("weekly summary, then chat cleanup", () => {
  test("on by default for a new employee, off for one made before the feature; the warning is Amgad's words", async () => {
    const userId = await person();
    const fresh = await employee();
    const [epoch] = await database.select().from(chatSummaryEpoch);
    const old = await employee(
      new Date((epoch?.startedAt.getTime() ?? Date.now()) - DAY),
    );
    const service = createChatSummaryService({
      database,
      conversations: conversationService({}).service,
      model: model([]).ask,
      now: () => clock,
    });
    expect(await service.view(userId, fresh)).toMatchObject({
      enabled: true,
      isDefault: true,
      summary: "",
      warning:
        "deactivating this function will affect the usage of your LLM model.",
    });
    expect((await service.view(userId, old)).enabled).toBe(false);
    await service.setEnabled(userId, fresh, false);
    expect(await service.view(userId, fresh)).toMatchObject({
      enabled: false,
      isDefault: false,
    });
    expect(DEACTIVATE_WARNING).toBe(
      "deactivating this function will affect the usage of your LLM model.",
    );
  });

  test("the summary is made and SAVED first, then only this employee's one-to-one, quiet conversations are deleted", async () => {
    const userId = await person();
    const agentId = await employee();
    const colleague = await employee();
    const quiet = await conversation(
      userId,
      [agentId],
      new Date(clock - 2 * DAY),
    );
    const group = await conversation(
      userId,
      [agentId, colleague],
      new Date(clock - 2 * DAY),
    );
    const live = await conversation(
      userId,
      [agentId],
      new Date(clock - 10 * 60_000),
    );
    const hub = conversationService({
      [quiet.threadId]: [
        said("user", "Send me the 2027 price list by 4 December."),
        { id: "t", role: "tool", content: "{ huge tool output }" },
        said("assistant", "I will send it by 4 December."),
      ],
      [group.threadId]: [said("user", "Group talk")],
      [live.threadId]: [said("user", "Still talking")],
    });
    const m = model([SUMMARY]);
    const service = createChatSummaryService({
      database,
      conversations: hub.service,
      model: m.ask,
      now: () => clock,
    });
    expect(await service.cleanupOne(userId, agentId)).toBe("done");
    // The model saw what was said, not the tool output, and an empty summary so far.
    expect(m.asked).toHaveLength(1);
    expect(m.asked[0]).toContain("Summary so far:\n(empty)");
    expect(m.asked[0]).toContain(
      "Person: Send me the 2027 price list by 4 December.",
    );
    expect(m.asked[0]).toContain("Employee: I will send it by 4 December.");
    expect(m.asked[0]).not.toContain("huge tool output");
    expect(m.asked[0]).not.toContain("Group talk");
    expect(m.asked[0]).not.toContain("Still talking");

    const view = await service.view(userId, agentId);
    expect(view.summary).toBe(SUMMARY);
    expect(view.summaryTokens).toBe(Math.ceil(SUMMARY.length / 4));
    expect(view.lastError).toBeNull();
    expect(hub.removed).toEqual([quiet.threadId]);
    expect(await deleted(quiet.channelId)).toBe(true);
    expect(await deleted(group.channelId)).toBe(false);
    expect(await deleted(live.channelId)).toBe(false);

    // The employee starts every request from it.
    expect(
      (await service.forRun(userId, [agentId, colleague])).get(agentId),
    ).toBe(SUMMARY);
    expect(summaryGuidance(SUMMARY)).toContain(SUMMARY);
    expect(summaryGuidance(SUMMARY)).toStartWith(
      "Summary of your earlier conversations with this person.",
    );
  });

  test("if the summary cannot be made, NOTHING is deleted, and the error is kept for the next run", async () => {
    const userId = await person();
    const agentId = await employee();
    const one = await conversation(
      userId,
      [agentId],
      new Date(clock - 2 * DAY),
    );
    const hub = conversationService({
      [one.threadId]: [said("user", "Remember my VAT number is EL123.")],
    });
    for (const answer of [null, "ok"]) {
      const service = createChatSummaryService({
        database,
        conversations: hub.service,
        model: model([answer]).ask,
        now: () => clock,
      });
      expect(await service.cleanupOne(userId, agentId)).toBe("failed");
      expect(hub.removed).toEqual([]);
      expect(await deleted(one.channelId)).toBe(false);
      const view = await service.view(userId, agentId);
      expect(view.summary).toBe("");
      expect(view.lastError).toBe("The model did not write a summary.");
    }
  });

  test("a delete that fails half way is finished on the next run, and those conversations are never summarised twice", async () => {
    const userId = await person();
    const agentId = await employee();
    const a = await conversation(userId, [agentId], new Date(clock - 3 * DAY));
    const b = await conversation(userId, [agentId], new Date(clock - 2 * DAY));
    const hub = conversationService({
      [a.threadId]: [said("user", "First chat")],
      [b.threadId]: [said("user", "Second chat")],
    });
    hub.failOn(b.threadId);
    const first = model([SUMMARY]);
    const service = createChatSummaryService({
      database,
      conversations: hub.service,
      model: first.ask,
      now: () => clock,
    });
    expect(await service.cleanupOne(userId, agentId)).toBe("failed");
    // The summary was saved before the delete was tried: it covers both.
    expect((await service.view(userId, agentId)).summary).toBe(SUMMARY);
    expect(hub.removed).toEqual([a.threadId]);

    hub.failOn(null);
    const second = model([]);
    const again = createChatSummaryService({
      database,
      conversations: hub.service,
      model: second.ask,
      now: () => clock + 2 * 60 * 60 * 1000,
    });
    expect(await again.cleanupOne(userId, agentId)).toBe("nothing");
    expect(hub.removed).toEqual([a.threadId, b.threadId]);
    expect(await deleted(b.channelId)).toBe(true);
    // Nothing new to summarise: the model was not asked, and the summary is as it was.
    expect(second.asked).toEqual([]);
    expect((await again.view(userId, agentId)).summary).toBe(SUMMARY);
  });

  test("next week's summary merges into last week's; a long week goes to the model in pieces", async () => {
    const userId = await person();
    const agentId = await employee();
    const long = Array.from({ length: 12 }, (_, i) =>
      said("user", `Order ${i}: ${"x".repeat(4000)}`),
    );
    const one = await conversation(
      userId,
      [agentId],
      new Date(clock - 2 * DAY),
    );
    const hub = conversationService({ [one.threadId]: long });
    const pieces = transcriptChunks([{ messages: long }]);
    expect(pieces.length).toBe(3);
    const m = model([
      "Week 1, part 1: Maria runs Demo Shop in Athens.",
      "Week 1, part 2: orders 0 to 11 are all confirmed.",
      "Week 1, merged: Demo Shop, orders 0 to 11 confirmed.",
    ]);
    const service = createChatSummaryService({
      database,
      conversations: hub.service,
      model: m.ask,
      now: () => clock,
    });
    expect(await service.cleanupOne(userId, agentId)).toBe("done");
    // Each piece merges into the summary so far, in order.
    expect(m.asked).toHaveLength(3);
    expect(m.asked[1]).toContain(
      "Summary so far:\nWeek 1, part 1: Maria runs Demo Shop in Athens.",
    );
    expect(m.asked[2]).toContain(
      "Summary so far:\nWeek 1, part 2: orders 0 to 11 are all confirmed.",
    );
    expect(pieces.every((chunk) => chunk.length <= CHUNK_CHARACTERS)).toBe(
      true,
    );

    const two = await conversation(userId, [agentId], new Date(clock - DAY));
    const hub2 = conversationService({
      [two.threadId]: [said("user", "New customer: Kostas, Thessaloniki.")],
    });
    const next = model(["Weeks 1 and 2: new customer Kostas in Thessaloniki."]);
    const later = createChatSummaryService({
      database,
      conversations: hub2.service,
      model: next.ask,
      now: () => clock + 7 * DAY,
    });
    expect(await later.cleanupOne(userId, agentId)).toBe("done");
    expect(next.asked[0]).toContain(
      "Summary so far:\nWeek 1, merged: Demo Shop, orders 0 to 11 confirmed.",
    );
    expect(next.asked[0]).toContain("New customer: Kostas, Thessaloniki.");
    expect((await later.view(userId, agentId)).summary).toBe(
      "Weeks 1 and 2: new customer Kostas in Thessaloniki.",
    );
  });

  test("the run: Sunday night in the person's own time zone, once a week, never when switched off", async () => {
    const userId = await person();
    const agentId = await employee();
    await conversation(userId, [agentId], new Date(clock - 2 * DAY));
    const hub = conversationService({});
    let now = SUNDAY_NIGHT;
    const service = createChatSummaryService({
      database,
      conversations: hub.service,
      model: model(["unused"]).ask,
      now: () => now,
    });
    // The person's browser said Athens.
    await service.view(userId, agentId, "Europe/Athens");
    const ran = async () => {
      const [row] = await database
        .select({ at: agentChatSummaries.lastAttemptAt })
        .from(agentChatSummaries)
        .where(eq(agentChatSummaries.agentId, agentId));
      return row?.at?.getTime() ?? null;
    };
    // Saturday 23:00 Athens: not yet.
    now = Date.parse("2026-11-28T21:00:00.000Z");
    await service.runDue();
    expect(await ran()).toBeNull();
    // Sunday 03:00 Athens: runs.
    now = SUNDAY_NIGHT;
    await service.runDue();
    expect(await ran()).toBe(SUNDAY_NIGHT);
    // The same night an hour later: already done this week.
    now = SUNDAY_NIGHT + 60 * 60 * 1000;
    await service.runDue();
    expect(await ran()).toBe(SUNDAY_NIGHT);
    // Switched off: the next Sunday nothing runs.
    await service.setEnabled(userId, agentId, false);
    now = SUNDAY_NIGHT + 7 * DAY;
    await service.runDue();
    expect(await ran()).toBe(SUNDAY_NIGHT);

    expect(inCleanupWindow(SUNDAY_NIGHT, "Europe/Athens")).toBe(true);
    expect(inCleanupWindow(SUNDAY_NIGHT, "America/New_York")).toBe(false);
    expect(inCleanupWindow(SUNDAY_NIGHT, "Not/AZone")).toBe(false);
  });
});
