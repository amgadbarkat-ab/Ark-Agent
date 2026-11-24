/**
 * Weekly summary, then chat cleanup (Amgad, 24 Nov 2026, #149).
 *
 * Once a week, outside business hours in the person's own time zone (Sunday night, 02:00 to 05:59),
 * for each digital employee whose cleanup is on:
 *  1. its one-to-one conversations with that person are read in full (a group conversation, with
 *     other employees in it, is never touched; nor is one active in the last hour);
 *  2. the employee's model writes the summary file: last week's summary merged with these
 *     conversations, keeping facts, decisions, open tasks, people and customer details;
 *  3. the summary is checked (it must be there, and say something) and SAVED;
 *  4. only then are those conversations deleted, in the conversation service and from the sidebar.
 * If the summary cannot be made, nothing is deleted and it is tried again on the next run. If a delete
 * fails half way, the rest are deleted on the next run before anything else, so no conversation is
 * ever summarised twice.
 *
 * The employee starts every request from the summary (`forRun`, in its instructions beside its
 * memories). The cleanup is on for an employee made after this feature arrived, off for one that
 * already existed (nobody's chats are deleted without their choice); Settings switches it, and
 * switching it off shows Amgad's warning. The same with a model on this computer or an API key: the
 * summary is asked of the model the person chose, and of the deployment's model when that cannot.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  agentChatSummaries,
  agents,
  channelAgents,
  channelMemberships,
  channels,
  chatSummaryEpoch,
  intelligenceChannelMappings,
  routines,
} from "../db/schema";
import type { ConversationService } from "../privacy/conversations";

/** Amgad's words, exactly, for switching the cleanup off. */
export const DEACTIVATE_WARNING =
  "deactivating this function will affect the usage of your LLM model.";

/** Asks a model for text. Null: no model could answer. */
export type SummaryModel = (
  userId: string,
  instruction: string,
  text: string,
) => Promise<string | null>;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** A run waits at least this long after the last one (a little under a week, so Sunday stays Sunday). */
const MIN_GAP_MS = 6 * 24 * 60 * 60 * 1000;
/** A failed attempt is tried again after this long, inside the same night. */
const RETRY_MS = 60 * 60 * 1000;
/** A conversation with a message this recent is left alone this week. */
const ACTIVE_MS = 60 * 60 * 1000;
/** How much conversation goes to the model at once (about 6,000 tokens), so a small local model copes. */
export const CHUNK_CHARACTERS = 24_000;
/** The longest a summary may be (about 3,000 tokens). */
export const MAX_SUMMARY_CHARACTERS = 12_000;
const MIN_SUMMARY_CHARACTERS = 40;

export const SUMMARY_INSTRUCTION = [
  "You keep the working summary of a digital employee's conversations with one person, so the employee can continue the work after the full conversations are deleted.",
  "You get the summary so far (it may be empty) and the conversations since. Write ONE new summary that merges both.",
  "Keep everything the employee needs later: facts about the person and their business, customer details (names, companies, contact details, orders, amounts, dates), decisions made, standing preferences and rules, promises made, and every open task with its due date.",
  "Drop greetings, small talk and repetition. Never keep passwords, keys, card numbers or other secrets.",
  "Use short headings: Facts, People and customers, Decisions, Preferences, Open tasks, Done recently. Under each, short lines.",
  "Write in the language the person wrote in (Greek for Greek conversations).",
  `Keep it under ${MAX_SUMMARY_CHARACTERS} characters. Answer with the summary only.`,
].join(" ");

export type ChatSummaryView = {
  enabled: boolean;
  /** Whether "on" here is the default (a new employee) rather than the person's choice. */
  isDefault: boolean;
  summary: string;
  summaryTokens: number;
  summarisedAt: string | null;
  lastError: string | null;
  warning: string;
};

type Row = typeof agentChatSummaries.$inferSelect;

function local(now: number, timeZone: string): { day: string; hour: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      weekday: "short",
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(now));
    return {
      day: parts.find((p) => p.type === "weekday")?.value ?? "",
      hour: Number(parts.find((p) => p.type === "hour")?.value ?? "-1"),
    };
  } catch {
    return local(now, "UTC");
  }
}

