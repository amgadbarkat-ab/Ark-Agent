import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createAccountStore } from "../src/accounts/store";
import { createAgentProfileStore } from "../src/agents/profile-store";
import {
  COMPUTER_ACTION_KIND,
  computerActionApprovals,
  computerActionExecutor,
  resumeInConversation,
  TOOL_CALL_KIND,
  toolCallApprovals,
  toolCallExecutor,
} from "../src/approvals/held";
import {
  type ApprovalRecord,
  type ApprovalStore,
  createApprovalStore,
} from "../src/approvals/store";
import type { AuditEventInput, AuditStore } from "../src/audit";
import {
  ActionHeldError,
  ActionRefusedError,
  createComputerGateway,
} from "../src/computer/gateway";
import type { ActionPolicy } from "../src/computer/policy";
import { DEFAULT_ACTION_POLICY } from "../src/computer/policy-store";
import type { ComputerProvider } from "../src/computer/provider";
import type { SnapshotResult } from "../src/computer/schema";
import { createInMemorySnapshotStore } from "../src/computer/snapshot-store";
import { createDatabase } from "../src/db/client";
import {
  agents,
  approvals,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
  mcpServers,
  mcpTools,
  pluginGrants,
  users,
} from "../src/db/schema";
import { HELD_MARKER } from "../src/plugins/call-outcome";
import {
  createPluginStore,
  PluginRefusedError,
  type PluginStore,
} from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A call that needs a person: held, decided, and only then carried out, exactly as it was asked.
 *
 * Against a real PostgreSQL, because the property is about rows: the request a person approves is
 * the row the gateway reads its arguments from, and a call with no approved row behind it must not
 * reach a vendor or a browser whatever the caller claims.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const company = createAccountStore(database, { billingMode: "internal" });
const profiles = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
  undefined,
  company,
);
const suite = randomUUID().slice(0, 8);
const serverId = `held-${suite}`;
const writeTool = "send_message";
const readTool = "list_messages";
const userIds: string[] = [];
const agentIds: string[] = [];
let policy: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };

type Sent = { tool: string; args: Record<string, unknown> };

function audit() {
  const rows: AuditEventInput[] = [];
  const store: AuditStore = { insert: async (event) => void rows.push(event) };
  return { store, rows };
}

/** One deployment: the inbox, the plugin gateway, and what was delivered back. */
function deployment(options: { canAsk?: boolean } = {}) {
  const sent: Sent[] = [];
  const delivered: { record: ApprovalRecord; text: string | null }[] = [];
  const trail = audit();
  // Bound below; the executor needs the plugin store and the plugin store needs the inbox.
  let plugins: PluginStore | undefined;
  const inbox: ApprovalStore = createApprovalStore(database, {
    executors: {
      "chat.card": async () => "answered",
      [TOOL_CALL_KIND]: toolCallExecutor((input) => {
        if (!plugins) throw new Error("not built");
        return plugins.callTool(input);
      }),
    },
    afterDecision: {
      [TOOL_CALL_KIND]: async (record, outcome) => {
        delivered.push({ record, text: outcome.text });
      },
    },
    auditStore: trail.store,
  });
  plugins = createPluginStore({
    database,
    auditStore: trail.store,
    credentials: {
      readSecret: async () => null,
    } as never,
    encryptionKey: "k".repeat(64),
    policy: () => policy,
    callVendor: async (_connection, tool, args) => {
      sent.push({ tool, args });
      return { text: `sent ${JSON.stringify(args)}`, isError: false };
    },
    ...(options.canAsk === false
      ? {}
      : { approvals: toolCallApprovals(inbox) }),
  });
  return { plugins, inbox, sent, delivered, rows: trail.rows };
}

async function person() {
  const id = `held-user-${randomUUID()}`;
  await database
    .insert(users)
    .values({ id, email: `${id}@example.test`, name: "Held Test" });
  userIds.push(id);
  await company.ensureTenant(id);
  return { id, role: "user" as const };
}

