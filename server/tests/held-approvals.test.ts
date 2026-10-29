import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import {
  approvalDetails,
  CHAT_CARD_KIND,
  COMPUTER_ACTION_KIND,
  resumeTask,
  TOOL_CALL_KIND,
} from "../src/approvals/held";
import { createApprovalRoutes } from "../src/approvals/routes";
import type {
  ApprovalInput,
  ApprovalRecord,
  ApprovalStore,
} from "../src/approvals/store";
import type { AppVariables } from "../src/auth/guards";
import {
  evaluateActionPolicy,
  type PolicyContext,
} from "../src/computer/policy";
import {
  DEFAULT_ACTION_POLICY,
  parseActionPolicy,
} from "../src/computer/policy-store";
import { bindRun } from "../src/copilot";
import { toolCallOutcome } from "../src/plugins/call-outcome";
import type { GrantedTool } from "../src/plugins/tools";

function click(name: string, type = ""): PolicyContext {
  return {
    tool: { name: "computer_click" },
    bot: { id: "bot" },
    actor: { id: "person" },
    page: { url: "https://shop.example.com/", host: "shop.example.com" },
    intent: "activate",
    key: "",
    element: { ref: "e1", role: "button", name, type },
    file: { path: "", name: "", extension: "" },
    command: "",
    initiator: { kind: "person", id: "" },
    mcp: { server: "", tool: "", effect: "" },
  };
}

describe("the third outcome in the boundary", () => {
  test("approve is asked after deny and before allow", () => {
    const policy = {
      mode: "enforce" as const,
      deny: ['element.name == "Delete everything"'],
      allow: ["true"],
      approve: ['contains(element.name, "delete")'],
    };
    const refused = evaluateActionPolicy(policy, click("Delete everything"));
    expect(refused.source).toBe("deny");
    expect(refused.needsApproval).toBeUndefined();

    const held = evaluateActionPolicy(policy, click("Delete draft"));
    expect(held).toMatchObject({
      source: "approve",
      needsApproval: true,
      allowed: false,
      forward: false,
    });
    expect(held.reason).toContain("needs a person to approve that first");

    expect(evaluateActionPolicy(policy, click("Save")).source).toBe("allow");
  });

  test("in dry-run a held action is recorded and let through", () => {
    const held = evaluateActionPolicy(
      { mode: "dry-run", deny: [], allow: ["true"], approve: ["true"] },
      click("Pay"),
    );
    expect(held.needsApproval).toBe(true);
    expect(held.forward).toBe(true);
  });

  test("the default holds paying, sending, submitting and deleting, and not much else (desk #27)", () => {
    const decide = (context: PolicyContext) =>
      evaluateActionPolicy(DEFAULT_ACTION_POLICY, context).source;
    for (const name of [
      "Pay now",
      "Send",
      "SUBMIT",
      "Place order",
      "Delete account",
      "Buy",
      "Checkout",
    ]) {
      expect(decide(click(name))).toBe("approve");
    }
    // A submit button by type, whatever it says.
    expect(decide(click("Continue", "submit"))).toBe("approve");
    // Whole words: these must not be held.
    for (const name of [
      "Display options",
      "Sender details",
      "Next",
      "Payload viewer",
    ]) {
      expect(decide(click(name))).toBe("allow");
    }
    // Enter submits whatever form has focus.
    expect(
      decide({ ...click(""), tool: { name: "computer_key" }, key: "Enter" }),
    ).toBe("approve");
    // Except in a search box, where it is a query: holding every search stopped plain web lookups.
    const enterIn = (role: string, type = "") => ({
      ...click(""),
      tool: { name: "computer_key" },
      key: "Enter",
      element: { ref: "e2", role, name: "Search", type },
    });
    expect(decide(enterIn("searchbox"))).toBe("allow");
    expect(decide(enterIn("textbox", "search"))).toBe("allow");
    expect(decide(enterIn("textbox"))).toBe("approve");
  });

  test("a saved policy keeps its approve list, and an old one without it still reads", () => {
    const parsed = parseActionPolicy({
      mode: "enforce",
      deny: [],
      allow: ["true"],
      approve: ['intent == "run_command"'],
    });
    expect(parsed.ok && parsed.policy.approve).toEqual([
      'intent == "run_command"',
    ]);
    const old = parseActionPolicy({
      mode: "enforce",
      deny: [],
      allow: ["true"],
    });
    expect(old.ok && old.policy.approve).toEqual([]);
    expect(parseActionPolicy({ mode: "enforce", approve: "x" }).ok).toBe(false);
  });
});

describe("the default outcome for a tool", () => {
  test("a write asks and a read runs, where somebody can be asked", () => {
    expect(toolCallOutcome({ set: null, effect: "write", canAsk: true })).toBe(
      "ask",
    );
    expect(toolCallOutcome({ set: null, effect: "read", canAsk: true })).toBe(
      "allow",
    );
    expect(toolCallOutcome({ set: null, effect: "write", canAsk: false })).toBe(
      "allow",
    );
    expect(
      toolCallOutcome({ set: "refuse", effect: "read", canAsk: true }),
    ).toBe("refuse");
    expect(
      toolCallOutcome({ set: "allow", effect: "write", canAsk: true }),
    ).toBe("allow");
  });
});

