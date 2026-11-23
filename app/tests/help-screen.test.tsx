import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SupportPayload, SupportRequest } from "@/lib/support/queries";
import { Route as HelpRoute } from "@/routes/_authed/settings/help";

/**
 * Settings, then Help & support (#149): the person sees exactly what will be sent before anything
 * leaves the computer, and gets BlackArk's case number back. Held against a fake server.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  // React's queued work (the replies query among it) reads `window`: let it run before the page
  // goes (see store-app.test.tsx).
  await new Promise((resolve) => setTimeout(resolve, 50));
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const SLOW = { timeout: 5000 };

const payload: SupportPayload = {
  requestId: "11111111-2222-4333-8444-555555555555",
  customerId: "demo-shop",
  installId: "aaaa1111-0000-4000-8000-000000000001",
  appVersion: "0.1.49",
  language: "en",
  subject: "Mail stopped",
  message: "The mail employee cannot sign in since this morning.",
  urgent: true,
  diagnostics: {
    appVersion: "0.1.49",
    os: "Windows 10.0.22631 (x64)",
    logs: [
      "2026-11-18T09:59:00.000Z error mailbox sign-in refused for [email]",
    ],
  },
  proof: { kind: "profile", profile: "eyJ2IjoxfQ", signature: "c2lnbmF0dXJl" },
};

const sent: SupportRequest = {
  id: payload.requestId,
  subject: payload.subject,
  status: "sent",
  caseNumber: 7,
  createdAt: "2026-11-18T10:00:00.000Z",
  sentAt: "2026-11-18T10:00:01.000Z",
  lastError: null,
  payload,
};

type Calls = Array<{ method: string; url: string; body?: unknown }>;

function serve(
  state: { available: boolean; requests: SupportRequest[] },
  calls: Calls = [],
) {
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      method: init?.method ?? "GET",
      url,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    if (url.endsWith("/api/support/preview")) return Response.json({ payload });
    if (url.endsWith("/api/support/requests"))
      return Response.json({ request: sent }, { status: 201 });
    if (url.endsWith("/api/support")) return Response.json(state);
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
  return calls;
}

function renderHelp() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createRouter({
    routeTree: createRootRoute({
      component: HelpRoute.options.component as never,
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("before this computer is activated, it says so and offers nothing to send", async () => {
  serve({ available: false, requests: [] });
  const screen = renderHelp();
  expect(
    await screen.findByText(/needs this computer to be activated/, {}, SLOW),
  ).toBeTruthy();
  expect(screen.queryByText("Write to BlackArk")).toBeNull();
});

test("shows what will be sent, sends exactly that, and gives the case number", async () => {
  const calls = serve({ available: true, requests: [] });
  const screen = renderHelp();
  const user = userEvent.setup({ document });
  await user.click(await screen.findByText("Write to BlackArk", {}, SLOW));
  await user.type(screen.getByLabelText("Subject"), "Mail stopped");
  await user.type(
    screen.getByLabelText("What happened"),
    "The mail employee cannot sign in since this morning.",
  );
  // Base UI draws the checkbox and a hidden input under the same label; the first is the one shown.
  await user.click(screen.getAllByLabelText("It stops our work")[0] as Element);
  await user.click(
    screen.getAllByLabelText(/Include diagnostics/)[0] as Element,
  );
  await user.click(
    screen.getByRole("button", { name: "See what will be sent" }),
  );

  expect(
    await screen.findByText("This is what will be sent", {}, SLOW),
  ).toBeTruthy();
  expect(
    screen.getByText("Nothing has left this computer yet.", { exact: false }),
  ).toBeTruthy();
  expect(
    screen.getByText(/mailbox sign-in refused for \[email\]/),
  ).toBeTruthy();
  expect(screen.getByText("demo-shop")).toBeTruthy();
  // Only the preview was asked for so far: nothing was sent.
  expect(
    calls.filter((call) => call.url.endsWith("/api/support/requests")),
  ).toHaveLength(0);
  expect(calls.find((call) => call.url.endsWith("/preview"))?.body).toEqual({
    subject: "Mail stopped",
    message: "The mail employee cannot sign in since this morning.",
    urgent: true,
    includeDiagnostics: true,
    language: "en",
  });

  await user.click(screen.getByRole("button", { name: "Send to BlackArk" }));
  expect(
    await screen.findByText(/Your case number is #7/, {}, SLOW),
  ).toBeTruthy();
  await waitFor(() =>
    expect(
      (
        calls.find((call) => call.url.endsWith("/api/support/requests"))
          ?.body as { previewId?: string }
      )?.previewId,
    ).toBe(payload.requestId),
  );
});

test("lists the person's requests with their case number, or that they wait to be sent", async () => {
  serve({
    available: true,
    requests: [
      sent,
      {
        ...sent,
        id: "22222222-2222-4333-8444-555555555555",
        subject: "Phone line silent",
        status: "queued",
        caseNumber: null,
        sentAt: null,
        lastError: "BlackArk could not be reached. It will be sent again.",
      },
    ],
  });
  const screen = renderHelp();
  expect(await screen.findByText("Case #7", {}, SLOW)).toBeTruthy();
  expect(screen.getByText("Waiting to be sent")).toBeTruthy();
  expect(
    screen.getByText("BlackArk could not be reached. It will be sent again."),
  ).toBeTruthy();
});