async function employee(owner: { id: string; role: "user" }) {
  const made = await profiles.create(owner, {
    name: "Rita",
    title: "Assistant",
    roleDescription: "Rita sends messages.",
    visibility: "private",
  });
  agentIds.push(made.id);
  for (const tool of [writeTool, readTool]) {
    await database
      .insert(pluginGrants)
      .values({ kind: "mcp", ref: `${serverId}/${tool}`, agentId: made.id });
  }
  return made;
}

beforeAll(async () => {
  await database.insert(mcpServers).values({
    id: serverId,
    title: "Messenger",
    vendor: "test",
    url: "https://example.invalid/mcp",
    provenance: "custom",
  });
  await database.insert(mcpTools).values([
    // No effect said: a write, which is what an unclassified action is.
    {
      serverId,
      name: writeTool,
      description: "Send a message",
      inputSchema: {},
    },
    {
      serverId,
      name: readTool,
      description: "List messages",
      inputSchema: {},
      effect: "read",
    },
  ]);
});

afterEach(async () => {
  policy = { mode: "enforce", deny: [], allow: ["true"] };
  if (agentIds.length) {
    await database
      .delete(approvals)
      .where(inArray(approvals.requestedByAgentId, agentIds));
  }
  for (const id of agentIds.splice(0)) {
    await database.delete(agents).where(eq(agents.id, id));
  }
  for (const id of userIds.splice(0)) {
    await database.delete(users).where(eq(users.id, id));
  }
});

afterAll(async () => {
  await database.delete(mcpServers).where(eq(mcpServers.id, serverId));
  await database.$client.close();
});

const ARGS = { to: "ana@example.test", body: "The invoice is attached." };

