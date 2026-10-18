import { describe, expect, test } from "bun:test";
import { MemoryRefusedError, type Memory } from "../src/memories/store";
import { memoryTools } from "../src/memories/tools";

const memory = (id: string, content = "x"): Memory => ({
  id,
  agentId: "ana",
  content,
  source: "agent",
  createdAt: new Date(),
  updatedAt: new Date(),
});

function harness(options: { refuse?: string; held?: Memory[] } = {}) {
  const calls: unknown[] = [];
  const tools = memoryTools({
    botId: "ana",
    actorId: "owner-1",
    store: {
      add: async (input) => {
        calls.push(["add", input]);
        if (options.refuse) throw new MemoryRefusedError(options.refuse);
        return memory("mem_new", input.content);
      },
      list: async (...args) => {
        calls.push(["list", ...args]);
        return options.held ?? [];
      },
      remove: async (...args) => {
        calls.push(["remove", ...args]);
      },
    },
  });
  const call = (name: string, args: unknown) => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`no tool ${name}`);
    return tool.execute(args);
  };
  return { call, calls, tools };
}

describe("memory tools", () => {
  test("remembering keeps it for this employee, as the agent, for its owner", async () => {
    const { call, calls } = harness();
    expect(await call("memory_remember", { content: "Prefers email." })).toBe(
      "Remembered (mem_new).",
    );
    expect(calls).toEqual([
      [
        "add",
        {
          ownerUserId: "owner-1",
          agentId: "ana",
          content: "Prefers email.",
          source: "agent",
        },
      ],
    ]);
  });

  test("a refusal comes back as a sentence the model can say", async () => {
    const { call } = harness({ refuse: "Those are never kept." });
    expect(await call("memory_remember", { content: "x" })).toBe(
      "Refused. Those are never kept.",
    );
  });

  test("it forgets its own memory, and nobody else's", async () => {
    const { call, calls } = harness({ held: [memory("mem_1")] });
    expect(await call("memory_forget", { id: "mem_1" })).toBe("Forgotten.");
    expect(await call("memory_forget", { id: "mem_other" })).toContain(
      "Refused.",
    );
    expect(calls.filter((c) => (c as unknown[])[0] === "remove")).toEqual([
      ["remove", "owner-1", "mem_1"],
    ]);
  });

  test("missing arguments are refused, not thrown", async () => {
    const { call } = harness();
    expect(await call("memory_remember", {})).toContain("Refused.");
    expect(await call("memory_forget", {})).toContain("Refused.");
  });
});
