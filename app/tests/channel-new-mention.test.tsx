import "./channel-new-error-state.fixture";

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { Route as ChannelNewRoute } from "@/routes/_authed/_app/channel/new";

/**
 * The `@` menu on `/channel/new`, the screen a conversation with an employee starts on.
 *
 * The DT Lab (v0.1.17, step 5) opened the hired Customer Support, typed `@Chief` to reach the Chief
 * of Operations, and the menu said "No agents in this channel": this screen passed the composer no
 * roster at all. Sent anyway, the message went to Customer Support. v0.1.17 had wired every employee
 * into the `@` menu of an open conversation and tested a typed-out `@Chief of Operations` there, but
 * never the menu, and never this screen. These drive the menu the way the person did.
 */

/**
 * A caret with a size. prompt-area places its menu under the caret, measured with
 * `Range.getBoundingClientRect()`, and draws no menu at all when that rect is empty. happy-dom does
 * no layout, so every rect is zeros and no `@` menu would ever open in a test; a browser always has
 * one. The rect's numbers do not matter, only that there is one.
 */
let originalRangeRect: Range["getBoundingClientRect"];

beforeAll(() => {
  GlobalRegistrator.register();
  originalRangeRect = Range.prototype.getBoundingClientRect;
  Range.prototype.getBoundingClientRect = () =>
    DOMRect.fromRect({ x: 40, y: 600, width: 1, height: 18 });
});

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  cleanup();
});

afterAll(() => {
  Range.prototype.getBoundingClientRect = originalRangeRect;
  GlobalRegistrator.unregister();
});

function agent(
  overrides: Partial<AgentProfile> & { id: string; name: string },
): AgentProfile {
  return {
    runLocation: "cloud",
    avatarSeed: "seed",
    avatarImage: null,
    builtIn: false,
    canManage: true,
    endpoint: null,
    hasAuth: false,
    hasCallbackToken: false,
    hidden: false,
    mine: true,
    roleDescription: "Role",
    systemOwned: false,
    title: "Title",
    visibility: "private",
    ...overrides,
  };
}

const CHIEF = agent({
  id: "chief",
  name: "Chief of Operations",
  title: "Operations",
  primary: true,
});
const SUPPORT = agent({
  id: "support",
  name: "Customer Support",
  title: "Support",
});

const rootRoute = createRootRoute({ component: Outlet });
const authedRoute = createRoute({
  id: "/_authed",
  getParentRoute: () => rootRoute,
  component: Outlet,
});
const appRoute = createRoute({
  id: "/_app",
  getParentRoute: () => authedRoute,
  component: Outlet,
});
type TestFileRouteWiring = Parameters<typeof ChannelNewRoute.update>[0] & {
  id: string;
  path: string;
  getParentRoute: () => typeof appRoute;
};
const testChannelNewRoute = ChannelNewRoute.update({
  id: "/channel/new",
  path: "/channel/new",
  getParentRoute: () => appRoute,
} as TestFileRouteWiring);
// Where `startChosen` navigates once the channel exists, so the router has somewhere to land.
const channelRoute = createRoute({
  path: "/channel/$channelId",
  getParentRoute: () => appRoute,
  component: () => <p>channel opened</p>,
});
const routeTree = rootRoute.addChildren([
  authedRoute.addChildren([
    appRoute.addChildren([testChannelNewRoute, channelRoute]),
  ]),
]);

/** Records who each started conversation is with; every other call answers as an empty success. */
function installFetch(starts: string[][]) {
  global.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/route") {
        return Response.json({ error: "not needed here" }, { status: 503 });
      }
      if (url === "/api/channels" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { agentIds: string[] };
        starts.push(body.agentIds);
        return Response.json({
          channel: {
            busy: false,
            id: `channel-${starts.length}`,
            lastMessage: null,
            lastMessageAt: null,
            participantIds: body.agentIds,
            pinned: false,
            threadId: `thread-${starts.length}`,
            title: null,
            unread: false,
          },
        });
      }
      return Response.json({});
    },
    { preconnect: originalFetch.preconnect },
  );
}

/**
 * Types into the composer and leaves the caret after what was typed, as a browser does.
 *
 * prompt-area opens a trigger's menu from the caret it reads off `window.getSelection()`, and
 * user-event does not move the document selection into a contenteditable under happy-dom — so the
 * text arrives, the caret does not, and no menu would open on this screen or any other. The caret is
 * put where the person's would be and the editor told, once, that its content changed.
 */
async function typeAtCaret(
  user: ReturnType<typeof userEvent.setup>,
  editor: HTMLElement,
  text: string,
) {
  await user.type(editor, text);
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  fireEvent.input(editor);
}

function renderChannelNew(queryClient: QueryClient, initialEntry: string) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function queryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
}

test("/channel/new lists the person's employees in the @ menu and sends to the one picked", async () => {
  const starts: string[][] = [];
  installFetch(starts);
  const client = queryClient();
  client.setQueryData(agentKeys.list(false), [CHIEF, SUPPORT]);
  const view = renderChannelNew(client, "/channel/new?agent=support");
  const user = userEvent.setup({ document: view.container.ownerDocument });

  const editor = await view.findByRole("textbox", { name: "Message" });
  await typeAtCaret(user, editor, "@Chief");

  const option = await view.findByRole("option", {
    name: /Chief of Operations/,
  });
  expect(view.queryByText("No agents in this channel")).toBeNull();
  expect(view.queryByText("No matching digital employees")).toBeNull();

  await user.click(option);
  await user.type(editor, " what is on today?");
  await user.click(await view.findByRole("button", { name: "Send message" }));

  // The conversation starts with the employee picked from the menu, not with Customer Support.
  await waitFor(() => expect(starts).toEqual([["chief"]]));
});

test("/channel/new fills the @ menu once the roster arrives after the composer mounted", async () => {
  const starts: string[][] = [];
  installFetch(starts);
  const client = queryClient();
  // The roster changes under an open screen (a refetch, an employee hired in another tab). The
  // menu must follow it rather than keep the list the editor was first built with — one of the
  // suspects for the empty menu, ruled out here so it cannot quietly become the next one.
  client.setQueryData(agentKeys.list(false), [SUPPORT]);
  const view = renderChannelNew(client, "/channel/new?agent=support");
  const user = userEvent.setup({ document: view.container.ownerDocument });
  const editor = await view.findByRole("textbox", { name: "Message" });

  client.setQueryData(agentKeys.list(false), [CHIEF, SUPPORT]);
  await typeAtCaret(user, editor, "@Chief");

  expect(
    await view.findByRole("option", { name: /Chief of Operations/ }),
  ).toBeTruthy();
});

test("/channel/new still sends an un-addressed message to the To: recipient", async () => {
  const starts: string[][] = [];
  installFetch(starts);
  const client = queryClient();
  client.setQueryData(agentKeys.list(false), [CHIEF, SUPPORT]);
  const view = renderChannelNew(client, "/channel/new?agent=support");
  const user = userEvent.setup({ document: view.container.ownerDocument });

  await user.type(
    await view.findByRole("textbox", { name: "Message" }),
    "where is my order?",
  );
  await user.click(await view.findByRole("button", { name: "Send message" }));

  await waitFor(() => expect(starts).toEqual([["support"]]));
});