describe("a tool call held for a person", () => {
  test("a tool that changes things is held by default, and nothing reaches the vendor", async () => {
    const owner = await person();
    const rita = await employee(owner);
    const { plugins, inbox, sent, rows } = deployment();

    const result = await plugins.callTool({
      ref: `${serverId}/${writeTool}`,
      args: ARGS,
      botId: rita.id,
      actorId: owner.id,
      run: { runId: "run-1", threadId: "thread-1" },
    });

    expect(result.held?.approvalId).toBeString();
    expect(result.text.startsWith(HELD_MARKER)).toBe(true);
    expect(result.text).toContain("has NOT been done yet");
    expect(sent).toEqual([]);

    const [request] = await inbox.list(owner.id);
    expect(request?.id).toBe(result.held?.approvalId as string);
    expect(request?.kind).toBe(TOOL_CALL_KIND);
    expect(request?.requestedByAgentId).toBe(rita.id);
    expect(request?.threadId).toBe("thread-1");
    expect(request?.runId).toBe("run-1");
    expect((request?.payload as { args?: unknown } | undefined)?.args).toEqual(
      ARGS,
    );

    // The request, its decision rows to come, and the call's outcome share one id.
    const held = rows.find((row) => row.eventType === "mcp.call_held");
    expect(held?.payload.approval).toBe(request?.id);
    expect(rows.map((row) => row.eventType)).toContain("approval.requested");
    expect(rows.map((row) => row.eventType)).not.toContain(
      "mcp.call_succeeded",
    );
  });

  test("a tool that only reads runs without asking", async () => {
    const owner = await person();
    const rita = await employee(owner);
    const { plugins, sent } = deployment();
    const result = await plugins.callTool({
      ref: `${serverId}/${readTool}`,
      args: { folder: "inbox" },
      botId: rita.id,
      actorId: owner.id,
    });
    expect(result.held).toBeUndefined();
    expect(sent).toEqual([{ tool: readTool, args: { folder: "inbox" } }]);
  });

  test("approving runs the call with the stored arguments, once, and the result goes back", async () => {
    const owner = await person();
    const rita = await employee(owner);
    const { plugins, inbox, sent, delivered, rows } = deployment();
    const held = await plugins.callTool({
      ref: `${serverId}/${writeTool}`,
      args: ARGS,
      botId: rita.id,
      actorId: owner.id,
      run: { threadId: "thread-1" },
    });
    const id = held.held?.approvalId as string;

    const decided = await inbox.decide(owner.id, id, "approve");

    expect(decided.status).toBe("approved");
    // Exactly what the person saw, although the executor hands the gateway no arguments at all.
    expect(sent).toEqual([{ tool: writeTool, args: ARGS }]);
    expect(decided.result).toContain("sent");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.record.status).toBe("approved");
    expect(delivered[0]?.text).toBe(`sent ${JSON.stringify(ARGS)}`);

    const approved = rows.find((row) => row.eventType === "approval.approved");
    expect(approved?.actorUserId).toBe(owner.id);
    expect(approved?.payload.decidedBy).toBe(owner.id);
    expect(approved?.payload.decidedAt).toBeString();
    const outcome = rows.find((row) => row.eventType === "mcp.call_succeeded");
    expect(outcome?.payload.approval).toBe(id);

    // A second decision is refused, and the call is not made twice.
    await expect(inbox.decide(owner.id, id, "approve")).rejects.toThrow();
    expect(sent).toHaveLength(1);
  });

  test("declining never calls the vendor, and the employee is told", async () => {
    const owner = await person();
    const rita = await employee(owner);
    const { plugins, inbox, sent, delivered, rows } = deployment();
    const held = await plugins.callTool({
      ref: `${serverId}/${writeTool}`,
      args: ARGS,
      botId: rita.id,
      actorId: owner.id,
      run: { threadId: "thread-1" },
    });
    const decided = await inbox.decide(
      owner.id,
      held.held?.approvalId as string,
      "reject",
    );
    expect(decided.status).toBe("rejected");
    expect(sent).toEqual([]);
    expect(delivered.map((one) => one.record.status)).toEqual(["rejected"]);
    expect(rows.map((row) => row.eventType)).toContain("approval.rejected");
  });

  test("a call cannot run on an approval that does not exist, is still pending, or is for another tool", async () => {
    const owner = await person();
    const rita = await employee(owner);
    const { plugins, sent } = deployment();
    const held = await plugins.callTool({
      ref: `${serverId}/${writeTool}`,
      args: ARGS,
      botId: rita.id,
      actorId: owner.id,
    });
    const pending = held.held?.approvalId as string;

    for (const approvalId of [pending, "apr_forged", `apr_${randomUUID()}`]) {
      await expect(
        plugins.callTool({
          ref: `${serverId}/${writeTool}`,
          args: ARGS,
          botId: rita.id,
          actorId: owner.id,
          approvalId,
        }),
      ).rejects.toBeInstanceOf(PluginRefusedError);
    }
    // Pending, presented for a different tool.
    await expect(
      plugins.callTool({
        ref: `${serverId}/${readTool}`,
        args: {},
        botId: rita.id,
        actorId: owner.id,
        approvalId: pending,
      }),
    ).rejects.toBeInstanceOf(PluginRefusedError);
    expect(sent).toEqual([]);
  });

  test("an approval for one person's call cannot be spent by somebody else", async () => {
    const owner = await person();
    const rita = await employee(owner);
    const other = await person();
    const { plugins, inbox, sent } = deployment();
    const held = await plugins.callTool({
      ref: `${serverId}/${writeTool}`,
      args: ARGS,
      botId: rita.id,
      actorId: owner.id,
    });
    const id = held.held?.approvalId as string;
    // Somebody else cannot decide it: it reads as missing.
    await expect(inbox.decide(other.id, id, "approve")).rejects.toThrow(
      "There is no such approval.",
    );
    await inbox.decide(owner.id, id, "approve");
    expect(sent).toHaveLength(1);
    await expect(
      plugins.callTool({
        ref: `${serverId}/${writeTool}`,
        args: ARGS,
        botId: rita.id,
        actorId: other.id,
        approvalId: id,
      }),
    ).rejects.toBeInstanceOf(PluginRefusedError);
    expect(sent).toHaveLength(1);
  });

  test("an administrator's setting decides: allow runs a write, refuse refuses, ask holds a read", async () => {
    const owner = await person();
    const rita = await employee(owner);
    const { plugins, sent } = deployment();
    const call = (tool: string) =>
      plugins.callTool({
        ref: `${serverId}/${tool}`,
        args: {},
        botId: rita.id,
        actorId: owner.id,
      });
    try {
      await plugins.setToolCallOutcome(
        serverId,
        writeTool,
        "allow",
        "admin@test",
      );
      expect((await call(writeTool)).held).toBeUndefined();
      expect(sent).toHaveLength(1);

      await plugins.setToolCallOutcome(
        serverId,
        writeTool,
        "refuse",
        "admin@test",
      );
      await expect(call(writeTool)).rejects.toThrow("may not call it");
      expect(sent).toHaveLength(1);

      await plugins.setToolCallOutcome(serverId, readTool, "ask", "admin@test");
      expect((await call(readTool)).held).toBeDefined();
      expect(sent).toHaveLength(1);

      const listed = (await plugins.listServers()).find(
        (one) => one.id === serverId,
      );
      const byName = new Map(listed?.tools.map((tool) => [tool.name, tool]));
      expect(byName.get(writeTool)?.onCall).toBe("refuse");
      expect(byName.get(writeTool)?.onCallSet).toBe(true);
      expect(byName.get(readTool)?.onCall).toBe("ask");

      await plugins.setToolCallOutcome(serverId, writeTool, null, "admin@test");
      const back = (await plugins.listServers()).find(
        (one) => one.id === serverId,
      );
      const write = back?.tools.find((tool) => tool.name === writeTool);
      expect(write?.onCall).toBe("ask");
      expect(write?.onCallSet).toBe(false);
    } finally {
      await plugins.setToolCallOutcome(serverId, writeTool, null, "admin@test");
      await plugins.setToolCallOutcome(serverId, readTool, null, "admin@test");
    }
  });

  test("a boundary rule can hold a call too, after the refusal list", async () => {
    const owner = await person();
    const rita = await employee(owner);
    const { plugins, sent } = deployment();
    policy = {
      mode: "enforce",
      deny: [],
      allow: ["true"],
      approve: [`mcp.tool == "${readTool}"`],
    };
    const held = await plugins.callTool({
      ref: `${serverId}/${readTool}`,
      args: {},
      botId: rita.id,
      actorId: owner.id,
    });
    expect(held.held).toBeDefined();
    policy = { ...policy, deny: [`mcp.tool == "${readTool}"`] };
    await expect(
      plugins.callTool({
        ref: `${serverId}/${readTool}`,
        args: {},
        botId: rita.id,
        actorId: owner.id,
      }),
    ).rejects.toBeInstanceOf(PluginRefusedError);
    expect(sent).toEqual([]);
  });

  test("with nowhere to ask, a write keeps running and an explicit ask is refused", async () => {
    const owner = await person();
    const rita = await employee(owner);
    const { plugins, sent } = deployment({ canAsk: false });
    const call = () =>
      plugins.callTool({
        ref: `${serverId}/${writeTool}`,
        args: ARGS,
        botId: rita.id,
        actorId: owner.id,
      });
    expect((await call()).held).toBeUndefined();
    try {
      await plugins.setToolCallOutcome(
        serverId,
        writeTool,
        "ask",
        "admin@test",
      );
      await expect(call()).rejects.toThrow("nowhere to ask");
      expect(sent).toHaveLength(1);
    } finally {
      await plugins.setToolCallOutcome(serverId, writeTool, null, "admin@test");
    }
  });

  test("the outcome is queued as a hop that resumes the employee in the same conversation", async () => {
    const offered: {
      kind: string;
      key: string;
      payload: Record<string, unknown>;
    }[] = [];
    const resume = resumeInConversation({
      offer: async (item) => {
        offered.push(item as never);
        return true as never;
      },
    });
    const owner = await person();
    const rita = await employee(owner);
    const { plugins, inbox } = deployment();
    const held = await plugins.callTool({
      ref: `${serverId}/${writeTool}`,
      args: ARGS,
      botId: rita.id,
      actorId: owner.id,
      run: { threadId: "thread-9", runId: "run-9" },
    });
    const record = await inbox.decide(
      owner.id,
      held.held?.approvalId as string,
      "approve",
    );
    await resume(record, { text: "sent it" });
    expect(offered).toHaveLength(1);
    expect(offered[0]?.key).toBe(`approval:${record.id}`);
    expect(offered[0]?.payload).toMatchObject({
      fromBotId: rita.id,
      toBotId: rita.id,
      actorId: owner.id,
      threadId: "thread-9",
      answerIn: "thread-9",
      resume: true,
    });
    expect(String(offered[0]?.payload.task)).toContain("sent it");
  });
});

