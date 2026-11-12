import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useConversation } from "@/lib/copilot/conversation";
import { openInBrowser } from "@/lib/external-links";
import { createBridge, withPolicy } from "@/lib/plugins/mcp-app-bridge";
import {
  mcpAppInterfaceQueryOptions,
  mcpAppsEnabledQueryOptions,
} from "@/lib/plugins/mcp-app-queries";

/**
 * An MCP server's own interface for one tool call, drawn in the chat (P2 idea 9B). Nothing is drawn
 * unless an administrator turned MCP Apps on and the tool's server offers an interface.
 *
 * LOCKED DOWN. The frame is `sandbox="allow-scripts"` with no same-origin, so it is its own opaque
 * origin: no cookies, no session, no access to this page or any other conversation. Its HTML
 * carries a policy that allows no network requests at all. It can only post messages to this page,
 * and `mcp-app-bridge.ts` decides what each one may do.
 */
export function McpAppFrame({
  name,
  args,
  result,
}: {
  name: string;
  args: string;
  result?: string;
}) {
  const enabled = useQuery(mcpAppsEnabledQueryOptions());
  const html = useQuery(
    mcpAppInterfaceQueryOptions(name, enabled.data === true),
  );
  if (!html.data) return null;
  return <AppFrame args={args} html={html.data} name={name} result={result} />;
}

function parsedArgs(args: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(args);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function AppFrame({
  html,
  name,
  args,
  result,
}: {
  html: string;
  name: string;
  args: string;
  result?: string;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const conversation = useConversation();
  const [height, setHeight] = useState(240);
  const document = useMemo(() => withPolicy(html), [html]);
  const ask = conversation?.ask;

  const bridge = useMemo(
    () =>
      createBridge(
        {
          post: (message) =>
            // An opaque origin has no name to address it by, so "*" — and only to this frame.
            frame.current?.contentWindow?.postMessage(message, "*"),
          ask: (text) => ask?.(text),
          open: (url) => {
            if (!openInBrowser(url)) {
              window.open(url, "_blank", "noopener,noreferrer");
            }
          },
          resize: setHeight,
        },
        // The result is handed over by `update` below, whenever it arrives.
        { name, arguments: parsedArgs(args) },
      ),
    [name, args, ask],
  );

  useEffect(() => {
    bridge.update({
      name,
      arguments: parsedArgs(args),
      ...(result ? { result } : {}),
    });
  }, [bridge, name, args, result]);

  useEffect(() => {
    const listen = (event: MessageEvent) => {
      // Only this frame's own messages; every other window on the page is ignored.
      if (event.source !== frame.current?.contentWindow) return;
      bridge.receive(event.data);
    };
    window.addEventListener("message", listen);
    return () => window.removeEventListener("message", listen);
  }, [bridge]);

  return (
    <iframe
      className="my-1.5 w-full rounded-md border bg-background"
      ref={frame}
      referrerPolicy="no-referrer"
      sandbox="allow-scripts"
      srcDoc={document}
      style={{ height }}
      title={`${name} app`}
    />
  );
}
