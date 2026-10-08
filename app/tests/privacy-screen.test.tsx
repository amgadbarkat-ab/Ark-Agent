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
import { Route as PeopleRoute } from "@/routes/_authed/admin/people";
import { Route as PrivacyRoute } from "@/routes/_authed/settings/privacy";

/**
 * The two places somebody's data can be asked for or removed: their own page, and the staff screen for
 * somebody who wrote to us. Neither may do anything final without the address being typed.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const SLOW = { timeout: 5000 };

type Call = { method: string; url: string; body?: unknown };

function serve(calls: Call[], extra: Record<string, () => Response> = {}) {
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      method: init?.method ?? "GET",
      url,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    for (const [suffix, answer] of Object.entries(extra)) {
      if (url.endsWith(suffix)) return answer();
    }
    if (url.endsWith("/api/me")) {
      return Response.json({
        user: {
          id: "u1",
          email: "ann@example.com",
          name: "Ann",
          role: "user",
          onboarding: null,
        },
      });
    }
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
}

function renderRoute(component: unknown) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createRouter({
    routeTree: createRootRoute({ component: component as never }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("offers a download of everything held, as a plain link to the file", async () => {
  serve([]);
  const screen = renderRoute(PrivacyRoute.options.component);
  const link = (await screen.findByRole(
    "link",
    { name: "Download" },
    SLOW,
  )) as HTMLAnchorElement;
  expect(link.getAttribute("href")).toBe("/api/account/export");
  expect(link.hasAttribute("download")).toBe(true);
});

test("deleting the account asks for the address first, and does nothing until it is typed exactly", async () => {
  const calls: Call[] = [];
  serve(calls, {
    "/api/account/delete": () =>
      Response.json({ ok: true, accountRemoved: true }),
  });
  const assigned: string[] = [];
  const original = window.location;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...original, assign: (url: string) => assigned.push(url) },
  });
  try {
    const screen = renderRoute(PrivacyRoute.options.component);
    const user = userEvent.setup({ document });
    await user.click(
      await screen.findByRole("button", { name: "Delete…" }, SLOW),
    );
    const confirm = (await screen.findByRole(
      "button",
      { name: "Delete everything" },
      SLOW,
    )) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    const box = await screen.findByLabelText(
      /Type your email address/,
      {},
      SLOW,
    );
    await user.type(box, "ann@exampl");
    expect(confirm.disabled).toBe(true);
    await user.type(box, "e.com");
    await waitFor(() => expect(confirm.disabled).toBe(false));
    expect(calls.some((c) => c.url.endsWith("/api/account/delete"))).toBe(
      false,
    );

    await user.click(confirm);
    await waitFor(() => expect(assigned).toEqual(["/"]));
    expect(
      calls.find((c) => c.url.endsWith("/api/account/delete"))?.body,
    ).toEqual({
      confirmEmail: "ann@example.com",
    });
  } finally {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: original,
    });
  }
});

test("a refusal is shown, and the person is not sent away", async () => {
  serve([], {
    "/api/account/delete": () =>
      Response.json(
        {
          error:
            "The subscription could not be stopped with the payment service, so nothing was removed.",
        },
        { status: 503 },
      ),
  });
  const assigned: string[] = [];
  const original = window.location;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...original, assign: (url: string) => assigned.push(url) },
  });
  try {
    const screen = renderRoute(PrivacyRoute.options.component);
    const user = userEvent.setup({ document });
    await user.click(
      await screen.findByRole("button", { name: "Delete…" }, SLOW),
    );
    await user.type(
      await screen.findByLabelText(/Type your email address/, {}, SLOW),
      "ann@example.com",
    );
    await user.click(screen.getByRole("button", { name: "Delete everything" }));
    expect(await screen.findByRole("alert", {}, SLOW)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(
      /nothing was removed/,
    );
    expect(assigned).toEqual([]);
  } finally {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: original,
    });
  }
});

test("staff can export anybody's data, and erase it only by typing that person's address", async () => {
  const calls: Call[] = [];
  serve(calls, {
    "/api/admin/people": () =>
      Response.json({
        people: [
          {
            id: "u2",
            email: "bob@example.com",
            name: "Bob",
            role: "user",
            revoked: false,
            configuredAdmin: false,
            providers: ["google"],
            lastSignedInAt: null,
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
        nextCursor: null,
      }),
    "/api/admin/people/u2/erase": () =>
      Response.json({ ok: true, followUp: [] }),
  });
  const screen = renderRoute(PeopleRoute.options.component);
  const user = userEvent.setup({ document });
  const exportLink = (await screen.findByRole(
    "link",
    { name: "Export" },
    SLOW,
  )) as HTMLAnchorElement;
  expect(exportLink.getAttribute("href")).toBe("/api/admin/people/u2/export");

  await user.click(screen.getByRole("button", { name: "Erase…" }));
  const erase = (await screen.findByRole(
    "button",
    { name: "Erase data" },
    SLOW,
  )) as HTMLButtonElement;
  expect(erase.disabled).toBe(true);
  // Their own address, or anyone else's, is not enough.
  await user.type(
    screen.getByLabelText(/Type bob@example.com to confirm/),
    "ann@example.com",
  );
  expect(erase.disabled).toBe(true);
  await user.clear(screen.getByLabelText(/Type bob@example.com to confirm/));
  await user.type(
    screen.getByLabelText(/Type bob@example.com to confirm/),
    "bob@example.com",
  );
  await waitFor(() => expect(erase.disabled).toBe(false));
  await user.click(erase);
  await waitFor(() =>
    expect(
      calls.find((c) => c.url.endsWith("/api/admin/people/u2/erase"))?.body,
    ).toEqual({
      confirmEmail: "bob@example.com",
    }),
  );
});
