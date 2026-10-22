/**
 * One line a Bot writes per run, saying what actually reached the model.
 *
 * "The employee does not know its role" has three possible causes that look identical from the chat:
 * the role was never sent, it was sent and lost on the way, or the model was handed it and ignored
 * it. Two of those are visible here and the third is not, so having this line settles which it was
 * without asking anyone to open a developer console. Nothing in it is a secret: the model's name and
 * the host it was reached at, sizes, and names of tools. The opening of the role is included so a
 * glance shows whose it is; the rest of it, the conversation, and every key stay out.
 */
export type RunSummary = {
  runId: string;
  /** The model that answers, and where it is reached (host only; never a key or a path). */
  model: string;
  host: string;
  /** Whether the person's Models-page choice was used rather than this container's own model. */
  chosen: boolean;
  /** The first system message as the model gets it. */
  systemCharacters: number;
  /** The employee's own role at the head of it, if the server sent one. */
  roleOpening: string;
  roleCharacters: number;
  toolsOffered: string[];
  toolsLeftOut: string[];
};

export function describeRun(summary: RunSummary): string {
  const names = (list: string[]) => (list.length > 0 ? list.join(",") : "none");
  return (
    `run ${summary.runId}: model=${summary.model} host=${summary.host} chosen=${summary.chosen} ` +
    `system=${summary.systemCharacters} chars role=${summary.roleCharacters} chars ` +
    `role_opening=${JSON.stringify(summary.roleOpening)} ` +
    `tools=${summary.toolsOffered.length} [${names(summary.toolsOffered)}] ` +
    `left_out=[${names(summary.toolsLeftOut)}]`
  );
}

/** The host of an address, or "" when it is not one. */
export function hostOf(address: string | undefined): string {
  if (!address) return "";
  try {
    return new URL(address).host;
  } catch {
    return "";
  }
}

/** The opening of a role, on one line and short. */
export function openingOf(role: string, length = 60): string {
  return role.replace(/\s+/g, " ").trim().slice(0, length);
}
