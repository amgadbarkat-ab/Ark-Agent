import { describe, expect, test } from "bun:test";
import { translate } from "@/lib/i18n";

describe("the app's words in Greek (#83)", () => {
  test("Greek where it is written, English where it is not yet, and never a bare key", () => {
    expect(translate("el", "requests.approve")).toBe("Έγκριση");
    expect(translate("en", "requests.approve")).toBe("Approve");
    expect(translate("el", "card.more", { n: 3 })).toBe("Άλλα 3");
    expect(translate("en", "card.more", { n: 3 })).toBe("Show 3 more");
  });
});
