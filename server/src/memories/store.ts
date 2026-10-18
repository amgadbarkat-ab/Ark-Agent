import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { Database } from "../db/client";
import { agentMemories, agentProfiles } from "../db/schema";
import { isSecret, scan } from "../marketplace/sanitize";

/**
 * What a digital employee keeps in mind between conversations.
 *
 * SHORT, COUNTED AND READ ON EVERY RUN. A memory is one or two sentences, an employee holds a hundred
 * at most, and the newest thirty are put into its standing instruction each time it runs. That is the
 * whole cost model: nothing here is searched or summarised, so what the employee remembers is exactly
 * what the person can read on its Memories page, and what they delete is gone from the next run.
 *
 * NEVER A SECRET. A password, a key or a card number has no business in a prompt that is sent to a
 * model provider on every turn, and an employee asked to "remember my password" should say no. The
 * same scanner the marketplace uses refuses them here, so one definition of "a secret" covers both.
 *
 * Owner-scoped throughout. Every call names the person and checks the employee is theirs; a memory
 * that is not theirs reads as missing.
 */

export const MAX_MEMORY_CHARACTERS = 500;
export const MAX_MEMORIES_PER_AGENT = 100;
/** How many go into a run, newest first. */
export const MEMORIES_PER_RUN = 30;

export type MemorySource = "agent" | "person" | "approved";

export type Memory = {
  id: string;
  agentId: string;
  content: string;
  source: MemorySource;
  createdAt: Date;
  updatedAt: Date;
};

export class MemoryNotFoundError extends Error {
  constructor() {
    super("There is no such memory.");
    this.name = "MemoryNotFoundError";
  }
}

/** The memory cannot be kept. Its message is written to be said to the person or read by the model. */
export class MemoryRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryRefusedError";
  }
}

export type MemoryStore = {
  /** One employee's memories, oldest first, for the person who owns it. */
  list(ownerUserId: string, agentId: string): Promise<Memory[]>;
  /** The newest few of each of these employees, for putting into their instructions. */
  forRun(
    ownerUserId: string,
    agentIds: readonly string[],
  ): Promise<Map<string, Memory[]>>;
  add(input: {
    ownerUserId: string;
    agentId: string;
    content: string;
    source: MemorySource;
  }): Promise<Memory>;
  update(
    ownerUserId: string,
    id: string,
    content: string,
    source?: MemorySource,
  ): Promise<Memory>;
  remove(ownerUserId: string, id: string): Promise<void>;
};

/** What is wrong with this text as a memory, or null. */
export function refusalFor(text: string): string | null {
  const content = text.trim();
  if (!content) return "A memory has to say something.";
  if (content.length > MAX_MEMORY_CHARACTERS) {
    return `A memory can be ${MAX_MEMORY_CHARACTERS} characters at most. Keep the one thing that matters.`;
  }
  const findings = scan({ memory: content }).filter(
    (finding) =>
      isSecret(finding.kind) ||
      finding.kind === "payment_card" ||
      finding.kind === "iban",
  );
  // The scanner reads `password: x` and `key=x`; people and models also write it as a sentence.
  const spoken =
    /\b(password|passcode|passphrase|secret|api[ -]?key|token|pin)\s*(?:is|are|was|=|:)\s*\S{4,}/i;
  if (findings.length > 0 || spoken.test(content)) {
    return "That looks like a password, key, card or account number, and those are never kept as memories.";
  }
  return null;
}

