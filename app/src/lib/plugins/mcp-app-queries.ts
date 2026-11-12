import { queryOptions } from "@tanstack/react-query";
import { tryClient } from "@/lib/client";

/**
 * Whether this deployment draws MCP Apps (9B). Asked once: the routes exist only when an
 * administrator turned `MCP_APPS_ENABLED` on, so anything but a yes is off.
 */
export function mcpAppsEnabledQueryOptions() {
  return queryOptions({
    queryKey: ["mcp-apps", "enabled"],
    queryFn: async (): Promise<boolean> => {
      const response = await tryClient("/api/mcp-apps").catch(() => null);
      return response?.ok === true;
    },
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

/** A tool's interface, or null when it has none. Kept for ten minutes per tool. */
export function mcpAppInterfaceQueryOptions(tool: string, enabled: boolean) {
  return queryOptions({
    queryKey: ["mcp-apps", "interface", tool],
    queryFn: async (): Promise<string | null> => {
      const response = await tryClient(
        `/api/mcp-apps/interface?tool=${encodeURIComponent(tool)}`,
      ).catch(() => null);
      if (response?.status !== 200) return null;
      const body = (await response.json().catch(() => null)) as {
        html?: unknown;
      } | null;
      return typeof body?.html === "string" ? body.html : null;
    },
    enabled,
    staleTime: 10 * 60_000,
    retry: false,
  });
}
