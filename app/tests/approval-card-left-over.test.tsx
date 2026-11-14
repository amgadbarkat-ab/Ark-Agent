import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { ApprovalCard } from "@/components/gallery/decisions";
import { ConversationProvider } from "@/lib/copilot/conversation";

/**
 * DT Lab, Windows retest of v0.1.35: a Front Desk card raised in v0.1.33 was still pending in
 * Requests (with Approve/Decline there), yet the chat drew it as "not finished" with no buttons,
 * because its run had ended. A card still waiting in Requests is live, and is drawn as one.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = globalThis.fetch;
const decided: string[] = [];

function serve(pending: boolean) {
  decided.length = 0;
  globalThis.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(path);
      if (url.startsWith("/api/approvals?which=pending")) {
        return Response.json({
          approvals: pending
            ? [
                {
                  id: "ap1",
                  kind: "chat.card",
                  summary: "Η απάντηση προς την ασθενή είναι έτοιμη.",
                  details: [{ label: "Προς", value: "Ασθενής" }],
                  status: "pending",
                  result: null,
                  requestedBy: { id: "front-desk", name: "Γραμματεία" },
                  target: null,
                  toolCallId: "call-1",
                  createdAt: "2026-11-13T10:00:00Z",
                  expiresAt: "2026-11-20T10:00:00Z",
                  decidedAt: null,
                },
              ]
            : [],
          pending: pending ? 1 : 0,
        });
      }
      if (init?.method === "POST" && url.startsWith("/api/approvals/")) {
        decided.push(url);
        return Response.json({ ok: true });
      }
      throw new Error(`unexpected ${url}`);
    },
    { preconnect: originalFetch.preconnect },
  );
}

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function draw() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ConversationProvider ask={() => {}} busy={false}>
        <ApprovalCard
          args={{ title: "Έγκριση απάντησης στην ασθενή" }}
          respond={undefined}
          result={undefined}
          status="inProgress"
          toolCallId="call-1"
        />
      </ConversationProvider>
    </QueryClientProvider>,
  );
}

test("a card still pending in Requests keeps its buttons, and deciding it records the answer there", async () => {
  serve(true);
  const view = draw();
  expect(
    await view.findByText("Η απάντηση προς την ασθενή είναι έτοιμη."),
  ).toBeTruthy();
  expect(view.getByText("Περιμένει εσάς")).toBeTruthy();
  expect(view.getByTestId("card-left-over").textContent).toContain("Αιτήματα");
  fireEvent.click(view.getByRole("button", { name: "Έγκριση" }));
  await waitFor(() => expect(decided).toEqual(["/api/approvals/ap1/approve"]));
  expect(view.getByText("Εγκρίθηκε")).toBeTruthy();
  expect(view.queryByRole("button", { name: "Έγκριση" })).toBeNull();
});

test("a card that never reached Requests, or is no longer pending, still reads as not finished", async () => {
  serve(false);
  const view = draw();
  expect(await view.findByText(/Αυτό το αίτημα δεν ολοκληρώθηκε/)).toBeTruthy();
  expect(view.queryByRole("button")).toBeNull();
});
