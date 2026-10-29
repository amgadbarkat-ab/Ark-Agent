import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";

/**
 * The person's own Chrome or Edge as a digital employee's computer (device control, phase 1).
 *
 * The switch itself lives in the desktop app and nowhere here: this only reads whether it is on, and
 * says which employees work in that browser.
 */

export type OwnBrowserChoice = {
  botId: string;
  actorId: string;
  since: string;
  /** When an action last reached the person's browser for this employee. */
  activeAt: string | null;
};

export type OwnBrowserStatus = {
  /** Running in the desktop app, the only place this exists. */
  desktop: boolean;
  /** Switched on in the desktop app right now. */
  available: boolean;
  employees: OwnBrowserChoice[];
};

/** What a deployment without the desktop app has: nothing to offer, and nothing to show. */
const NOT_HERE: OwnBrowserStatus = {
  desktop: false,
  available: false,
  employees: [],
};

/** "Driving now" means an action reached the browser within this long. */
export const DRIVING_WINDOW_MS = 30_000;

export function isDriving(choice: OwnBrowserChoice, now = Date.now()) {
  return (
    choice.activeAt !== null &&
    now - new Date(choice.activeAt).getTime() < DRIVING_WINDOW_MS
  );
}

export const ownBrowserKeys = {
  all: ["own-browser"] as const,
  status: () => ["own-browser", "status"] as const,
};

export function ownBrowserQueryOptions() {
  return queryOptions({
    queryKey: ownBrowserKeys.status(),
    // Often, because this is what the "working in your browser" indicator is drawn from; and not at
    // all where there is no desktop app, since the answer there never changes.
    refetchInterval: (query) => (query.state.data?.desktop ? 3_000 : false),
    queryFn: async (): Promise<OwnBrowserStatus> => {
      // A hosted deployment does not mount the route at all. That is "not here", not an error.
      const response = await tryClient("/api/own-browser");
      if (response.status === 404) return NOT_HERE;
      if (!response.ok)
        throw new Error("Your own browser's status could not be read.");
      return (await response.json()) as OwnBrowserStatus;
    },
  });
}

function invalidate(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: ownBrowserKeys.all });
}

export function setOwnBrowserEmployeeMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: { botId: string; use: boolean }) =>
      client(
        `/api/own-browser/employees/${encodeURIComponent(variables.botId)}`,
        {
          method: "PUT",
          body: { use: variables.use },
          fallback: "That digital employee could not be moved.",
        },
      ).then((response) => response.json() as Promise<OwnBrowserStatus>),
    onSettled: () => invalidate(queryClient),
  });
}

export function stopOwnBrowserMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: () =>
      client("/api/own-browser/stop", {
        method: "POST",
        fallback: "Your browser could not be stopped.",
      }).then((response) => response.json() as Promise<OwnBrowserStatus>),
    onSettled: () => invalidate(queryClient),
  });
}
