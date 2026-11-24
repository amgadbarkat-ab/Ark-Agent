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
import { PasswordSignIn } from "@/components/auth/password-sign-in";
import { MemberForm } from "@/components/settings/team-member-form";
import { Route as TeamRoute } from "@/routes/_authed/settings/team";

/**
 * The team (Amgad, 24 Nov 2026): the administrator gives each sub-profile exactly the digital
 * employees it uses, an employee belongs to one sub-profile at a time, and moving one asks first,
 * naming who loses it. On a fresh ArkAgent, the first person makes the administrator's account.
 */

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

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  GlobalRegistrator.unregister();
});
const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});
const SLOW = { timeout: 8000 };

type Call = { method: string; url: string; body?: Record<string, unknown> };

function serve(answer: (call: Call) => Response) {
  const calls: Call[] = [];
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      url: String(input),
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    };
    calls.push(call);
    return answer(call);
  }) as unknown as typeof fetch;
  return calls;
}

const AGENTS = [
  { id: "agent-sales", name: "Sales" },
  { id: "agent-books", name: "Books" },
];
const MEMBERS = [
  {
    userId: "u-admin",
    name: "Maria",
    email: "maria@example.test",
    role: "admin",
    status: "active",
    createdAt: "2026-11-24T10:00:00.000Z",
    mustChangePassword: false,
    agentIds: [],
  },
  {
    userId: "u-nikos",
    name: "Nikos",
    email: "nikos@example.test",
    role: "subprofile",
    status: "active",
    createdAt: "2026-11-24T11:00:00.000Z",
    mustChangePassword: false,
    agentIds: ["agent-sales"],
  },
];

test(
  "the administrator sees each person, their state and their digital employees",
  async () => {
    serve((call) =>
      call.url.includes("/api/agents")
        ? Response.json({ agents: AGENTS })
        : Response.json({ members: MEMBERS }),
    );
    const Page = TeamRoute.options.component as () => React.ReactNode;
    const screen = render(inClient(<Page />));
    await screen.findByText(/Nikos · nikos@example.test/);
    expect(
      screen.getByText("Administrator: every digital employee"),
    ).toBeTruthy();
    expect(await screen.findByText("Active · Sales")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Add a sub-profile/ }),
    ).toBeTruthy();
  },
  SLOW,
);

test(
  "adding a sub-profile with somebody's employee asks first, naming who loses it, then moves it",
  async () => {
    const calls = serve((call) => {
      if (!call.body?.move)
        return Response.json(
          {
            error:
              "Some of these digital employees belong to another person. Confirm to move them.",
            detail: {
              conflicts: [
                {
                  agentId: "agent-sales",
                  fromUserId: "u-nikos",
                  fromName: "Nikos",
                },
              ],
            },
          },
          { status: 409 },
        );
      return Response.json(
        { checkoutUrl: "https://checkout.example/pay" },
        { status: 201 },
      );
    });
    const user = userEvent.setup({ document });
    const closed: Array<string | null | undefined> = [];
    const screen = render(
      inClient(
        <MemberForm
          agents={AGENTS as never}
          onClose={(url) => closed.push(url)}
        />,
      ),
    );
    await user.type(await screen.findByLabelText("Name"), "Eleni");
    await user.type(screen.getByLabelText("Email"), "eleni@example.test");
    await user.type(
      screen.getByLabelText(/First password/),
      "first-password-1",
    );
    const save = screen.getByRole("button", {
      name: "Add and pay €15 a month",
    });
    // No employee chosen: nothing can be saved. There is no "all" default.
    expect(save.hasAttribute("disabled")).toBe(true);
    await user.click(screen.getAllByLabelText("Sales")[0] as Element);
    await user.click(save);

    await screen.findByText("Move these digital employees?");
    expect(screen.getByText("Sales: from Nikos")).toBeTruthy();
    expect(closed).toEqual([]);
    await user.click(
      screen.getByRole("button", { name: "Move them and save" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed).toEqual(["https://checkout.example/pay"]);

    const posts = calls.filter((one) => one.method === "POST");
    expect(posts.map((one) => one.url.replace(/^.*(\/api\/)/, "$1"))).toEqual([
      "/api/team/members",
      "/api/team/members",
    ]);
    expect(posts.map((one) => one.body)).toEqual([
      {
        name: "Eleni",
        email: "eleni@example.test",
        password: "first-password-1",
        agentIds: ["agent-sales"],
        move: false,
      },
      {
        name: "Eleni",
        email: "eleni@example.test",
        password: "first-password-1",
        agentIds: ["agent-sales"],
        move: true,
      },
    ]);
  },
  SLOW,
);

test(
  "on a fresh ArkAgent, the first person makes the administrator's account, then signs in",
  async () => {
    const user = userEvent.setup({ document });
    const calls = serve((call) => {
      if (call.url.endsWith("/api/team/setup") && call.method === "GET")
        return Response.json({ needed: true });
      if (call.url.endsWith("/api/team/setup"))
        return Response.json({ ok: true }, { status: 201 });
      return Response.json({ user: null, session: null });
    });
    const screen = render(inClient(<PasswordSignIn />));
    await user.type(await screen.findByLabelText("Your name"), "Maria");
    await user.type(screen.getByLabelText("Email"), "maria@example.test");
    await user.type(screen.getByLabelText("Password"), "a-long-password");
    await user.type(
      screen.getByLabelText("The password again"),
      "another-one-1",
    );
    await user.click(
      screen.getByRole("button", { name: "Make the account and sign in" }),
    );
    // Two different passwords: nothing is sent.
    await screen.findByText("The two passwords are not the same.");
    expect(calls.some((one) => one.method === "POST")).toBe(false);

    await user.clear(screen.getByLabelText("The password again"));
    await user.type(
      screen.getByLabelText("The password again"),
      "a-long-password",
    );
    await user.click(
      screen.getByRole("button", { name: "Make the account and sign in" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const setup = calls.find(
      (one) => one.method === "POST" && one.url.endsWith("/api/team/setup"),
    );
    expect(setup?.body).toEqual({
      name: "Maria",
      email: "maria@example.test",
      password: "a-long-password",
    });
    // The account is made first; signing in follows, and a failure there is said, not thrown.
    await screen.findByText(
      /Signing in did not work|That email and password do not match/,
    );
  },
  SLOW,
);
