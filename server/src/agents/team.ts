/**
 * What a digital employee is told about the team it belongs to.
 *
 * A person who makes several digital employees is building a team, and until this existed each of them
 * behaved as if it were the only one: asked for something outside its role it either attempted it
 * anyway or said "I can't", and neither tells the person that a colleague of theirs is the right one to
 * ask. This is the sentence that fixes that, and it is deliberately only a sentence. It names the
 * colleagues so the employee can send the person to the right one, and says who leads.
 *
 * IT PROMISES ONLY WHAT EXISTS. It does not say the employee can message a colleague, because most
 * cannot: asking one directly is a tool, and a tool is a grant someone made. So the instruction is to
 * ask the colleague when a tool says it can and otherwise to say who the person should ask, and never
 * to claim a colleague did anything a tool result does not show.
 *
 * Names and titles are things a person typed, and they go into a prompt, so they are put on one line
 * and cut short here rather than trusted to be well-behaved.
 */

export type TeamMember = {
  id: string;
  name: string;
  title: string;
  /** The one the person made first, or chose, to lead the others. */
  primary: boolean;
};

/** More than this and the list itself is the cost; the rest are counted, not named. */
const MAX_COLLEAGUES = 12;

function line(value: string, limit: number): string {
  const flat = value
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function describe(member: TeamMember): string {
  const name = line(member.name, 60);
  const title = line(member.title, 80);
  return title && title !== name ? `${name} (${title})` : name;
}

/**
 * The team paragraph for one employee, or null when there is nobody else on the team.
 *
 * `team` is everyone the person owns, this employee included.
 */
export function teamGuidance(
  self: { id: string },
  team: readonly TeamMember[],
): string | null {
  const me = team.find((member) => member.id === self.id);
  const colleagues = team.filter((member) => member.id !== self.id);
  if (colleagues.length === 0) return null;

  const named = colleagues.slice(0, MAX_COLLEAGUES).map(describe);
  const more = colleagues.length - named.length;
  const lead = colleagues.find((member) => member.primary);

  return [
    `Your team: you are one digital employee among others, not the only one. Your colleagues are ${named.join("; ")}${more > 0 ? `; and ${more} more` : ""}.`,
    me?.primary
      ? "You are the lead of this team. When a request spans several roles, say which part belongs to which colleague, and bring the answers together once you have them. You have tools for your team: team_list, team_report (a colleague's routines and how they last ran), team_pause_routine (switch one off or back on), team_ask (ask a colleague for work) and team_request_change (ask your owner to change or delete a colleague's routine or rewrite its instructions; nothing changes until they approve, so never say it is done). When the person writes @ and a colleague's name, that is who they want for the work: ask that colleague with team_ask and say you have."
      : lead
        ? `${line(lead.name, 60)} is the lead of this team. You have team_list to see who is on the team and team_ask to ask a colleague for work when you are in the team channel; the lead looks after the colleagues' routines and instructions, so ask the lead rather than changing anyone's work yourself.`
        : "",
    "The person you are talking to is your manager. When a task belongs to a colleague's role, say so by name and say what you would ask them. Ask them directly only if you were given a tool for it; otherwise ask the person to bring that colleague in. Never say a colleague did something unless a tool result shows it. If nobody on the team can settle a question, say so plainly and suggest the person contacts ArkAgent support.",
  ]
    .filter(Boolean)
    .join(" ");
}
