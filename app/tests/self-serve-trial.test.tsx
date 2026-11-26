import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SelfServeTrial } from "@/components/activation/self-serve-trial";
import type { Activation } from "@/lib/trial/queries";
import { queryClient } from "@/query-client";

/**
 * The free 7-day trial on the Activate screen (v0.1.58): name, company and email go to the server,
 * the emailed code starts the trial, and the server's refusal is shown as it said it.
 */
beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const sent: { url: string; body: unknown }[] = [];
let answers: Response[] = [];

function stubFetch() {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    sent.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    return (answers.shift() ?? Response.json({})).clone();
  }) as unknown as typeof fetch;
}

const wrap = (node: React.ReactNode) => (
  <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>
);

const none = {
  state: "none",
  allowed: false,
  selfServeTrial: true,
} as unknown as Activation;

test("not shown where blackark.uk cannot start one", () => {
  const screen = render(
    wrap(<SelfServeTrial activation={{ ...none, selfServeTrial: false }} />),
  );
  expect(screen.queryByText("Start a free 7-day trial")).toBeNull();
});

test("name, company and email, then the emailed code, and the trial starts", async () => {
  stubFetch();
  sent.length = 0;
  answers = [
    Response.json({ sent: true }, { status: 202 }),
    Response.json(
      { error: "That code is not right. Check the email and try again." },
      { status: 400 },
    ),
    Response.json({
      kind: "trial",
      changed: true,
      activation: {
        ...none,
        state: "trial",
        allowed: true,
        selfServeTrial: false,
      },
    }),
  ];
  let activated = false;
  const user = userEvent.setup({ document });
  const screen = render(
    wrap(
      <SelfServeTrial
        activation={none}
        onActivated={() => {
          activated = true;
        }}
      />,
    ),
  );
  await user.type(screen.getByLabelText("Your name"), "Maria");
  await user.type(screen.getByLabelText("Company"), "Lambrou Winery");
  await user.type(screen.getByLabelText("Email"), "Maria@Lambrou.example");
  await user.click(screen.getByRole("button", { name: "Email me a code" }));
  await waitFor(() =>
    expect(
      screen.getByLabelText(
        "The 6-digit code we sent to maria@lambrou.example",
      ),
    ).toBeTruthy(),
  );
  expect(sent[0]).toMatchObject({
    url: "/api/activation/trial/start",
    body: {
      name: "Maria",
      company: "Lambrou Winery",
      email: "maria@lambrou.example",
    },
  });
  const field = screen.getByLabelText(
    "The 6-digit code we sent to maria@lambrou.example",
  );
  await user.type(field, "123456");
  await user.click(screen.getByRole("button", { name: "Start my trial" }));
  await waitFor(() =>
    expect(
      screen.getByText(
        "That code is not right. Check the email and try again.",
      ),
    ).toBeTruthy(),
  );
  expect(activated).toBe(false);
  await user.clear(field);
  await user.type(field, "654321");
  await user.click(screen.getByRole("button", { name: "Start my trial" }));
  await waitFor(() => expect(activated).toBe(true));
  expect(sent.at(-1)).toEqual({
    url: "/api/activation/trial/confirm",
    body: { email: "maria@lambrou.example", code: "654321" },
  });
});