/** Sunday, 02:00 to 05:59, in that time zone: outside business hours anywhere. */
export function inCleanupWindow(now: number, timeZone: string): boolean {
  const { day, hour } = local(now, timeZone);
  return day === "Sun" && hour >= 2 && hour < 6;
}

/** The text of one stored message: what the person and the employee said, never tool output. */
function said(message: unknown): string | null {
  const m = (message ?? {}) as { role?: unknown; content?: unknown };
  if (m.role !== "user" && m.role !== "assistant") return null;
  const content =
    typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content)
        ? m.content
            .map((part) =>
              part && typeof part === "object" && "text" in part
                ? String((part as { text: unknown }).text ?? "")
                : "",
            )
            .join(" ")
        : "";
  const text = content.trim();
  return text ? `${m.role === "user" ? "Person" : "Employee"}: ${text}` : null;
}

/** Conversations as plain text, in pieces the model can take. */
export function transcriptChunks(
  conversations: Array<{ messages: unknown[] }>,
): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const [index, conversation] of conversations.entries()) {
    const lines = conversation.messages
      .map(said)
      .filter((line): line is string => line !== null);
    if (lines.length === 0) continue;
    for (const line of [`--- Conversation ${index + 1} ---`, ...lines]) {
      const piece = line.slice(0, CHUNK_CHARACTERS);
      if (current.length + piece.length + 1 > CHUNK_CHARACTERS && current) {
        chunks.push(current);
        current = "";
      }
      current += `${piece}\n`;
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

export type ChatSummaryService = ReturnType<typeof createChatSummaryService>;

export function createChatSummaryService(dependencies: {
  database: Database;
  conversations: ConversationService;
  model: SummaryModel;
  /** The computer's own time zone, when the person's is not known. */
  fallbackTimeZone?: string;
  now?: () => number;
  log?: (line: Record<string, unknown>) => void;
}) {
  const { database, conversations } = dependencies;
  const now = dependencies.now ?? Date.now;
  const log = dependencies.log ?? (() => {});

  async function epoch(): Promise<Date> {
    await database.insert(chatSummaryEpoch).values({}).onConflictDoNothing();
    const [row] = await database.select().from(chatSummaryEpoch).limit(1);
    return row?.startedAt ?? new Date(0);
  }

  async function row(userId: string, agentId: string): Promise<Row | null> {
    const [found] = await database
      .select()
      .from(agentChatSummaries)
      .where(
        and(
          eq(agentChatSummaries.userId, userId),
          eq(agentChatSummaries.agentId, agentId),
        ),
      );
    return found ?? null;
  }

  async function ensure(userId: string, agentId: string): Promise<Row> {
    await database
      .insert(agentChatSummaries)
      .values({ userId, agentId })
      .onConflictDoNothing();
    return (await row(userId, agentId)) as Row;
  }

  /** On by the person's choice, or by default for an employee made after the feature arrived. */
  async function isOn(found: Row | null, agentId: string): Promise<boolean> {
    if (found?.enabled !== null && found?.enabled !== undefined)
      return found.enabled;
    const [agent] = await database
      .select({ createdAt: agents.createdAt })
      .from(agents)
      .where(eq(agents.id, agentId));
    return agent ? agent.createdAt >= (await epoch()) : false;
  }

  async function timeZoneOf(found: Row | null, userId: string) {
    if (found?.timezone) return found.timezone;
    const [routine] = await database
      .select({ timezone: routines.timezone })
      .from(routines)
      .where(eq(routines.ownerUserId, userId))
      .orderBy(sql`${routines.updatedAt} desc`)
      .limit(1);
    return (
      routine?.timezone ??
      dependencies.fallbackTimeZone ??
      Intl.DateTimeFormat().resolvedOptions().timeZone ??
      "UTC"
    );
  }

  async function save(userId: string, agentId: string, set: Partial<Row>) {
    await database
      .update(agentChatSummaries)
      .set({ ...set, updatedAt: new Date(now()) })
      .where(
        and(
          eq(agentChatSummaries.userId, userId),
          eq(agentChatSummaries.agentId, agentId),
        ),
      );
  }

  /** Deletes what was already summarised: the conversation, then its place in the sidebar. */
  async function finishDeletes(current: Row): Promise<void> {
    let threads = [...current.pendingThreads];
    for (const threadId of current.pendingThreads) {
      await conversations.remove(threadId, current.userId);
      threads = threads.filter((id) => id !== threadId);
      await save(current.userId, current.agentId, { pendingThreads: threads });
    }
    if (current.pendingChannels.length > 0) {
      await database
        .update(channels)
        .set({ deletedAt: new Date(now()), updatedAt: new Date(now()) })
        .where(
          and(
            inArray(channels.id, current.pendingChannels),
            isNull(channels.deletedAt),
          ),
        );
      await save(current.userId, current.agentId, { pendingChannels: [] });
    }
  }

  /** The person's one-to-one conversations with this employee, quiet for the last hour. */
  async function conversationsOf(userId: string, agentId: string) {
    const quietSince = new Date(now() - ACTIVE_MS);
    const rows = await database
      .select({
        channelId: channels.id,
        threadId: intelligenceChannelMappings.threadId,
        lastMessageAt: channels.lastMessageAt,
      })
      .from(channels)
      .innerJoin(
        channelMemberships,
        and(
          eq(channelMemberships.channelId, channels.id),
          eq(channelMemberships.userId, userId),
        ),
      )
      .innerJoin(channelAgents, eq(channelAgents.channelId, channels.id))
      .innerJoin(
        intelligenceChannelMappings,
        and(
          eq(intelligenceChannelMappings.channelId, channels.id),
          eq(intelligenceChannelMappings.userId, userId),
        ),
      )
      .where(
        and(
          eq(channelAgents.agentId, agentId),
          isNull(channels.deletedAt),
          isNull(channels.packageId),
          // One employee only: a group conversation belongs to more than this one.
          sql`(select count(*) from ${channelAgents} ca where ca.channel_id = ${channels.id}) = 1`,
        ),
      );
    return rows.filter(
      (one) => !one.lastMessageAt || one.lastMessageAt < quietSince,
    );
  }

  /**
   * One employee's weekly run for one person. Returns what happened; never deletes a conversation
   * whose summary is not saved.
   */
  async function cleanupOne(
    userId: string,
    agentId: string,
  ): Promise<"done" | "nothing" | "failed"> {
    let current = await ensure(userId, agentId);
    await save(userId, agentId, { lastAttemptAt: new Date(now()) });
    try {
      // A delete that failed last time is finished first.
      if (
        current.pendingThreads.length > 0 ||
        current.pendingChannels.length > 0
      ) {
        await finishDeletes(current);
        current = (await row(userId, agentId)) as Row;
      }
      const found = await conversationsOf(userId, agentId);
      const read: Array<{ messages: unknown[] }> = [];
      for (const one of found)
        read.push({
          messages: await conversations.messages(one.threadId, userId),
        });
      const chunks = transcriptChunks(read);
      if (chunks.length === 0) {
        await save(userId, agentId, {
          summarisedAt: new Date(now()),
          lastError: null,
        });
        return "nothing";
      }
      let summary = current.summary;
      for (const chunk of chunks) {
        const answer = await dependencies.model(
          userId,
          SUMMARY_INSTRUCTION,
          `Summary so far:\n${summary || "(empty)"}\n\nConversations since:\n${chunk}`,
        );
        const text = answer?.trim() ?? "";
        if (text.length < MIN_SUMMARY_CHARACTERS)
          throw new Error("The model did not write a summary.");
        summary = text.slice(0, MAX_SUMMARY_CHARACTERS);
      }
      // Saved first, with what it covers marked for deletion: then, and only then, deleted.
      await save(userId, agentId, {
        summary,
        summaryTokens: Math.ceil(summary.length / 4),
        summarisedAt: new Date(now()),
        lastError: null,
        pendingThreads: found.map((one) => one.threadId),
        pendingChannels: found.map((one) => one.channelId),
      });
      await finishDeletes((await row(userId, agentId)) as Row);
      log({
        type: "chat-summary",
        agentId,
        conversations: found.length,
        summaryTokens: Math.ceil(summary.length / 4),
      });
      return "done";
    } catch (error) {
      await save(userId, agentId, {
        lastError:
          error instanceof Error
            ? error.message.slice(0, 300)
            : "The summary could not be made.",
      });
      log({
        type: "chat-summary-failed",
        agentId,
        errorName: (error as Error)?.name,
      });
      return "failed";
    }
  }

  return {
    cleanupOne,

    /** Whether such an employee exists, for the routes. */
    async agentExists(agentId: string): Promise<boolean> {
      return (
        (
          await database
            .select({ id: agents.id })
            .from(agents)
            .where(eq(agents.id, agentId))
        ).length > 0
      );
    },

    /** The setting and the summary, for Settings. `timeZone` is the person's, from their browser. */
    async view(
      userId: string,
      agentId: string,
      timeZone?: string,
    ): Promise<ChatSummaryView> {
      let found = await row(userId, agentId);
      if (timeZone && found?.timezone !== timeZone) {
        found = await ensure(userId, agentId);
        await save(userId, agentId, { timezone: timeZone.slice(0, 64) });
      }
      return {
        enabled: await isOn(found, agentId),
        isDefault: found?.enabled === null || found?.enabled === undefined,
        summary: found?.summary ?? "",
        summaryTokens: found?.summaryTokens ?? 0,
        summarisedAt: found?.summarisedAt?.toISOString() ?? null,
        lastError: found?.lastError ?? null,
        warning: DEACTIVATE_WARNING,
      };
    },

    async setEnabled(userId: string, agentId: string, enabled: boolean) {
      await ensure(userId, agentId);
      await save(userId, agentId, { enabled });
    },

    /** Each employee's summary, for its instructions: read once per load for all of them. */
    async forRun(
      userId: string,
      agentIds: string[],
    ): Promise<Map<string, string>> {
      if (agentIds.length === 0) return new Map();
      const rows = await database
        .select({
          agentId: agentChatSummaries.agentId,
          summary: agentChatSummaries.summary,
        })
        .from(agentChatSummaries)
        .where(
          and(
            eq(agentChatSummaries.userId, userId),
            inArray(agentChatSummaries.agentId, agentIds),
          ),
        );
      return new Map(
        rows
          .filter((one) => one.summary.trim() !== "")
          .map((one) => [one.agentId, one.summary]),
      );
    },

    /**
     * Every person and employee whose run is due now: cleanup on, inside their Sunday-night window,
     * not run in the last six days, and not tried in the last hour.
     */
    async runDue(): Promise<Record<string, number>> {
      const pairs = await database
        .selectDistinct({
          userId: channelMemberships.userId,
          agentId: channelAgents.agentId,
        })
        .from(channelMemberships)
        .innerJoin(
          channelAgents,
          eq(channelAgents.channelId, channelMemberships.channelId),
        )
        .innerJoin(channels, eq(channels.id, channelMemberships.channelId))
        .where(isNull(channels.deletedAt));
      const report: Record<string, number> = { done: 0, nothing: 0, failed: 0 };
      const at = now();
      for (const { userId, agentId } of pairs) {
        const found = await row(userId, agentId);
        if (!(await isOn(found, agentId))) continue;
        if (!inCleanupWindow(at, await timeZoneOf(found, userId))) continue;
        if (
          found?.summarisedAt &&
          at - found.summarisedAt.getTime() < MIN_GAP_MS
        )
          continue;
        if (
          found?.lastAttemptAt &&
          at - found.lastAttemptAt.getTime() < RETRY_MS
        )
          continue;
        const outcome = await cleanupOne(userId, agentId);
        report[outcome] = (report[outcome] ?? 0) + 1;
      }
      return report;
    },
  };
}

/** The summary as the employee reads it at the start of every request. */
export function summaryGuidance(summary: string): string {
  return [
    "Summary of your earlier conversations with this person. The full conversations were deleted after this summary was made (once a week), so start from it: it holds what you knew, what was decided and what is still open.",
    summary.trim(),
  ].join("\n");
}

export { WEEK_MS };