describe("a built-in run tells its tools which run it is", () => {
  test("bound tools receive the runtime's run and thread; others are untouched", async () => {
    const seen: unknown[] = [];
    const plain: GrantedTool = {
      name: "plain",
      ref: "x/plain",
      description: "",
      parameters: z.object({}),
      execute: async () => "plain",
    };
    const bound: GrantedTool = {
      ...plain,
      name: "bound",
      execute: async () => "unbound",
      executeInRun: async (args, run) => {
        seen.push({ args, run });
        return "bound";
      },
    };
    expect(bindRun([plain], { runId: "r", threadId: "t" })).toEqual([plain]);
    const tools = bindRun([plain, bound], { runId: "r", threadId: "t" });
    expect(tools[0]).toBe(plain);
    expect(await tools[1]?.execute({ a: 1 })).toBe("bound");
    expect(seen).toEqual([
      { args: { a: 1 }, run: { runId: "r", threadId: "t" } },
    ]);
  });
});

describe("what the resumed employee is told", () => {
  const call = {
    kind: TOOL_CALL_KIND,
    summary: "Call send_message on Messenger.",
    payload: { tool: "send_message", serverTitle: "Messenger" },
    result: null,
  };
  test("approved: the result, and to carry on", () => {
    const task = resumeTask({ ...call, status: "approved" }, "message 42 sent");
    expect(task).toContain("approved your call to send_message on Messenger");
    expect(task).toContain("message 42 sent");
    expect(task).toContain("Carry on");
  });
  test("declined: that it was not done, and not to work around it", () => {
    const task = resumeTask({ ...call, status: "rejected" }, null);
    expect(task).toContain("declined");
    expect(task).toContain("do not try to do it another way");
  });
  test("failed: that it did not happen, and why", () => {
    const task = resumeTask(
      { ...call, status: "failed", result: "The page has changed" },
      null,
    );
    expect(task).toContain("could not be carried out: The page has changed");
  });
});

describe("what the person is shown", () => {
  test("a held call's exact arguments, strings as written and the rest as JSON", () => {
    expect(
      approvalDetails({
        kind: TOOL_CALL_KIND,
        payload: {
          tool: "send_message",
          serverTitle: "Messenger",
          args: { to: "ana@example.test", amount: 12.5, tags: ["a"] },
        },
      }),
    ).toEqual([
      { label: "Tool", value: "send_message on Messenger" },
      { label: "to", value: "ana@example.test" },
      { label: "amount", value: "12.5" },
      { label: "tags", value: '["a"]' },
    ]);
  });
  test("a held browser action's page, element and rule", () => {
    const rows = approvalDetails({
      kind: COMPUTER_ACTION_KIND,
      payload: {
        action: "computer_click",
        pageUrl: "https://shop.example.com/checkout",
        element: { role: "button", name: "Pay now", type: "submit" },
        rule: "r",
        input: { ref: "e9", snapshotId: 7 },
      },
    });
    expect(rows).toContainEqual({
      label: "Page",
      value: "https://shop.example.com/checkout",
    });
    expect(rows).toContainEqual({
      label: "Element",
      value: "button “Pay now”",
    });
  });
});

/* ------------------------------------------------------------- chat cards, through the routes */

const actor = { id: "user-1", email: "a@example.test", role: "user" } as const;
const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", actor);
  await next();
};

function card(input: ApprovalInput): ApprovalRecord {
  return {
    id: "apr_card",
    ownerUserId: input.ownerUserId,
    requestedByAgentId: input.requestedByAgentId,
    requestedByName: "Rita",
    kind: input.kind,
    targetAgentId: null,
    targetAgentName: null,
    targetId: input.targetId ?? null,
    summary: input.summary,
    payload: input.payload,
    status: "pending",
    result: null,
    createdAt: new Date(),
    expiresAt: new Date(),
    decidedAt: null,
    decidedBy: null,
    threadId: null,
    runId: null,
    channelId: null,
  };
}

describe("approval cards raised in chat are listed with everything else (desk #69)", () => {
  test("a card registers as a request keyed on its tool call, for an employee the person may use", async () => {
    const asked: ApprovalInput[] = [];
    const store = {
      request: async (input: ApprovalInput) => {
        asked.push(input);
        return card(input);
      },
    } as unknown as ApprovalStore;
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/",
      createApprovalRoutes(
        store,
        requireUser,
        async (_actor, botId) => botId === "rita",
      ),
    );
    const post = (body: unknown) =>
      app.request("/cards", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const response = await post({
      toolCallId: "call-1",
      agentId: "rita",
      channelId: "ch-1",
      title: "Refund this order?",
      summary: "Charged twice.",
      details: [{ label: "Amount", value: "$128.40" }],
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(asked[0]).toMatchObject({
      ownerUserId: "user-1",
      requestedByAgentId: "rita",
      kind: CHAT_CARD_KIND,
      key: "call-1",
    });
    expect(body.approval).toMatchObject({
      kind: CHAT_CARD_KIND,
      toolCallId: "call-1",
      channelId: "ch-1",
      details: [{ label: "Amount", value: "$128.40" }],
    });

    expect(
      (
        await post({
          toolCallId: "call-2",
          agentId: "somebody-else",
          title: "x",
        })
      ).status,
    ).toBe(404);
    expect((await post({ agentId: "rita", title: "x" })).status).toBe(400);
  });

  test("one request reads back by id, owner-scoped", async () => {
    const asked: string[] = [];
    const store = {
      get: async (owner: string, id: string) => {
        asked.push(`${owner}:${id}`);
        return id === "apr_card"
          ? card({
              ownerUserId: owner,
              requestedByAgentId: "rita",
              kind: CHAT_CARD_KIND,
              summary: "x",
              payload: { toolCallId: "call-1" },
            })
          : null;
      },
    } as unknown as ApprovalStore;
    const app = new Hono<{ Variables: AppVariables }>();
    app.route("/", createApprovalRoutes(store, requireUser));
    expect((await app.request("/apr_card")).status).toBe(200);
    expect((await app.request("/apr_other")).status).toBe(404);
    expect(asked).toEqual(["user-1:apr_card", "user-1:apr_other"]);
  });
});
