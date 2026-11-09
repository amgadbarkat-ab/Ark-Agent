import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { render } from "@testing-library/react";
import { Streamdown } from "streamdown";
import { tidyAnswer } from "@/lib/answer-text";

/**
 * Greek answers in the Wine24 demo (desk #73, v0.1.23): a «Τι λείπει» list drawn as one paragraph,
 * and a capital Ω in the middle of «επιβεβαιωθεί».
 */

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

function items(markdown: string): string[] {
  const view = render(<Streamdown>{markdown}</Streamdown>);
  const found = [...view.container.querySelectorAll("li")].map(
    (item) => item.textContent?.trim() ?? "",
  );
  view.unmount();
  return found;
}

describe("bullets a model writes as glyphs", () => {
  test("• lines become one list item each", () => {
    const answer =
      "Τι λείπει:\n• Η διεύθυνση παράδοσης\n• Η ημερομηνία\n• Ο τρόπος πληρωμής";
    expect(items(answer)).toEqual([]);
    expect(items(tidyAnswer(answer))).toEqual([
      "Η διεύθυνση παράδοσης",
      "Η ημερομηνία",
      "Ο τρόπος πληρωμής",
    ]);
  });

  test("– and ▪ lines too, keeping their indent", () => {
    expect(tidyAnswer("– πρώτο\n  ▪ δεύτερο")).toBe("- πρώτο\n  - δεύτερο");
  });

  test("several • items strung along one line", () => {
    expect(
      items(tidyAnswer("Τι λείπει: • διεύθυνση • ημερομηνία • πληρωμή")),
    ).toEqual(["διεύθυνση", "ημερομηνία", "πληρωμή"]);
    expect(tidyAnswer("• διεύθυνση • ημερομηνία")).toBe(
      "- διεύθυνση\n- ημερομηνία",
    );
  });

  test("markdown lists, prose with a dash inside it, tables and code are left as written", () => {
    const untouched = [
      "- ήδη λίστα\n* κι αυτή",
      "Η τιμή – με ΦΠΑ – είναι 12 €.",
      "| Κρασί | Σημείωση |\n|---|---|\n| Ασύρτικο | ξηρό • φρέσκο • ορυκτό |",
      "```\n• not a list\n```",
    ];
    for (const text of untouched) expect(tidyAnswer(text)).toBe(text);
  });

  test("a bare bullet still streaming in is left until its text arrives", () => {
    expect(tidyAnswer("Τι λείπει:\n• ")).toBe("Τι λείπει:\n• ");
  });
});

describe("a capital Greek letter inside a lowercase word", () => {
  test("is made lowercase", () => {
    expect(tidyAnswer("Πρέπει να επιβεβαιΩθεί η παραγγελία.")).toBe(
      "Πρέπει να επιβεβαιωθεί η παραγγελία.",
    );
  });

  test("words in capitals, a capital starting a word, and Latin text are left alone", () => {
    const untouched = [
      "Στείλτε το ΑΦΜ σας.",
      "Ο Νίκος και η Ελένη.",
      "Ασύρτικο ΠΟΠ Σαντορίνη",
      "iPhone and McDonald",
    ];
    for (const text of untouched) expect(tidyAnswer(text)).toBe(text);
  });

  test("code is shown as written", () => {
    expect(tidyAnswer("`επιβεβαιΩθεί`")).toBe("`επιβεβαιΩθεί`");
    expect(tidyAnswer("```\nεπιβεβαιΩθεί\n```")).toBe("```\nεπιβεβαιΩθεί\n```");
  });
});
