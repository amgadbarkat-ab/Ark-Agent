import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { HandoffDesk } from "../src/agents/handoff";
import type { AuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createFanoutRoutes } from "../src/channels/fanout-routes";
import type { ChannelStore } from "../src/channels/routes";

const KEY = Buffer.alloc(32, 7).toString("base64");

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", {
    id: "user-1",
    email: "user@openbot.test",
    role: "member",
  });
  await next();
};

function app() {
  const sent: Array<Parameters<HandoffDesk["send"]>[0]> = [];
  const desk: HandoffDesk = {
    async send(input) {
      sent.push(input);
      return { ok: true, to: input.target, toName: input.target };
    },
  };
  const channels = {
    // Only the person's own channel exists; anyone else's reads as not found.
    get: async (_actor: unknown, id: string) =>
      id === "team"
        ? {
            id: "team",
            agentIds: ["chief", "marketing", "sales", "accounting"],
            threadId: "thread-team",
          }
        : null,
  } as unknown as ChannelStore;
  const auditStore = { insert: async () => {} } as unknown as AuditStore;
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.route(
    "/",
    createFanoutRoutes({
      channels,
      desk,
      auditStore,
      encryptionKey: KEY,
      requireUser,
    }),
  );
  const post = (channel: string, body: unknown) =>
    routes.request(`/${channel}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { post, sent };
}

describe("asking several colleagues in one message (desk #87)", () => {
  test("asks each one, as the lead's run in this channel's thread, with the person's words", async () => {
    const { post, sent } = app();

    const response = await post("team", {
      leadId: "chief",
      targets: ["marketing", "sales"],
      text: "What do we need for the Athens fair?",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      asked: ["marketing", "sales"],
      refused: [],
    });
    expect(sent).toHaveLength(2);
    for (const input of sent) {
      expect(input.from).toMatchObject({
        botId: "chief",
        actorId: "user-1",
        threadId: "thread-team",
        depth: 0,
      });
      expect(input.envelope).toEqual({
        task: "What do we need for the Athens fair?",
        fanout: true,
      });
    }
  });

  test("another person's channel is not found, and nothing is asked", async () => {
    const { post, sent } = app();

    const response = await post("someone-elses", {
      leadId: "chief",
      targets: ["marketing", "sales"],
      text: "hello",
    });

    expect(response.status).toBe(404);
    expect(sent).toHaveLength(0);
  });

  test("a colleague who is not in the channel cannot be asked through it", async () => {
    const { post, sent } = app();

    const response = await post("team", {
      leadId: "chief",
      targets: ["marketing", "legal"],
      text: "hello",
    });

    expect(response.status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  test("one colleague is not a fan-out, and an empty message is not a question", async () => {
    const { post, sent } = app();

    expect(
      (await post("team", { leadId: "chief", targets: ["sales"], text: "hi" }))
        .status,
    ).toBe(400);
    expect(
      (
        await post("team", {
          leadId: "chief",
          targets: ["sales", "marketing"],
          text: "   ",
        })
      ).status,
    ).toBe(400);
    expect(sent).toHaveLength(0);
  });
});
