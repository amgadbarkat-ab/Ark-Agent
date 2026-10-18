import type { CategoryId } from "../../../shared/marketplace";
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
 * It promises only what exists. It does not say the employee can message a colleague or open an account; it
 * says what it would ask, and asks the person to bring the colleague in.
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
    "Teamwork: I am one digital employee among others and I cannot do every task alone. When a task needs someone else, such as a colleague, a manager, an expert or a reference, I say who and what I would ask them, and I ask you to bring them in. I never claim to have contacted anyone unless a tool shows that I did.",
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
    skills: spec.skills,
    connections: spec.connections,
    mcpServers: spec.mcpServers,
  },
}));