describe("where a request was asked", () => {
  test("each request links to its own conversation, not to somebody's first one", async () => {
    const owner = await person();
    const rita = await employee(owner);
    const { plugins, inbox } = deployment();
    const ids = [`ch-a-${suite}`, `ch-b-${suite}`];
    try {
      for (const [index, id] of ids.entries()) {
        await database
          .insert(channels)
          .values({ id, name: id, description: "" });
        await database
          .insert(channelMemberships)
          .values({ channelId: id, userId: owner.id });
        await database.insert(intelligenceChannelMappings).values({
          userId: owner.id,
          channelId: id,
          threadId: `thread-${index}-${suite}`,
        });
      }
      for (const index of [0, 1]) {
        await plugins.callTool({
          ref: `${serverId}/${writeTool}`,
          args: { to: `person-${index}` },
          botId: rita.id,
          actorId: owner.id,
          run: { threadId: `thread-${index}-${suite}` },
        });
      }
      const listed = await inbox.list(owner.id);
      const byTarget = new Map(
        listed.map((row) => [
          (row.payload as { args: { to: string } }).args.to,
          row.channelId,
        ]),
      );
      expect(byTarget.get("person-0")).toBe(ids[0] as string);
      expect(byTarget.get("person-1")).toBe(ids[1] as string);
    } finally {
      await database.delete(channels).where(inArray(channels.id, ids));
    }
  });
});

