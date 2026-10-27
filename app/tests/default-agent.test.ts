import { describe, expect, test } from "bun:test";
import {
  defaultAgentId,
  defaultAgentProfile,
  PICKED_HARNESS_AGENT_ID,
} from "@/lib/agents/default-agent";
import type { AgentProfile } from "@/lib/agents/queries";

function agent(id: string, name = id): AgentProfile {
  return {
    runLocation: "cloud",
    avatarSeed: id,
    avatarImage: null,
    builtIn: id === "general-assistant",
    canManage: true,
    endpoint: id === PICKED_HARNESS_AGENT_ID ? "http://127.0.0.1:4201" : null,
    hasAuth: false,
    hasCallbackToken: false,
    hidden: false,
    id,
    mine: true,
    name,
    roleDescription: "Role",
    systemOwned: false,
    title: name,
    visibility: "private",
  };
}

describe("default agent selection", () => {
  test("prefers the person's own primary, the lead of their team, over every other default", () => {
    const lead = {
      ...agent("agent_coo", "Chief of Operations"),
      primary: true,
    };
    const roster = [
      agent(PICKED_HARNESS_AGENT_ID, "LangGraph"),
      agent("general-assistant", "General Assistant"),
      lead,
      agent("agent_support", "Customer Support"),
    ];
    expect(defaultAgentId(roster)).toBe("agent_coo");
    expect(defaultAgentProfile(roster, roster[1])?.id).toBe("agent_coo");
  });

  test("does not take somebody else's primary as this person's", () => {
    const theirs = {
      ...agent("agent_their_lead"),
      primary: true,
      mine: false,
    };
    expect(defaultAgentId([theirs, agent(PICKED_HARNESS_AGENT_ID)])).toBe(
      PICKED_HARNESS_AGENT_ID,
    );
  });

  test("prefers the picked harness over the first visible agent", () => {
    const chosen = defaultAgentProfile([
      agent("general-assistant", "General Assistant"),
      agent(PICKED_HARNESS_AGENT_ID, "LangGraph"),
    ]);

    expect(chosen?.id).toBe(PICKED_HARNESS_AGENT_ID);
    expect(
      defaultAgentId([
        agent("general-assistant"),
        agent(PICKED_HARNESS_AGENT_ID),
      ]),
    ).toBe(PICKED_HARNESS_AGENT_ID);
  });

  test("keeps the route-specific fallback when there is no picked harness", () => {
    const general = agent("general-assistant", "General Assistant");
    const shared = agent("shared-agent", "Shared Agent");

    expect(defaultAgentProfile([general, shared], shared)?.id).toBe(
      "shared-agent",
    );
  });

  test("falls back to the first agent when no picked harness or route fallback exists", () => {
    expect(
      defaultAgentId([agent("general-assistant"), agent("researcher")]),
    ).toBe("general-assistant");
  });

  test("returns undefined when the roster is still absent", () => {
    expect(defaultAgentId(undefined)).toBeUndefined();
  });
});
