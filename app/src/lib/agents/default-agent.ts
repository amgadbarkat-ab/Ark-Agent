import type { AgentProfile } from "./queries";

export const PICKED_HARNESS_AGENT_ID = "picked-harness";

/**
 * Who a message with no `@` goes to: the person's own primary first, the lead of their team.
 *
 * It was the deployment's bundled Bot, or the first shared one, so somebody who had hired a team was
 * answered by a Bot that knew nothing of it. The server routes the same way; see `leadOf` there.
 */
export function defaultAgentProfile(
  agents: readonly AgentProfile[] | undefined,
  fallback?: AgentProfile,
): AgentProfile | undefined {
  return (
    agents?.find((candidate) => candidate.primary && candidate.mine) ??
    agents?.find((candidate) => candidate.id === PICKED_HARNESS_AGENT_ID) ??
    fallback ??
    agents?.[0]
  );
}

export function defaultAgentId(
  agents: readonly AgentProfile[] | undefined,
): string | undefined {
  return defaultAgentProfile(agents)?.id;
}