describe("an approval card raised in chat", () => {
  test("registering it twice is one request, and only its owner can read it", async () => {
    const owner = await person();
    const other = await person();
    const rita = await employee(owner);
    const { inbox } = deployment();
    const ask = () =>
      inbox.request({
        ownerUserId: owner.id,
        requestedByAgentId: rita.id,
        kind: "chat.card",
        summary: "Refund this order?",
        payload: { toolCallId: "call-1", title: "Refund this order?" },
        key: "call-1",
      });
    const first = await ask();
    const again = await ask();
    expect(again.id).toBe(first.id);
    expect(await inbox.pendingCount(owner.id)).toBe(1);
    expect((await inbox.get(owner.id, first.id))?.id).toBe(first.id);
    expect(await inbox.get(other.id, first.id)).toBeNull();
  });
});

/* ---------------------------------------------------------------- the browser ---------------- */

const SNAPSHOT: SnapshotResult = {
  snapshotId: 7,
  url: "https://shop.example.com/checkout",
  title: "Checkout",
  truncated: false,
  elements: [
    { ref: "e1", role: "textbox", name: "Card holder", type: "text" },
    { ref: "e9", role: "button", name: "Pay now", type: "submit" },
    { ref: "e4", role: "link", name: "Display options" },
  ],
};

function browser(owner: string) {
  const clicks: unknown[] = [];
  let snapshot = SNAPSHOT;
  const provider: ComputerProvider = {
    name: "test",
    isolation: "per-bot",
    locate: async () => "http://agent-computer:4100",
    status: async (botId) => ({ botId, state: "ready" }),
    stop: async () => ({ wasRunning: true }),
    reset: async () => ({ cleared: true }),
    list: async () => [],
  };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/snapshot") return Response.json(snapshot);
    if (path === "/click") {
      clicks.push(JSON.parse(String(init?.body)));
      return Response.json({
        action: "click",
        url: snapshot.url,
        elapsedMs: 1,
      });
    }
    return Response.json({ error: "unknown" }, { status: 404 });
  }) as unknown as typeof fetch;
  const trail = audit();
  let gateway: ReturnType<typeof createComputerGateway> | undefined;
  const inbox = createApprovalStore(database, {
    executors: {
      [COMPUTER_ACTION_KIND]: computerActionExecutor(() => gateway),
    },
    auditStore: trail.store,
  });
  gateway = createComputerGateway({
    provider,
    fetchImpl,
    auditStore: trail.store,
    policy: () => DEFAULT_ACTION_POLICY,
    snapshots: createInMemorySnapshotStore(),
    approvals: computerActionApprovals(inbox),
  });
  return {
    gateway,
    inbox,
    clicks,
    rows: trail.rows,
    actor: { id: owner, userId: owner },
    page: (next: SnapshotResult) => {
      snapshot = next;
    },
  };
}

