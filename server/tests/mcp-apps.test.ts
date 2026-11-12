import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createMcpAppRoutes, toolRef } from "../src/plugins/apps-routes";
import { uiResourceOf } from "../src/plugins/mcp";

describe("MCP Apps: which tools have an interface (9B)", () => {
  test("the current _meta.ui.resourceUri and the earlier flat key are both read", () => {
    expect(
      uiResourceOf({ ui: { resourceUri: "ui://weather/forecast" } }),
    ).toEqual({
      uiResourceUri: "ui://weather/forecast",
    });
    expect(uiResourceOf({ "ui/resourceUri": "ui://weather/forecast" })).toEqual(
      {
        uiResourceUri: "ui://weather/forecast",
      },
    );
  });

  test("only a ui:// address on the same server is kept", () => {
    expect(
      uiResourceOf({ ui: { resourceUri: "https://evil.example/app.html" } }),
    ).toEqual({});
    expect(uiResourceOf({ ui: { resourceUri: 42 } })).toEqual({});
    expect(uiResourceOf(undefined)).toEqual({});
  });

  test("a call is named mcp__<server>__<tool>, and nothing else is asked about", () => {
    expect(toolRef("mcp__weather__get_forecast")).toEqual({
      serverId: "weather",
      toolName: "get_forecast",
    });
    expect(toolRef("askApproval")).toBeNull();
    expect(toolRef("mcp__weather__")).toBeNull();
  });
});

describe("the interface route", () => {
  const allow = async (
    context: { set: (key: "actor", value: unknown) => void },
    next: () => Promise<void>,
  ) => {
    context.set("actor", { id: "user-1", role: "user" });
    await next();
  };

  function app(answer: string | null | Error) {
    const asked: unknown[] = [];
    const routes = createMcpAppRoutes({
      store: {
        toolInterface: async (input) => {
          asked.push(input);
          if (answer instanceof Error) throw answer;
          return answer;
        },
      },
      // biome-ignore lint/suspicious/noExplicitAny: a test double for the session middleware
      requireUser: allow as any,
    });
    return { app: new Hono().route("/api/mcp-apps", routes), asked };
  }

  test("hands back the HTML, asked as the signed-in person", async () => {
    const { app: server, asked } = app("<p>forecast</p>");
    const response = await server.request(
      "/api/mcp-apps/interface?tool=mcp__weather__get_forecast",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ html: "<p>forecast</p>" });
    expect(asked).toEqual([
      { serverId: "weather", toolName: "get_forecast", actorId: "user-1" },
    ]);
  });

  test("no interface, or a server that will not answer, is a 204 and the text is drawn", async () => {
    expect(
      (await app(null).app.request("/api/mcp-apps/interface?tool=mcp__a__b"))
        .status,
    ).toBe(204);
    expect(
      (
        await app(new Error("down")).app.request(
          "/api/mcp-apps/interface?tool=mcp__a__b",
        )
      ).status,
    ).toBe(204);
    expect(
      (await app(null).app.request("/api/mcp-apps/interface?tool=x")).status,
    ).toBe(400);
  });
});
