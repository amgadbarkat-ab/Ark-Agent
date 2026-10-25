import type { CategoryId } from "../../../shared/marketplace";
import { TEAMWORK } from "../agents/team";
import {
  type ConnectionRequest,
  type McpRequest,
  ROLES,
  type RoleSkill,
  type RoleSpec,
} from "./official-roles";

export type { ConnectionRequest, McpRequest, RoleSkill };

/**
 * Ark's own digital employees: the listings anyone can install.
 *
 * Curated by hand and kept in code on purpose. Anything a person can install becomes a digital employee that
 * answers for the company, so what these say is reviewed like code is, and `syncOfficial` writes them to the
 * database at start-up. The words themselves are in `official-roles.ts`. Change the text, raise `version`,
 * deploy.
 *
 * What an install gives a person is a digital employee with a name, a title and a standing instruction that
 * says who it is, what its work is, who it works with and what it can do; plus the role's skills, added to the
 * person's own skills and switched on for that employee. It gets no tools and no access to anything: a person
 * grants those afterwards, one at a time, exactly as they would for a digital employee they made themselves.
 * The connections and servers a role lists are requests, shown on the page and told to the employee so it can
 * ask for them. They grant nothing.
 *
 * Every instruction ends the same way, and not by accident: a digital employee that is unsure must say so. The
 * failure this guards against is a confident, specific, invented answer, which reads exactly like a correct one.
 */
export type OfficialRole = Pick<
  RoleSpec,
  | "iam"
  | "duties"
  | "worksWith"
  | "supportedBy"
  | "canDo"
  | "outreach"
  | "skills"
  | "connections"
  | "mcpServers"
>;

export type OfficialListing = {
  /** The page's address. Never changes once published. */
  slug: string;
  /** Raise when the text changes, so an install records which text it got. */
  version: number;
  title: string;
  summary: string;
  category: CategoryId;
  tags: string[];
  description: string;
  install: {
    name: string;
    title: string;
    /** At most 1000 characters: a digital employee's role description is limited to that. */
    roleDescription: string;
  };
  /** The names of the connections and servers it asks for, for the card on the page. */
  suggestedTools: string[];
  role: OfficialRole;
};

/**
 * How an employee chooses its words. Every role works in the three languages its people use.
 *
 * The roles never mentioned Greek or Arabic, so a Greek-speaking owner got English back until they
 * asked twice. Names, figures and legal terms are named as the things a translation must not change.
 */
export const LANGUAGE =
  "Language: reply in the language the person writes to you in. You work in Greek, English and Arabic; when you translate or write in one of them, keep names, numbers, dates and legal terms exact. If you cannot tell which language to use, ask in one short line.";

/**
 * What a role that writes to people outside the company must do. Only for roles flagged `outreach`.
 *
 * Draft only, because a message sent in the owner's name is theirs to send, and the opt-out line
 * because an unsolicited message without one is the owner's legal problem. The Greek and English
 * lines are the approved wording; there is no approved Arabic one, so it is asked for and never made up.
 */
export const OUTREACH =
  'Outreach rules: you only write drafts. A named person approves every message before it is sent, and you never send, pay or submit anything yourself. End every message to a person outside the company with the approved opt-out line, in the language of the message. Greek: «Αν δεν επιθυμείτε να λαμβάνετε άλλα μηνύματα, απαντήστε «ΔΙΑΓΡΑΦΗ».» English: "If you\'d rather not hear from us again, just reply "unsubscribe"." There is no approved Arabic line: ask the person for it instead of translating one.';

export const HONESTY =
  "If you are not sure, say so and say what you would need to find out. Never invent facts, figures, quotes or sources. Ask before doing anything that changes something outside this conversation.";

function bullets(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

/**
 * The standing instruction an install writes: the whole of who this digital employee is.
 *
 * `company` is the name on the person's account when it is a company name, and null when it is an email
 * address or nothing at all, in which case the employee says it works for the person who set it up rather
 * than naming something it was not told.
 *
 * It promises only what exists. A colleague on the person's team is asked through the team tools, which the
 * team paragraph describes for this employee; anyone else, it says what it would ask and asks the person to
 * bring them in (see `TEAMWORK`).
 */
export function composeInstruction(
  listing: { title: string; role: OfficialRole },
  company: string | null,
): string {
  const { title, role } = listing;
  const where = company ? ` at ${company}` : "";
  const skills = role.skills
    .map((skill) => `/${skill.slug} (${skill.title})`)
    .join("; ");
  const connections = role.connections
    .map((request) => `${request.app} (${request.why})`)
    .join("; ");
  const servers = role.mcpServers
    .map((request) => `${request.server} (${request.why})`)
    .join("; ");
  return [
    `You are ${title}${where}, ${role.iam}. You are a digital employee in a digital team, not a general assistant.`,
    `When anyone asks who you are, what you do or what you can do, answer in the first person as this role: say you are ${role.iam}${company ? ` for ${company}` : ""}, then your work, who you work with, who supports you and what you can do. Do not open with a generic greeting or a list of vague abilities.`,
    `My work:\n${bullets(role.duties)}`,
    `I work with:\n${bullets(role.worksWith)}`,
    `I am supported by:\n${bullets(role.supportedBy)}`,
    `What I can do:\n${bullets(role.canDo)}`,
    `Skills I use, which are on your Skills page: ${skills}.`,
    `To do this work well I will ask you to connect these accounts: ${connections}. And these servers: ${servers}. They only work once you connect them. If something I need is not connected, I say so plainly and ask you to connect it in Settings; I never pretend I used it.`,
    LANGUAGE,
    ...(role.outreach ? [OUTREACH] : []),
    TEAMWORK,
    HONESTY,
  ].join("\n\n");
}

function uniqueNames(role: OfficialRole): string[] {
  return [
    ...new Set([
      ...role.connections.map((request) => request.app),
      ...role.mcpServers.map((request) => request.server),
    ]),
  ];
}

export const OFFICIAL_LISTINGS: OfficialListing[] = ROLES.map((spec) => ({
  slug: spec.slug,
  version: spec.version,
  title: spec.title,
  summary: spec.summary,
  category: spec.category,
  tags: spec.tags,
  description: spec.description,
  install: {
    name: spec.title,
    title: spec.title,
    roleDescription: spec.roleDescription,
  },
  suggestedTools: uniqueNames(spec),
  role: {
    iam: spec.iam,
    duties: spec.duties,
    worksWith: spec.worksWith,
    supportedBy: spec.supportedBy,
    canDo: spec.canDo,
    ...(spec.outreach ? { outreach: true } : {}),
    skills: spec.skills,
    connections: spec.connections,
    mcpServers: spec.mcpServers,
  },
}));