describe("a browser action held for a person", () => {
  test("the default boundary holds a click on Pay now, and approving clicks that element", async () => {
    const owner = await person();
    const rita = await employee(owner);
    const { gateway, inbox, clicks, rows, actor } = browser(owner.id);
    await gateway.snapshot(rita.id);

    // An ordinary click still runs; "Display" is not "pay".
    await gateway.click(rita.id, actor, { ref: "e4", snapshotId: 7 });
    expect(clicks).toHaveLength(1);

    const held = await gateway
      .click(rita.id, actor, { ref: "e9", snapshotId: 7 }, undefined, {
        threadId: "thread-b",
      })
      .catch((error) => error);
    expect(held).toBeInstanceOf(ActionHeldError);
    expect(clicks).toHaveLength(1);
    expect(rows.map((row) => row.eventType)).toContain("computer.action_held");

    const [request] = await inbox.list(owner.id);
    expect(request?.kind).toBe(COMPUTER_ACTION_KIND);
    expect(request?.summary).toContain("“Pay now”");
    expect(request?.threadId).toBe("thread-b");

    const decided = await inbox.decide(
      owner.id,
      (held as ActionHeldError).approvalId,
      "approve",
    );
    expect(decided.status).toBe("approved");
    expect(clicks).toEqual([
      { ref: "e4", snapshotId: 7 },
      { ref: "e9", snapshotId: 7 },
    ]);
    const allowed = rows.filter(
      (row) => row.eventType === "computer.action_allowed",
    );
    expect(allowed.at(-1)?.payload.approval).toBe(decided.id);
  });

  test("if the page changed while it waited, nothing is clicked and the approval fails", async () => {
    const owner = await person();
    const rita = await employee(owner);
    const { gateway, inbox, clicks, actor, page } = browser(owner.id);
    await gateway.snapshot(rita.id);
    const held = (await gateway
      .click(rita.id, actor, { ref: "e9", snapshotId: 7 })
      .catch((error) => error)) as ActionHeldError;

    // A new snapshot: e9 is now something else entirely.
    page({
      ...SNAPSHOT,
      snapshotId: 8,
      elements: [
        { ref: "e9", role: "button", name: "Delete account", type: "button" },
      ],
    });
    await gateway.snapshot(rita.id);

    const decided = await inbox.decide(owner.id, held.approvalId, "approve");
    expect(decided.status).toBe("failed");
    expect(decided.result).toContain("page has changed");
    expect(clicks).toEqual([]);
  });

  test("a click cannot be carried out on an approval that is pending or does not match", async () => {
    const owner = await person();
    const rita = await employee(owner);
    const { gateway, clicks, actor } = browser(owner.id);
    await gateway.snapshot(rita.id);
    const held = (await gateway
      .click(rita.id, actor, { ref: "e9", snapshotId: 7 })
      .catch((error) => error)) as ActionHeldError;
    for (const approvalId of [held.approvalId, "apr_forged"]) {
      await expect(
        gateway.click(rita.id, actor, { ref: "e9", snapshotId: 7 }, undefined, {
          approvalId,
        }),
      ).rejects.toBeInstanceOf(ActionRefusedError);
    }
    expect(clicks).toEqual([]);
  });

  test("declining leaves the button unclicked", async () => {
    const owner = await person();
    const rita = await employee(owner);
    const { gateway, inbox, clicks, actor } = browser(owner.id);
    await gateway.snapshot(rita.id);
    const held = (await gateway
      .click(rita.id, actor, { ref: "e9", snapshotId: 7 })
      .catch((error) => error)) as ActionHeldError;
    expect(
      (await inbox.decide(owner.id, held.approvalId, "reject")).status,
    ).toBe("rejected");
    expect(clicks).toEqual([]);
  });
});
