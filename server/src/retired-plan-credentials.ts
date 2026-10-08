/**
 * Ark never holds, forwards or spends a person's chat-subscription credentials.
 *
 * An earlier version could be given a Claude plan token (`CLAUDE_CODE_OAUTH_TOKEN`) or the path to a
 * ChatGPT plan's login (`CHATGPT_AUTH_FILE`) and ran models through them. Anthropic does not allow a
 * product to collect or route requests through plan credentials, and OpenAI allows plan sign-in in a
 * paid app only through its own approved programme (docs/ark/04-llm-providers.md). Nothing reads
 * these any more.
 *
 * They are still removed from the process at boot, so a machine that ran the old version cannot hand
 * one to a bot or tool this server starts: child processes inherit the environment, and a credential
 * nobody uses is still a credential somebody can lose. The names are returned so the caller can say,
 * once and without the values, that they were found.
 */
export const RETIRED_PLAN_CREDENTIALS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CHATGPT_AUTH_FILE",
  "CHATGPT_OAUTH_TOKEN",
] as const;

export function dropRetiredPlanCredentials(
  environment: Record<string, string | undefined> = process.env,
): string[] {
  const found: string[] = [];
  for (const name of RETIRED_PLAN_CREDENTIALS) {
    if (environment[name]?.trim()) found.push(name);
    delete environment[name];
  }
  return found;
}
