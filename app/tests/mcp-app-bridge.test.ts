import { describe, expect, test } from "bun:test";
import {
  ASK_GAP_MS,
  createBridge,
  FRAME_POLICY,
  MAX_ASKS,
  MAX_HEIGHT,
  withPolicy,
} from "@/lib/plugins/mcp-app-bridge";

function harness(result?: string) {
  const posted: Record<string, unknown>[] = [];
  const asked: string[] = [];
  const opened: string[] = [];
  const heights: number[] = [];
  let clock = 0;
  const bridge = createBridge(
    {
      post: (message) => posted.push(message),
      ask: (text) => asked.push(text),
      open: (url) => opened.push(url),
      resize: (height) => heights.push(height),
      now: () => clock,
    },
    {
      name: "mcp__weather__forecast",
      arguments: { city: "Athens" },
      ...(result ? { result } : {}),
    },
  );
  const tick = (ms: number) => {
    clock += ms;
  };
  return { bridge, posted, asked, opened, heights, tick };
}

const rpc = (
  method: string,
  params: unknown = {},
  id: number | undefined = 1,
) => ({
  jsonrpc: "2.0",
  ...(id === undefined ? {} : { id }),
  method,
  params,
});

describe("the MCP Apps bridge (9B)", () => {
  test("answers the handshake, then hands over the call's arguments and its result", () => {
    const { bridge, posted } = harness("Sunny, 21°C");
    bridge.receive(rpc("ui/initialize"));
    expect(posted[0]).toMatchObject({
      id: 1,
      result: { hostInfo: { name: "ArkAgent" } },
    });
    bridge.receive(rpc("ui/notifications/initialized", {}, undefined));
    expect(posted[1]).toEqual({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-input",
      params: { arguments: { city: "Athens" } },
    });
    expect(posted[2]).toMatchObject({
      method: "ui/notifications/tool-result",
      params: { content: [{ type: "text", text: "Sunny, 21°C" }] },
    });
  });

  test("a result that arrives later is sent once it is there, and only once", () => {
    const { bridge, posted } = harness();
    bridge.receive(rpc("ui/notifications/initialized", {}, undefined));
    expect(posted).toHaveLength(1);
    bridge.update({ name: "x", arguments: {}, result: "done" });
    bridge.update({ name: "x", arguments: {}, result: "done" });
    expect(
      posted.filter((m) => m.method === "ui/notifications/tool-result"),
    ).toHaveLength(1);
  });

  test("a tool call is put to the conversation, never run from the frame", () => {
    const { bridge, posted, asked } = harness();
    bridge.receive(
      rpc("tools/call", { name: "delete_city", arguments: { id: 7 } }, 9),
    );
    expect(asked).toEqual([
      'Please call the delete_city tool with these arguments: {"id":7}',
    ]);
    expect(posted[0]).toMatchObject({ id: 9, result: { isError: false } });
  });

  test("messages are rate-limited: never two at once, and a ceiling per app", () => {
    const { bridge, asked, posted, tick } = harness();
    bridge.receive(
      rpc("ui/message", { content: [{ type: "text", text: "one" }] }, 1),
    );
    bridge.receive(
      rpc("ui/message", { content: [{ type: "text", text: "two" }] }, 2),
    );
    expect(asked).toEqual(["one"]);
    expect(posted[1]).toMatchObject({ id: 2, error: { code: -32000 } });
    for (let index = 0; index < MAX_ASKS + 3; index++) {
      tick(ASK_GAP_MS);
      bridge.receive(rpc("ui/message", { content: "again" }, 10 + index));
    }
    expect(asked).toHaveLength(MAX_ASKS);
  });

  test("only https links are opened, heights are bounded, and anything else is refused", () => {
    const { bridge, opened, heights, posted } = harness();
    bridge.receive(rpc("ui/open-link", { url: "javascript:alert(1)" }, 1));
    bridge.receive(
      rpc("ui/open-link", { url: "https://example.com/forecast" }, 2),
    );
    expect(opened).toEqual(["https://example.com/forecast"]);
    bridge.receive(
      rpc("ui/notifications/size-changed", { height: 99_999 }, undefined),
    );
    expect(heights).toEqual([MAX_HEIGHT]);
    bridge.receive(rpc("resources/read", { uri: "ui://other" }, 5));
    expect(posted.at(-1)).toMatchObject({ id: 5, error: { code: -32601 } });
    bridge.receive({ hello: "not json-rpc" });
  });
});

describe("the frame's policy", () => {
  test("comes first, after a doctype if there is one, so nothing the app wrote runs before it", () => {
    const meta = `<meta http-equiv="Content-Security-Policy" content="${FRAME_POLICY}">`;
    expect(withPolicy("<!DOCTYPE html><html><head><script>1</script>")).toBe(
      `<!DOCTYPE html>${meta}<html><head><script>1</script>`,
    );
    expect(withPolicy("<script>1</script><p>x</p>")).toBe(
      `${meta}<script>1</script><p>x</p>`,
    );
    expect(FRAME_POLICY).toContain("connect-src 'none'");
    expect(FRAME_POLICY).toContain("default-src 'none'");
  });
});
