import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { createApprovalRoutes } from "../src/approvals/routes";
import {
  ApprovalNotFoundError,
  ApprovalNotPendingError,
  type ApprovalRecord,
  type ApprovalStore,
} from "../src/approvals/store";
import type { AppVariables } from "../src/auth/guards";

const actor = { id: "user-1", email: "a@example.test", role: "user" } as const;

const record: ApprovalRecord = {
  id: "apr_1",
  ownerUserId: "user-1",
  requestedByAgentId: "lead",
  requestedByName: "Ana",
  kind: "routine.delete",
  targetAgentId: "ben",
  targetAgentName: "Ben",
  targetId: "r1",
  summary: "Delete Ben's weekly report routine",
  payload: { routineId: "r1", secret: "never sent" },
  status: "pending",
  result: null,
  createdAt: new Date("2026-10-18T10:00:00Z"),
  expiresAt: new Date("2026-10-25T10:00:00Z"),
  decidedAt: null,
};

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", actor);
  await next();
};

function appFor(store: Partial<ApprovalStore>) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/", createApprovalRoutes(store as ApprovalStore, requireUser));
  return app;
}

describe("approval routes", () => {
  test("lists what is waiting, with who asked and for whom, and never the payload", async () => {
    const calls: unknown[] = [];
    const app = appFor({
      list: async (...args) => {
        calls.push(args);
        return [record];
      },
      pendingCount: async () => 1,
    });
    const body = await (await app.request("/")).json();
    expect(body.pending).toBe(1);
    expect(body.approvals[0]).toMatchObject({
      id: "apr_1",
      summary: "Delete Ben's weekly report routine",
      requestedBy: { id: "lead", name: "Ana" },
      target: { id: "ben", name: "Ben" },
    });
    expect(JSON.stringify(body)).not.toContain("never sent");
    expect(calls).toEqual([["user-1", "pending"]]);
  });

  test("asks for the history only when told to", async () => {
    const calls: unknown[] = [];
    const app = appFor({
      list: async (...args) => {
        calls.push(args);
        return [];
      },
      pendingCount: async () => 0,
    });
    await app.request("/?which=all");
    expect(calls).toEqual([["user-1", "all"]]);
  });

  test("approve and reject act as the signed-in person, and answer with the request", async () => {
    const calls: unknown[] = [];
    const app = appFor({
      decide: async (...args) => {
        calls.push(args);
        return { ...record, status: "approved" };
      },
    });
    const approved = await app.request("/apr_1/approve", { method: "POST" });
    expect(approved.status).toBe(200);
    expect((await approved.json()).approval.status).toBe("approved");
    await app.request("/apr_1/reject", { method: "POST" });
    expect(calls).toEqual([
      ["user-1", "apr_1", "approve"],
      ["user-1", "apr_1", "reject"],
    ]);
  });

  test("somebody else's request is 404, and one already decided is 409", async () => {
    const missing = appFor({
      decide: async () => {
        throw new ApprovalNotFoundError();
      },
    });
    expect(
      (await missing.request("/apr_x/approve", { method: "POST" })).status,
    ).toBe(404);
    const decided = appFor({
      decide: async () => {
        throw new ApprovalNotPendingError("approved");
      },
    });
    expect(
      (await decided.request("/apr_1/approve", { method: "POST" })).status,
    ).toBe(409);
  });
});
