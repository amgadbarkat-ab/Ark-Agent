import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runtimeModelForEnvironment } from "../src/copilot";
import {
  dropRetiredPlanCredentials,
  RETIRED_PLAN_CREDENTIALS,
} from "../src/retired-plan-credentials";

describe("retired chat-plan credentials", () => {
  test("are removed from the environment and reported by name, never by value", () => {
    const environment: Record<string, string | undefined> = {
      CLAUDE_CODE_OAUTH_TOKEN: "synthetic-claude-plan-token",
      CHATGPT_AUTH_FILE: "/auth/chatgpt.json",
      OPENAI_API_KEY: "ordinary-key",
    };
    const found = dropRetiredPlanCredentials(environment);
    expect(found.sort()).toEqual([
      "CHATGPT_AUTH_FILE",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]);
    expect(JSON.stringify(found)).not.toContain("synthetic");
    for (const name of RETIRED_PLAN_CREDENTIALS) {
      expect(environment[name]).toBeUndefined();
    }
    expect(environment.OPENAI_API_KEY).toBe("ordinary-key");
  });

  test("a blank value is removed without being reported", () => {
    const environment: Record<string, string | undefined> = {
      CLAUDE_CODE_OAUTH_TOKEN: "  ",
    };
    expect(dropRetiredPlanCredentials(environment)).toEqual([]);
    expect(environment.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  test("a plan token in the environment changes nothing about which model is used", () => {
    const base = { provider: "openai", defaultModel: "gpt-test" } as const;
    const plain = runtimeModelForEnvironment(base, {});
    const withToken = runtimeModelForEnvironment(base, {
      CLAUDE_CODE_OAUTH_TOKEN: "synthetic-claude-plan-token",
      CHATGPT_AUTH_FILE: "/auth/chatgpt.json",
    });
    expect(withToken).toEqual(plain);
  });

  test("the server clears them at boot", () => {
    const entry = readFileSync(
      join(import.meta.dir, "../src/index.ts"),
      "utf8",
    );
    expect(entry).toContain("dropRetiredPlanCredentials()");
  });
});
