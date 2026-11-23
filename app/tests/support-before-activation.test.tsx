import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SupportPayload, SupportRequest } from "@/lib/support/queries";
import { ActivateHelp } from "@/routes/_authed/activate";

/** As the app draws it: inside the router and a query client (the dialog needs both here). */
function inClient(node: React.ReactNode) {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => node }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return (
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RouterProvider router={router as never} />
    </QueryClientProvider>
  );
}

/**
 * Help & support before activation (Amgad, 23 Nov 2026): on the Activate screen, somebody stuck can
 * still write to BlackArk. Nothing proves whose computer it is, so they may give an email address,
 * and they see that BlackArk will treat it as unverified before anything is sent.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  // React's queued work reads `window`: let it run before the page goes (see store-app.test.tsx).
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
  customerId: "unverified",
  installId: "bbbb2222-0000-4000-8000-000000000002",
  appVersion: "0.1.52",
  language: "en",
  subject: "I cannot activate",
  message: "The trial code I was given is refused.",
  urgent: false,
  diagnostics: null,
  proof: null,
  contactEmail: "maria@shop.example",
};

const sent: SupportRequest = {
  id: payload.requestId,
  subject: payload.subject,
  status: "sent",
  caseNumber: 12,
  createdAt: "2026-11-24T10:00:00.000Z",
  sentAt: "2026-11-24T10:00:01.000Z",
  lastError: null,
  payload,
};

function serve(verified = false) {
  const calls: Array<{ url: string; body?: unknown }> = [];
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    if (url.endsWith("/api/support/preview")) return Response.json({ payload });
    if (url.endsWith("/api/support/requests"))
      return Response.json({ request: sent }, { status: 201 });
    if (url.endsWith("/api/support"))
      return Response.json({ available: true, verified, requests: [] });
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
  return calls;
}

test("asks for an optional email, shows the request as unverified, and sends exactly that", async () => {
  const calls = serve();
  const screen = render(inClient(<ActivateHelp />));
  const user = userEvent.setup({ document });
  await user.click(
    await screen.findByText("Need help? Write to BlackArk", {}, SLOW),
  );
  await user.type(
    await screen.findByLabelText("Subject", {}, SLOW),
    "I cannot activate",
  );
  await user.type(
    screen.getByLabelText("What happened"),
    "The trial code I was given is refused.",
  );
  expect(
    screen.getByText(/BlackArk cannot tell whose it is/, { exact: false }),
  ).toBeTruthy();

  // Not an address: nothing can be previewed until it is one, or empty.
  await user.type(
    screen.getByLabelText("Your email (optional)"),
    "maria at shop",
  );
  expect(
    (
      screen.getByRole("button", {
        name: "See what will be sent",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  await user.clear(screen.getByLabelText("Your email (optional)"));
  await user.type(
    screen.getByLabelText("Your email (optional)"),
    "maria@shop.example",
  );
  await user.click(
    screen.getByRole("button", { name: "See what will be sent" }),
  );

  expect(
    await screen.findByText("This is what will be sent", {}, SLOW),
  ).toBeTruthy();
  expect(screen.getByText("Not known yet: not activated")).toBeTruthy();
  expect(screen.getByText("maria@shop.example")).toBeTruthy();
  expect(
    screen.getByText(/BlackArk sees this request as unverified/),
  ).toBeTruthy();
  expect(calls.find((call) => call.url.endsWith("/preview"))?.body).toEqual({
    subject: "I cannot activate",
    message: "The trial code I was given is refused.",
    urgent: false,
    includeDiagnostics: false,
    language: "en",
    contactEmail: "maria@shop.example",
  });

  await user.click(screen.getByRole("button", { name: "Send to BlackArk" }));
  expect(
    await screen.findByText(/Your case number is #12/, {}, SLOW),
  ).toBeTruthy();
});

test("once activated (verified), the same dialog asks for no email", async () => {
  serve(true);
  const screen = render(inClient(<ActivateHelp />));
  await userEvent
    .setup({ document })
    .click(await screen.findByText("Need help? Write to BlackArk", {}, SLOW));
  expect(await screen.findByLabelText("Subject", {}, SLOW)).toBeTruthy();
  expect(screen.queryByLabelText("Your email (optional)")).toBeNull();
});