export function createMemoryStore(
  database: Database,
  options: { auditStore?: AuditStore } = {},
): MemoryStore {
  const select = {
    id: agentMemories.id,
    agentId: agentMemories.agentId,
    content: agentMemories.content,
    source: agentMemories.source,
    createdAt: agentMemories.createdAt,
    updatedAt: agentMemories.updatedAt,
  };
  const asMemory = (row: {
    id: string;
    agentId: string;
    content: string;
    source: string;
    createdAt: Date;
    updatedAt: Date;
  }): Memory => ({ ...row, source: row.source as MemorySource });

  const audit = async (
    eventType: "memory.added" | "memory.changed" | "memory.deleted",
    ownerUserId: string,
    memory: Pick<Memory, "id" | "agentId" | "source">,
  ) => {
    if (!options.auditStore) return;
    await recordAuditEvent(options.auditStore, {
      eventType,
      targetType: "agent",
      targetId: memory.agentId,
      actorUserId: ownerUserId,
      // The text itself is not written to the trail: it can be personal, and the page shows it.
      payload: {
        bot: memory.agentId,
        memory: memory.id,
        source: memory.source,
      },
    });
  };

  return {
    async list(ownerUserId, agentId) {
      const rows = await database
        .select(select)
        .from(agentMemories)
        .where(
          and(
            eq(agentMemories.agentId, agentId),
            eq(agentMemories.ownerUserId, ownerUserId),
          ),
        )
        .orderBy(asc(agentMemories.createdAt), asc(agentMemories.id));
      return rows.map(asMemory);
    },

    async forRun(ownerUserId, agentIds) {
      const out = new Map<string, Memory[]>();
      if (agentIds.length === 0) return out;
      const rows = await database
        .select(select)
        .from(agentMemories)
        .where(
          and(
            eq(agentMemories.ownerUserId, ownerUserId),
            inArray(agentMemories.agentId, [...agentIds]),
          ),
        )
        .orderBy(desc(agentMemories.createdAt), desc(agentMemories.id));
      for (const row of rows) {
        const held = out.get(row.agentId) ?? [];
        if (held.length < MEMORIES_PER_RUN) held.push(asMemory(row));
        out.set(row.agentId, held);
      }
      return out;
    },

    async add({ ownerUserId, agentId, content, source }) {
      const refusal = refusalFor(content);
      if (refusal) throw new MemoryRefusedError(refusal);
      // The employee has to be this person's own. Asked of the profile table so a shared employee,
      // or one that was deleted, cannot be given memories by someone who does not own it.
      const [owned] = await database
        .select({ id: agentProfiles.agentId })
        .from(agentProfiles)
        .where(
          and(
            eq(agentProfiles.agentId, agentId),
            eq(agentProfiles.ownerUserId, ownerUserId),
            sql`${agentProfiles.deletedAt} is null`,
          ),
        );
      if (!owned) {
        throw new MemoryRefusedError(
          "Only a digital employee's owner can give it memories.",
        );
      }
      // The count and the insert are one step: without the lock, two replicas adding at once would each
      // see ninety-nine and both write, and the cap would be a suggestion.
      const row = await database.transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`memories:${agentId}`}))`,
        );
        const [{ held } = { held: 0 }] = await transaction
          .select({ held: sql<number>`count(*)::int` })
          .from(agentMemories)
          .where(eq(agentMemories.agentId, agentId));
        if (held >= MAX_MEMORIES_PER_AGENT) {
          throw new MemoryRefusedError(
            `${MAX_MEMORIES_PER_AGENT} memories is the most one digital employee keeps. Forget one first.`,
          );
        }
        const [inserted] = await transaction
          .insert(agentMemories)
          .values({
            id: `mem_${crypto.randomUUID()}`,
            agentId,
            ownerUserId,
            content: content.trim(),
            source,
          })
          .returning(select);
        return inserted;
      });
      if (!row) throw new MemoryNotFoundError();
      const memory = asMemory(row);
      await audit("memory.added", ownerUserId, memory);
      return memory;
    },

    async update(ownerUserId, id, content, source) {
      const refusal = refusalFor(content);
      if (refusal) throw new MemoryRefusedError(refusal);
      const [row] = await database
        .update(agentMemories)
        .set({
          content: content.trim(),
          updatedAt: new Date(),
          ...(source ? { source } : {}),
        })
        .where(
          and(
            eq(agentMemories.id, id),
            eq(agentMemories.ownerUserId, ownerUserId),
          ),
        )
        .returning(select);
      if (!row) throw new MemoryNotFoundError();
      const memory = asMemory(row);
      await audit("memory.changed", ownerUserId, memory);
      return memory;
    },

    async remove(ownerUserId, id) {
      const [row] = await database
        .delete(agentMemories)
        .where(
          and(
            eq(agentMemories.id, id),
            eq(agentMemories.ownerUserId, ownerUserId),
          ),
        )
        .returning(select);
      if (!row) throw new MemoryNotFoundError();
      await audit("memory.deleted", ownerUserId, asMemory(row));
    },
  };
}

/**
 * The paragraph that puts an employee's memories in front of it, or null when it has none and no way
 * to keep any.
 *
 * Says what to remember and what never to, because the model decides on its own when to call
 * `memory_remember`, and without the rule it keeps small talk and, worse, whatever it was just told.
 */
export function memoryGuidance(memories: readonly Memory[]): string {
  const held = [...memories].reverse(); // oldest first, as a person would write them down
  return [
    held.length > 0
      ? `What you remember (each line starts with its id):\n${held
          .map(
            (memory) =>
              `- [${memory.id}] ${memory.content.replace(/\s+/g, " ")}`,
          )
          .join("\n")}`
      : "You have no memories yet.",
    "Keep a memory only when the person asks you to remember something, or when it will clearly help you do their work next time (a preference, a name, a standing rule). Use memory_remember with one short sentence, and memory_forget with the id when it stops being true or they ask you to drop it. Never keep passwords, keys, card numbers or anything secret, and never keep what you are not sure is true.",
  ].join("\n\n");
}
