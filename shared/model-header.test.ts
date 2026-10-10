import { describe, expect, test } from "bun:test";
import {
  decodeModelOverride,
  encodeModelOverride,
  MODEL_HEADER,
  type ModelOverride,
} from "./model-header";

const sample: ModelOverride = {
  protocol: "openai",
  baseUrl: "https://api.groq.com/openai/v1",
  apiKey: "gsk-secret",
  model: "llama-3.3-70b",
};

describe("model header", () => {
  test("has a stable name both sides share", () => {
    expect(MODEL_HEADER).toBe("x-ark-model");
  });

  test("round-trips what was written, including a missing key", () => {
    expect(decodeModelOverride(encodeModelOverride(sample))).toEqual(sample);
    const keyless: ModelOverride = {
      ...sample,
      apiKey: null,
      protocol: "anthropic",
    };
    expect(decodeModelOverride(encodeModelOverride(keyless))).toEqual(keyless);
  });

  test("is safe in a header: no characters a header cannot carry", () => {
    expect(encodeModelOverride(sample)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("does not put the key where it can be read at a glance", () => {
    expect(encodeModelOverride(sample)).not.toContain("gsk-secret");
  });

  test("anything absent or damaged is simply not an override", () => {
    const garbage = [
      undefined,
      null,
      "",
      "not base64 json !!!",
      Buffer.from("[]").toString("base64url"),
      Buffer.from("null").toString("base64url"),
      "x".repeat(9000),
    ];
    for (const value of garbage)
      expect(decodeModelOverride(value)).toBeUndefined();
  });

  test("refuses a dialect the bot cannot speak, a missing model, and an address that is not a web address", () => {
    const bad: Array<Partial<Record<keyof ModelOverride, unknown>>> = [
      { protocol: "google" },
      { model: "" },
      { model: 5 },
      { baseUrl: "" },
      { baseUrl: "file:///etc/passwd" },
      { baseUrl: "not a url" },
      { apiKey: 12 },
    ];
    for (const change of bad) {
      const encoded = Buffer.from(
        JSON.stringify({ ...sample, ...change }),
      ).toString("base64url");
      expect(decodeModelOverride(encoded)).toBeUndefined();
    }
  });

  test("a gateway override carries a path and a grant, and nothing else is accepted in its place", () => {
    const viaGateway: ModelOverride = {
      protocol: "anthropic",
      baseUrl: "/api/model-gateway/anthropic",
      apiKey: "grant.token",
      model: "claude-haiku-4-5-20251001",
      via: "gateway",
    };
    expect(decodeModelOverride(encodeModelOverride(viaGateway))).toEqual(
      viaGateway,
    );
    const bad: Array<Partial<Record<keyof ModelOverride, unknown>>> = [
      { baseUrl: "https://evil.example/x" },
      { baseUrl: "//evil.example/x" },
      { baseUrl: "relative/path" },
      { apiKey: null },
      { apiKey: "" },
    ];
    for (const change of bad) {
      const encoded = Buffer.from(
        JSON.stringify({ ...viaGateway, ...change }),
      ).toString("base64url");
      expect(decodeModelOverride(encoded)).toBeUndefined();
    }
    expect(
      decodeModelOverride(
        Buffer.from(JSON.stringify({ ...viaGateway, via: "other" })).toString(
          "base64url",
        ),
      ),
    ).toBeUndefined();
  });

  test("a path is not an address: without the gateway marker it is refused", () => {
    const encoded = Buffer.from(
      JSON.stringify({ ...sample, baseUrl: "/api/model-gateway/openai/v1" }),
    ).toString("base64url");
    expect(decodeModelOverride(encoded)).toBeUndefined();
  });
});
