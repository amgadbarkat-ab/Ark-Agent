import { describe, expect, test } from "bun:test";
import { toggled } from "@/components/agents/new-group-button";

describe("a named group's members (#83)", () => {
  test("are kept in the order they were picked, so the first one picked leads", () => {
    let picked: string[] = [];
    picked = toggled(picked, "order-desk");
    picked = toggled(picked, "support");
    picked = toggled(picked, "finance");
    expect(picked).toEqual(["order-desk", "support", "finance"]);
    picked = toggled(picked, "order-desk");
    expect(picked).toEqual(["support", "finance"]);
  });
});
