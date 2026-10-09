import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type AuthenticatedUser, needsTerms } from "@/lib/auth/queries";
import { queryClient } from "@/query-client";
import { Route as AcceptRoute } from "@/routes/_authed/accept-terms";
import { Route as TermsRoute } from "@/routes/terms";

/**
 * The terms of service: a public page that is the file the lawyer edits, and the one screen somebody
 * can see before they have accepted. Acceptance is an act: the box has to be ticked, the version on
 * screen is the version sent, and a refusal because the text has changed is shown rather than hidden.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterEach(() => queryClient.clear());
const originalDefaults = queryClient.getDefaultOptions();
afterAll(() => queryClient.setDefaultOptions(originalDefaults));
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const SLOW = { timeout: 5000 };

const user = (terms: AuthenticatedUser["terms"]): AuthenticatedUser => ({
  id: "u1",
  email: "ann@example.test",
  name: "Ann",
  role: "user",
  onboarding: null,
  terms,
});

test("the gate holds only when the terms are required and this version is not yet accepted", () => {
  const accepted = "2026-11-02T10:00:00.000Z";
  expect(
    needsTerms(user({ version: "v1", required: true, acceptedAt: null })),
  ).toBe(true);
  expect(
    needsTerms(user({ version: "v1", required: true, acceptedAt: accepted })),
  ).toBe(false);
  // Not asked: the deployment does not require it, or the person is staff.
  expect(
    needsTerms(user({ version: "v1", required: false, acceptedAt: null })),
  ).toBe(false);
  expect(needsTerms(user(null))).toBe(false);
  // A server that predates the field sends none.
  expect(needsTerms({ ...user(null), terms: undefined } as never)).toBe(false);
});

test("the public terms page is the document, with its draft banner and its sections", async () => {
  const router = createRouter({
    routeTree: createRootRoute({
      component: TermsRoute.options.component as never,
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const screen = render(<RouterProvider router={router as never} />);

  const heading = await screen.findByRole(
    "heading",
    { name: "Terms of service" },
    SLOW,
  );
  expect(heading.tagName).toBe("H1");
  const text = (document.body.textContent ?? "").replace(/\s+/g, " ");
  expect(text).toContain("Value Data IKE");
  expect(text).toContain("DRAFT for review by a lawyer");
  // The promise that matters most to a customer is there in so many words.
  expect(text).toContain(
    "We do not use your conversations or files to train AI models",
  );
});

type Call = { method: string; url: string; body?: Record<string, unknown> };

function serve(
  calls: Call[],
  accept: () => Response = () =>
    Response.json({
      terms: {
        version: "v1",
        required: true,
        acceptedAt: "2026-11-02T10:00:00.000Z",
      },
    }),
) {
  let accepted = false;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    if (url.endsWith("/api/me/terms")) {
      const answer = accept();
      if (answer.ok) accepted = true;
      return answer;
    }
    if (url.endsWith("/api/me")) {
      return Response.json({
        user: user({
          version: "v1",
          required: true,
          acceptedAt: accepted ? "2026-11-02T10:00:00.000Z" : null,
        }),
      });
    }
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
}

function renderAccept() {
  queryClient.setDefaultOptions({ queries: { retry: false } });
  // The screen's component alone: the route's own guard needs the app's router context, and what is
  // under test here is what the screen does. "/" is where it sends somebody on, and is blank here.
  const router = createRouter({
    routeTree: createRootRoute({
      component: AcceptRoute.options.component as never,
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("the button stays off until the box is ticked, then sends the version on screen", async () => {
  const calls: Call[] = [];
  serve(calls);
  const screen = renderAccept();
  const person = userEvent.setup({ document });

  const button = (await screen.findByRole(
    "button",
    { name: "Agree and continue" },
    SLOW,
  )) as HTMLButtonElement;
  await waitFor(() => expect(screen.getByText(/version v1/)).toBeTruthy());
  expect(button.disabled).toBe(true);

  await person.click(screen.getByRole("checkbox"));
  expect(button.disabled).toBe(false);
  await person.click(button);

  await waitFor(() =>
    expect(calls.some((call) => call.url.endsWith("/api/me/terms"))).toBe(true),
  );
  const sent = calls.find((call) => call.url.endsWith("/api/me/terms"));
  expect(sent?.method).toBe("POST");
  expect(sent?.body).toEqual({ version: "v1" });
});

test("a refusal because the text changed is shown, and nothing moves on", async () => {
  const calls: Call[] = [];
  serve(calls, () =>
    Response.json(
      {
        error:
          "These terms have changed since you opened them. Read the current version and accept that.",
        version: "v2",
      },
      { status: 409 },
    ),
  );
  const screen = renderAccept();
  const person = userEvent.setup({ document });

  await screen.findByRole("button", { name: "Agree and continue" }, SLOW);
  await person.click(screen.getByRole("checkbox"));
  await person.click(
    screen.getByRole("button", { name: "Agree and continue" }),
  );

  const alert = await screen.findByRole("alert", {}, SLOW);
  expect(alert.textContent).toContain("These terms have changed");
  expect(
    screen.getByRole("button", { name: "Agree and continue" }),
  ).toBeTruthy();
});

test("the terms and the privacy notice are one click away, in their own tab", async () => {
  serve([]);
  const screen = renderAccept();

  const terms = (await screen.findByText(
    "Read the terms of service",
    {},
    SLOW,
  )) as HTMLAnchorElement;
  expect(terms.getAttribute("href")).toBe("/terms");
  expect(terms.getAttribute("target")).toBe("_blank");
  expect(
    (screen.getByText("Privacy notice") as HTMLAnchorElement).getAttribute(
      "href",
    ),
  ).toBe("/privacy");
});
