/**
 * What the lead of a team channel is told when the person `@`-mentions a colleague.
 *
 * A team channel runs on its lead, so a message addressed to `@Marketing` reached the Chief of
 * Operations, who answered it as itself ("operating as the Chief of Operations, not Marketing") and
 * the person could not reach anybody else. Sending the run to the colleague instead would change
 * which agent the channel's conversation belongs to, so the lead is told plainly, beside the message,
 * who it was for and how to pass it on: `team_ask`, which it holds as the lead, and whose answer
 * comes back into the conversation with the colleague's name on it.
 *
 * A system turn, the same way a picked skill is sent, so the person's own words stay as they wrote
 * them and the instruction never shows in the transcript.
 */

type Member = { id: string; name: string };

/** The colleague a message is for: the `@` chip if there is one, else an `@Name` typed out. */
export function mentionedColleague(
  draft: { text: string; agentId: string | null },
  members: readonly Member[],
  leadId: string,
): Member | null {
  const colleagues = members.filter((member) => member.id !== leadId);
  if (draft.agentId) {
    return colleagues.find((member) => member.id === draft.agentId) ?? null;
  }
  const text = draft.text.toLowerCase();
  // Longest name first, so "@Sales Lead" is not read as "@Sales".
  return (
    [...colleagues]
      .sort((a, b) => b.name.length - a.name.length)
      .find((member) => {
        const name = member.name.trim().toLowerCase();
        if (!name) return false;
        const at = text.indexOf(`@${name}`);
        if (at < 0) return false;
        const after = text.charAt(at + name.length + 1);
        return after === "" || !/[\p{L}\p{N}]/u.test(after);
      }) ?? null
  );
}

export function handoffInstruction(colleague: Member): string {
  const name = colleague.name.replace(/\s+/g, " ").trim();
  return (
    `The person addressed this message to your colleague ${name} (@${name}), not to you. ` +
    `Ask ${name} with team_ask, passing on what the person asked in full, and reply with ` +
    `${name}'s answer, saying it is theirs. Do not answer it yourself. If team_ask is not ` +
    `available to you, say so plainly instead of answering in ${name}'s place.`
  );
}
