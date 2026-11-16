import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ActivationForm } from "@/components/activation/activation-form";
import { queryClient } from "@/query-client";

/**
 * The one box on the Activate screen (#109, v0.1.42): a code goes to the server as typed, the
 * server's refusal is shown as it said it, and an accepted key takes the person on.
 */
beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const sent: { url: string; body: unknown }[] = [];
let answer: Response = Response.json({});

function stubFetch() {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    sent.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    return answer.clone();
  }) as unknown as typeof fetch;
}

const wrap = (node: React.ReactNode) => (
  <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>
);

test("a refused code shows the server's sentence and stays on the screen", async () => {
  stubFetch();
  answer = Response.json(
    { error: "This licence key is not signed by BlackArk." },
    { status: 400 },
  );
  let activated = false;
  const user = userEvent.setup({ document });
  const screen = render(
    wrap(
      <ActivationForm
        onActivated={() => {
          activated = true;
        }}
      />,
    ),
  );
  await user.type(
    screen.getByLabelText("Trial activation code or licence key"),
    "ARK1-abc.def",
  );
  await user.click(screen.getByRole("button", { name: "Activate" }));
  await waitFor(() =>
    expect(
      screen.getByText("This licence key is not signed by BlackArk."),
    ).toBeTruthy(),
  );
  expect(sent.at(-1)).toEqual({
    url: "/api/activation/code",
    body: { code: "ARK1-abc.def" },
  });
  expect(activated).toBe(false);
});

test("an accepted licence key says so and moves on", async () => {
  stubFetch();
  answer = Response.json({
    kind: "license",
    changed: true,
    activation: { allowed: true, state: "paid" },
  });
  let activated = false;
  const user = userEvent.setup({ document });
  const screen = render(
    wrap(
      <ActivationForm
        onActivated={() => {
          activated = true;
        }}
        showFileImport={false}
      />,
    ),
  );
  await user.type(
    screen.getByLabelText("Trial activation code or licence key"),
    "ARK1-key.sig",
  );
  await user.click(screen.getByRole("button", { name: "Activate" }));
  await waitFor(() =>
    expect(screen.getByText("Done. Your paid licence is active.")).toBeTruthy(),
  );
  expect(activated).toBe(true);
  expect(screen.queryByText("Trial setup file (.arktrial)")).toBeNull();
});
