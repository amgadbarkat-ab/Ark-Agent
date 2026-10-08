import { describe, expect, test } from "bun:test";
import {
  checkConnectionInput,
  LOCAL_MODELS,
  PROVIDERS,
  providerById,
  recommendLocalModels,
  usableProviders,
} from "./model-providers";

describe("the provider catalogue", () => {
  test("every provider has a distinct id", () => {
    const ids = PROVIDERS.map((provider) => provider.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("local and free providers come before paid ones, as the product promises", () => {
    const order = ["local", "free", "paid", "custom", "plan"];
    const ranks = PROVIDERS.map((p) => order.indexOf(p.tier));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  test("a local provider needs no key and is flagged as reaching the person's own machine", () => {
    for (const provider of PROVIDERS.filter((p) => p.tier === "local")) {
      expect(provider.keyRequired).toBe(false);
      expect(provider.local).toBe(true);
    }
  });

  test("a hosted provider is never flagged local", () => {
    for (const provider of PROVIDERS.filter((p) => p.tier !== "local")) {
      expect(provider.local).toBeFalsy();
    }
  });

  test("a provider that cannot change its address names one, and a free one needs the person's key", () => {
    for (const provider of PROVIDERS.filter((p) => !p.unavailable)) {
      if (!provider.baseUrlEditable)
        expect(provider.baseUrl).toMatch(/^https:\/\//);
      if (provider.tier === "free") expect(provider.keyRequired).toBe(true);
    }
  });

  test("a subscription sign-in is listed but cannot be set up until it is allowed", () => {
    const plans = PROVIDERS.filter((p) => p.tier === "plan");
    expect(plans.length).toBeGreaterThan(0);
    for (const plan of plans) expect(plan.unavailable).toBeTruthy();
    expect(usableProviders().some((p) => p.tier === "plan")).toBe(false);
  });

  test("Gemini is offered only as a paid key, with the reason given", () => {
    const google = providerById("google");
    expect(google?.tier).toBe("paid");
    expect(google?.notes?.join(" ")).toMatch(/paid key/i);
    expect(
      PROVIDERS.some((p) => p.tier === "free" && /google|gemini/i.test(p.name)),
    ).toBe(false);
  });

  test("Claude is offered with an API key, and the note says a subscription will not work", () => {
    const anthropic = providerById("anthropic");
    expect(anthropic?.keyRequired).toBe(true);
    expect(anthropic?.notes?.join(" ")).toMatch(/subscription/i);
  });
});

describe("checkConnectionInput", () => {
  test("accepts a local server at its default address with no key", () => {
    expect(checkConnectionInput({ providerId: "ollama" })).toEqual({
      ok: true,
      baseUrl: "http://localhost:11434/v1",
    });
  });

  test("accepts a different address for a local server and trims trailing slashes", () => {
    expect(
      checkConnectionInput({
        providerId: "ollama",
        baseUrl: "http://192.168.1.20:11434/v1/",
      }),
    ).toEqual({ ok: true, baseUrl: "http://192.168.1.20:11434/v1" });
  });

  test("requires a key where one is needed, and blank is not a key", () => {
    for (const apiKey of [undefined, null, "", "   "]) {
      const verdict = checkConnectionInput({ providerId: "anthropic", apiKey });
      expect(verdict).toMatchObject({ ok: false, problem: "key-required" });
    }
    expect(
      checkConnectionInput({ providerId: "anthropic", apiKey: "sk-x" }),
    ).toEqual({
      ok: true,
      baseUrl: "https://api.anthropic.com",
    });
  });

  test("a hosted provider always uses its own address", () => {
    expect(
      checkConnectionInput({
        providerId: "openai",
        apiKey: "k",
        baseUrl: "https://evil.example/v1",
      }),
    ).toMatchObject({ ok: false, problem: "base-url-not-editable" });
    expect(
      checkConnectionInput({
        providerId: "openai",
        apiKey: "k",
        baseUrl: "https://api.openai.com/v1/",
      }),
    ).toEqual({ ok: true, baseUrl: "https://api.openai.com/v1" });
  });

  test("a custom server needs an address, and it must be a plain web address", () => {
    expect(
      checkConnectionInput({ providerId: "openai-compatible" }),
    ).toMatchObject({
      ok: false,
      problem: "base-url-required",
    });
    for (const baseUrl of [
      "not a url",
      "ftp://host/v1",
      "file:///etc/passwd",
      "javascript:alert(1)",
    ]) {
      expect(
        checkConnectionInput({ providerId: "openai-compatible", baseUrl }),
      ).toMatchObject({
        ok: false,
        problem: "base-url-invalid",
      });
    }
    expect(
      checkConnectionInput({
        providerId: "openai-compatible",
        baseUrl: "https://user:secret@host/v1",
      }),
    ).toMatchObject({ ok: false, problem: "base-url-invalid" });
    expect(
      checkConnectionInput({
        providerId: "openai-compatible",
        baseUrl: "https://llm.example.com/v1",
      }),
    ).toEqual({ ok: true, baseUrl: "https://llm.example.com/v1" });
  });

  test("refuses unknown and unavailable providers with a reason", () => {
    expect(checkConnectionInput({ providerId: "nope" })).toMatchObject({
      ok: false,
      problem: "unknown-provider",
    });
    const refused = checkConnectionInput({ providerId: "chatgpt-plan" });
    expect(refused).toMatchObject({ ok: false, problem: "unavailable" });
    expect(refused.ok === false && refused.message).toMatch(/approval/i);
  });
});

describe("local model advice", () => {
  test("offers more as memory grows, best first, and nothing when there is too little", () => {
    expect(recommendLocalModels(2)).toEqual([]);
    expect(recommendLocalModels(4).map((m) => m.model)).toEqual(["qwen3:1.7b"]);
    expect(recommendLocalModels(8).map((m) => m.model)).toEqual([
      "qwen3:8b",
      "qwen3:4b",
      "qwen3:1.7b",
    ]);
    expect(recommendLocalModels(32)[0]?.model).toBe("gpt-oss:20b");
    expect(recommendLocalModels(Number.NaN)).toEqual([]);
  });

  test("the list is ordered largest first and never asks for less memory than a smaller model", () => {
    const needs = LOCAL_MODELS.map((m) => m.minMemoryGb);
    expect(needs).toEqual([...needs].sort((a, b) => b - a));
  });
});
