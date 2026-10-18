import { z } from "zod";
import { REFUSAL_MARKER, type GrantedTool } from "../plugins/tools";
import { MemoryRefusedError, type MemoryStore } from "./store";

/**
 * How a digital employee keeps something in mind, and lets it go.
 *
 * Two tools and no search: what it remembers is in front of it on every run (see `memoryGuidance`),
 * so there is nothing to look up. It may only forget its own memories, never a colleague's, even
 * though both belong to the same person; the person, and the lead through the Requests inbox, are
 * who change anyone else's.
 *
 * Refusals are sentences the model can say, never throws.
 */

const remember = z.object({
  content: z
    .string()
    .describe(
      "One short sentence to keep in mind. Never a password, key or card number",
    ),
});

const forget = z.object({
  id: z.string().describe("The id at the start of the memory's line"),
});

export function memoryTools(options: {
  store: Pick<MemoryStore, "add" | "list" | "remove">;
  botId: string;
  actorId: string;
}): GrantedTool[] {
  const { store, botId, actorId } = options;
  return [
    {
      name: "memory_remember",
      ref: "memory/remember",
      description:
        "Keep one short thing in mind for next time, such as a preference, a name or a standing rule. You will see it at the start of every later conversation.",
      parameters: remember,
      execute: async (args) => {
        const parsed = remember.safeParse(args);
        if (!parsed.success) {
          return `${REFUSAL_MARKER} Say what to remember, in one short sentence.`;
        }
        try {
          const kept = await store.add({
            ownerUserId: actorId,
            agentId: botId,
            content: parsed.data.content,
            source: "agent",
          });
          return `Remembered (${kept.id}).`;
        } catch (error) {
          if (error instanceof MemoryRefusedError) {
            return `${REFUSAL_MARKER} ${error.message}`;
          }
          throw error;
        }
      },
    },
    {
      name: "memory_forget",
      ref: "memory/forget",
      description:
        "Let go of one of your own memories, by the id at the start of its line, when it is no longer true or the person asks you to.",
      parameters: forget,
      execute: async (args) => {
        const parsed = forget.safeParse(args);
        if (!parsed.success) {
          return `${REFUSAL_MARKER} Give the id of the memory to forget.`;
        }
        const own = await store.list(actorId, botId);
        if (!own.some((memory) => memory.id === parsed.data.id)) {
          return `${REFUSAL_MARKER} You have no memory with that id.`;
        }
        await store.remove(actorId, parsed.data.id);
        return "Forgotten.";
      },
    },
  ];
}
