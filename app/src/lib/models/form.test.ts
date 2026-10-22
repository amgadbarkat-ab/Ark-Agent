import { expect, test } from "bun:test";
import { FREE_MODEL_NOTE, isFreeModel } from "./form";

test("a model a provider offers for nothing is recognised by its :free suffix", () => {
  expect(isFreeModel("cohere/command-a:free")).toBe(true);
  expect(isFreeModel("  meta-llama/llama-3.3-70b-instruct:FREE ")).toBe(true);
  expect(isFreeModel("anthropic/claude-sonnet-4-5")).toBe(false);
  expect(isFreeModel("qwen3:8b")).toBe(false);
  expect(isFreeModel("free-model")).toBe(false);
  expect(isFreeModel("")).toBe(false);
});

test("the note says what to expect and what to do instead", () => {
  expect(FREE_MODEL_NOTE).toContain("ignore");
  expect(FREE_MODEL_NOTE).toContain("paid model");
});
