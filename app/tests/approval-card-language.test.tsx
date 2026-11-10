import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import type { z } from "zod";
import {
  ApprovalCard,
  type ApprovalCardProps,
  cardWords,
} from "@/components/gallery/decisions";

/**
 * A Greek approval card spoke English in its own controls (DT Lab, v0.1.25, desk #73): the reason
 * box said "A reason, if you want to give one", and a long label was cut to «Αποστολέας / παρα…».
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(() => GlobalRegistrator.unregister());

function draw(args: z.infer<typeof ApprovalCardProps>) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ApprovalCard
        args={args}
        respond={async () => {}}
        result={undefined}
        status="executing"
      />
    </QueryClientProvider>,
  );
}

test("a Greek card's reason box, badge and default buttons are in Greek", () => {
  const view = draw({
    title: "Αποστολή επιβεβαίωσης παραγγελίας",
    summary: "Θα σταλεί email στον πελάτη.",
    details: [{ label: "Αποστολέας / παραλήπτης", value: "Order Desk → Κάβα" }],
  });
  expect(
    view.getByPlaceholderText("Αιτιολογία, αν θέλετε να δώσετε"),
  ).toBeTruthy();
  expect(view.getByText("Περιμένει εσάς")).toBeTruthy();
  expect(view.getByRole("button", { name: "Έγκριση" })).toBeTruthy();
  expect(view.getByRole("button", { name: "Απόρριψη" })).toBeTruthy();
  // The whole label is there and wraps; nothing cuts it.
  const label = view.getByText("Αποστολέας / παραλήπτης");
  expect(label.className).not.toContain("truncate");
});

test("what the model names itself wins, in any language", () => {
  const view = draw({
    title: "Αποστολή email",
    summary: "Θα σταλεί email.",
    approveLabel: "Εγκρίνω",
    rejectLabel: "Απορρίπτω",
    reasonLabel: "Γιατί;",
  });
  expect(view.getByRole("button", { name: "Εγκρίνω" })).toBeTruthy();
  expect(view.getByRole("button", { name: "Απορρίπτω" })).toBeTruthy();
  expect(view.getByPlaceholderText("Γιατί;")).toBeTruthy();
});

test("an English card is unchanged", () => {
  const view = draw({
    title: "Send the order email",
    summary: "One email to the customer.",
  });
  expect(
    view.getByPlaceholderText("A reason, if you want to give one"),
  ).toBeTruthy();
  expect(view.getByRole("button", { name: "Approve" })).toBeTruthy();
  expect(cardWords("Hello", undefined).waiting).toBe("Waiting on you");
});
