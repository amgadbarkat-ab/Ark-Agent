import { randomBytes } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  ilike,
  isNull,
  lt,
  ne,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import {
  isCategory,
  LIMITS,
  type ListingKind,
  type ListingStatus,
  REPORT_REASONS,
  slugify,
} from "../../../shared/marketplace";
import type { AccountStore } from "../accounts/store";
import type { AgentProfileStore } from "../agents/profile-store";
import type { AgentActor } from "../agents/profile-types";
import type { Database } from "../db/client";
import {
  agentProfiles,
  agents,
  marketplaceInstalls,
  marketplaceListings,
  marketplacePublishers,
  marketplaceReports,
  pluginGrants,
  tenants,
} from "../db/schema";
import {
  composeInstruction,
  OFFICIAL_LISTINGS,
  type OfficialListing,
  type OfficialRole,
} from "./official";
import { type Finding, judge } from "./sanitize";

/**
 * The marketplace, as one object the routes talk to.
 *
 * Two kinds of listing and one rule that separates them (decision D7): an OFFICIAL listing is one of
 * Ark's digital employees and can be installed into any account; a SHARED listing is somebody's own
 * coworker, published so others can read how it was set up, and can be read and nothing else. There
 * is no function in this file that turns a shared listing into a coworker. That is not a check that
 * could be forgotten; the operation does not exist. `install` refuses a shared listing, and even if
 * it did not, a shared listing's content is text taken out of a coworker, cleaned, with the address
 * and every key left behind: there is nothing in it to build a coworker from.
 *
 * Every function here that changes something takes the person doing it, because who may do what is
 * decided here and not in the routes, which only translate.
 */

export type MarketplaceErrorCode =
  | "not_found"
  | "forbidden"
  | "invalid"
  | "limit"
  | "conflict"
  | "view_only"
  | "unclean";

export class MarketplaceError extends Error {
  constructor(
    readonly code: MarketplaceErrorCode,
    message: string,
    /** For "unclean": what was found and where, never the text itself. */
    readonly findings: Finding[] = [],
  ) {
    super(message);
    this.name = "MarketplaceError";
  }
}

export type PublisherSummary = {
  id: string;
  displayName: string;
  official: boolean;
};

export type PublisherProfile = PublisherSummary & { bio: string };

export type ListingCard = {
  id: string;
  slug: string;
  kind: ListingKind;
  title: string;
  summary: string;
  category: string;
  tags: string[];
  publisher: PublisherSummary;
  installCount: number;
  publishedAt: string | null;
  version: number;
};

export type OfficialContent = {
  install: { name: string; title: string; roleDescription: string };
  suggestedTools: string[];
  /** Who the digital employee is, its skills and what it will ask to be connected. Empty on older rows. */
  role: OfficialRole;
};

const NO_ROLE: OfficialRole = {
  iam: "",
  duties: [],
  worksWith: [],
  supportedBy: [],
  canDo: [],
  skills: [],
  connections: [],
  mcpServers: [],
};

/** What a shared listing shows: text read out of a coworker, and nothing it could be rebuilt from. */
export type SharedContent = {
  title: string;
  roleDescription: string;
  /** The standing instruction, for a coworker that runs on one. Absent otherwise. */
  instructions?: string;
  /** Names of the tools it was allowed to use. Names only: no server, no address, no key. */
  tools: string[];
};

export type ListingDetail = ListingCard & {
  description: string;
  content: OfficialContent | SharedContent;
  /** Whether it belongs to the viewer's account. The browser renders this; it never works it out. */
  mine: boolean;
  /** Only for the person it belongs to, and for staff. */
  status?: ListingStatus;
  reviewNote?: string | null;
  /** Whether this person has already put an official listing into their account. */
  installedByMe?: boolean;
};

export type ListingFields = {
  title: string;
  summary: string;
  category: string;
  tags: string[];
  description: string;
};

export type ShareInput = ListingFields & {
  /** The coworker to share. Taken as it is now; later changes to it do not change the listing. */
  agentId: string;
  /** The publisher says they read it through and it holds nothing private. */
  confirmedNoPrivateData: boolean;
};

export type UpdateInput = ListingFields & {
  /** Take a fresh copy of this coworker. Absent keeps what the listing already shows. */
  agentId?: string;
  confirmedNoPrivateData: boolean;
};

export type BrowseQuery = {
  q?: string;
  category?: string;
  kind?: ListingKind;
  cursor?: string;
  limit?: number;
};

export type ReportRow = {
  id: string;
  reason: string;
  details: string;
  createdAt: string;
  listing: {
    id: string;
    slug: string;
    title: string;
    status: ListingStatus;
    publisherName: string;
  };
};

export type MyListings = {
  publisher: PublisherProfile | null;
  listings: Array<
    ListingCard & { status: ListingStatus; reviewNote: string | null }
  >;
};

type Viewer = { id: string; role: "admin" | "user" };

export type MarketplaceStore = {
  /** Write Ark's own listings to the database. Safe to call on every start. */
  syncOfficial(): Promise<void>;
  browse(
    viewer: Viewer,
    query?: BrowseQuery,
  ): Promise<{ listings: ListingCard[]; nextCursor: string | null }>;
  get(viewer: Viewer, slug: string): Promise<ListingDetail>;
  /** Put an official listing into the person's own account as a coworker of theirs. */
  install(
    actor: AgentActor,
    slug: string,
  ): Promise<{ agentId: string; name: string }>;
  publisherPage(
    publisherId: string,
  ): Promise<{ publisher: PublisherProfile; listings: ListingCard[] }>;
  mine(actor: Viewer): Promise<MyListings>;
  savePublisher(
    actor: Viewer,
    input: { displayName: string; bio: string },
  ): Promise<PublisherProfile>;
  share(actor: AgentActor, input: ShareInput): Promise<ListingDetail>;
  update(
    actor: AgentActor,
    listingId: string,
    input: UpdateInput,
  ): Promise<ListingDetail>;
  withdraw(actor: Viewer, listingId: string): Promise<void>;
  report(
    actor: Viewer,
    slug: string,
    input: { reason: string; details: string },
  ): Promise<void>;
  // Staff.
  pending(
    staff: Viewer,
    query?: { cursor?: string; limit?: number },
  ): Promise<{ listings: ListingDetail[]; nextCursor: string | null }>;
  approve(staff: Viewer, listingId: string): Promise<void>;
  reject(staff: Viewer, listingId: string, note: string): Promise<void>;
  remove(staff: Viewer, listingId: string, note: string): Promise<void>;
  reports(
    staff: Viewer,
    query?: { cursor?: string; limit?: number },
  ): Promise<{ reports: ReportRow[]; nextCursor: string | null }>;
  dismissReport(staff: Viewer, reportId: string): Promise<void>;
};

const PAGE_DEFAULT = 24;
const PAGE_MAX = 60;

function pageSize(requested: number | undefined): number {
  return Math.min(Math.max(requested ?? PAGE_DEFAULT, 1), PAGE_MAX);
}

function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`).toString("base64url");
}

function decodeCursor(cursor: string): { at: Date; id: string } {
  const [stamp, id] = Buffer.from(cursor, "base64url").toString().split("|");
  const at = new Date(stamp ?? "");
  if (Number.isNaN(at.getTime()) || !id) {
    throw new MarketplaceError("invalid", "That page cursor is not valid.");
  }
  return { at, id };
}

/** `%` and `_` in what somebody typed mean themselves, not "anything". */
function likePattern(term: string): string {
  return `%${term.replace(/[%_\\]/g, "\\$&")}%`;
}

function requireStaff(person: Viewer) {
  if (person.role !== "admin") {
    throw new MarketplaceError("forbidden", "Only our staff can do that.");
  }
}

/** Whether the database refused a write because of this unique index. */
function isUniqueViolation(error: unknown, constraint: string): boolean {
  const cause = (error as { cause?: { errno?: unknown; constraint?: unknown } })
    ?.cause;
  return cause?.errno === "23505" && cause.constraint === constraint;
}

/**
 * A display name is how strangers tell publishers apart, so it has to be hard to fake. Ark's own
 * listings are by "Ark"; nobody else may look like that, however they space or punctuate it.
 */
const RESERVED_NAMES = new Set([
  "ark",
  "official",
  "staff",
  "admin",
  "support",
]);
const RESERVED_PREFIXES = [
  "arkagent",
  "arkofficial",
  "arkteam",
  "arksupport",
  "arkstaff",
];

function nameProblem(name: string): string | undefined {
  if (name.length === 0 || name.length > LIMITS.displayName) {
    return `A name of 1 to ${LIMITS.displayName} characters is required.`;
  }
  const folded = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  if (
    folded.length === 0 ||
    RESERVED_NAMES.has(folded) ||
    RESERVED_PREFIXES.some((prefix) => folded.startsWith(prefix))
  ) {
    return "That name is reserved. Choose another.";
  }
  if (judge({ name }, { confirmedNoPrivateData: false }).ok === false) {
    return "A name must not contain an email address, phone number or any other private detail.";
  }
  return undefined;
}

function cleanFields(input: ListingFields): ListingFields {
  const title = input.title.trim();
  const summary = input.summary.trim();
  const description = input.description.trim();
  const category = input.category.trim();
  const tags = [
    ...new Set(
      input.tags
        .map((tag) => tag.trim().toLowerCase())
        .filter((tag) => tag.length > 0),
    ),
  ];
  const problems: string[] = [];
  if (title.length === 0 || title.length > LIMITS.title) {
    problems.push(`The title needs 1 to ${LIMITS.title} characters.`);
  }
  if (summary.length === 0 || summary.length > LIMITS.summary) {
    problems.push(`The summary needs 1 to ${LIMITS.summary} characters.`);
  }
  if (description.length > LIMITS.description) {
    problems.push(
      `The description can be at most ${LIMITS.description} characters.`,
    );
  }
  if (!isCategory(category)) problems.push("Choose a category from the list.");
  if (tags.length > LIMITS.tags) {
    problems.push(`Use at most ${LIMITS.tags} tags.`);
  }
  if (
    tags.some(
      (tag) =>
        tag.length > LIMITS.tagLength || !/^[a-z0-9][a-z0-9 -]*$/.test(tag),
    )
  ) {
    problems.push(
      `A tag is letters, numbers, spaces and dashes, at most ${LIMITS.tagLength} characters.`,
    );
  }
  if (problems.length > 0) {
    throw new MarketplaceError("invalid", problems.join(" "));
  }
  return { title, summary, category, tags, description };
}

/** Everything a stranger will read, named for the person who has to fix it. */
function scannedText(
  fields: ListingFields,
  content: SharedContent,
): Record<string, string | undefined> {
  return {
    Title: fields.title,
    Summary: fields.summary,
    Description: fields.description,
    Tags: fields.tags.join("\n"),
    "Role description": content.roleDescription,
    Instructions: content.instructions,
    Tools: content.tools.join("\n"),
  };
}

function assertClean(
  fields: ListingFields,
  content: SharedContent,
  confirmedNoPrivateData: boolean,
) {
  const verdict = judge(scannedText(fields, content), {
    confirmedNoPrivateData,
  });
  if (verdict.ok) return;
  const findings = [...verdict.secrets, ...verdict.privateData];
  throw new MarketplaceError(
    "unclean",
    verdict.secrets.length > 0
      ? "This contains a secret. Remove what is listed, then try again."
      : "This may contain private details. Check what is listed, and tick the box to say it is safe to share.",
    findings,
  );
}

function parseOfficialContent(content: unknown): OfficialContent {
  const install = (content as { install?: Record<string, unknown> } | null)
    ?.install;
  if (
    !install ||
    typeof install.name !== "string" ||
    typeof install.title !== "string" ||
    typeof install.roleDescription !== "string"
  ) {
    throw new MarketplaceError(
      "invalid",
      "That listing cannot be installed right now.",
    );
  }
  return {
    install: {
      name: install.name,
      title: install.title,
      roleDescription: install.roleDescription,
    },
    suggestedTools: Array.isArray(
      (content as { suggestedTools?: unknown }).suggestedTools,
    )
      ? ((content as { suggestedTools: unknown[] }).suggestedTools.filter(
          (tool): tool is string => typeof tool === "string",
        ) as string[])
      : [],
    role: parseRole((content as { role?: unknown }).role),
  };
}

function textList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** The role part of an official listing's content, tolerant of rows written before roles had one. */
function parseRole(value: unknown): OfficialRole {
  if (typeof value !== "object" || value === null) return NO_ROLE;
  const role = value as Record<string, unknown>;
  const objects = (field: unknown) =>
    (Array.isArray(field) ? field : []).filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null,
    );
  const text = (item: Record<string, unknown>, key: string) =>
    typeof item[key] === "string" ? (item[key] as string) : "";
  return {
    iam: typeof role.iam === "string" ? role.iam : "",
    duties: textList(role.duties),
    worksWith: textList(role.worksWith),
    supportedBy: textList(role.supportedBy),
    canDo: textList(role.canDo),
    skills: objects(role.skills).map((item) => ({
      slug: text(item, "slug"),
      title: text(item, "title"),
      summary: text(item, "summary"),
      instructions: text(item, "instructions"),
    })),
    connections: objects(role.connections).map((item) => ({
      app: text(item, "app"),
      why: text(item, "why"),
    })),
    mcpServers: objects(role.mcpServers).map((item) => ({
      server: text(
        item,
        "server",
      ) as OfficialRole["mcpServers"][number]["server"],
      why: text(item, "why"),
    })),
  };
}

const cardColumns = {
  id: marketplaceListings.id,
  slug: marketplaceListings.slug,
  kind: marketplaceListings.kind,
  title: marketplaceListings.title,
  summary: marketplaceListings.summary,
  category: marketplaceListings.category,
  tags: marketplaceListings.tags,
  installCount: marketplaceListings.installCount,
  publishedAt: marketplaceListings.publishedAt,
  version: marketplaceListings.version,
  publisherId: marketplacePublishers.id,
  publisherName: marketplacePublishers.displayName,
  publisherOfficial: marketplacePublishers.official,
};

type CardRow = {
  id: string;
  slug: string;
  kind: ListingKind;
  title: string;
  summary: string;
  category: string;
  tags: string[];
  installCount: number;
  publishedAt: Date | null;
  version: number;
  publisherId: string;
  publisherName: string;
  publisherOfficial: boolean;
};

function toCard(row: CardRow): ListingCard {
  return {
    id: row.id,
    slug: row.slug,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    category: row.category,
    tags: row.tags,
    publisher: {
      id: row.publisherId,
      displayName: row.publisherName,
      official: row.publisherOfficial,
    },
    installCount: row.installCount,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    version: row.version,
  };
}

export function createMarketplaceStore(
  database: Database,
  dependencies: {
    accounts: AccountStore;
    profiles: AgentProfileStore;
    /** For tests: a different set of official listings than the real ones. */
    official?: OfficialListing[];
    /**
     * What an install uses to add the role's skills to the person's own and switch them on for the new
     * digital employee. Absent in a test that does not care, in which case an install adds none.
     */
    skills?: {
      install: (input: {
        slug: string;
        title: string;
        summary: string;
        instructions: string;
        origin: string;
        ownerUserId: string;
        by: string;
      }) => Promise<{ id: string }>;
      grant: (
        kind: "skill",
        ref: string,
        agentId: string,
        by: string,
      ) => Promise<void>;
    };
  },
): MarketplaceStore {
  const { accounts, profiles } = dependencies;
  const officialListings = dependencies.official ?? OFFICIAL_LISTINGS;

  /**
   * The company's name for a digital employee to use, or null.
   *
   * An account's name is "their email or company name", so an address is not offered as a company: saying
   * "I work at someone@example.com" would be wrong in a way the person would notice at once.
   */
  async function companyName(tenantId: string): Promise<string | null> {
    const [row] = await database
      .select({ name: tenants.name })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const name = row?.name?.trim();
    if (!name || name.includes("@")) return null;
    return name.slice(0, 120);
  }

  /**
   * Adds the role's skills to the person's own and switches them on for the new employee.
   *
   * Skills are instructions only and declare no tools, so they load without granting anything. One that
   * cannot be added is reported and skipped rather than undoing an employee that now exists: the person can
   * add it by hand from the skills page.
   */
  async function addRoleSkills(
    actor: AgentActor,
    agentId: string,
    listingSlug: string,
    role: OfficialRole,
  ) {
    if (!dependencies.skills) return;
    for (const skill of role.skills) {
      try {
        const saved = await dependencies.skills.install({
          slug: skill.slug,
          title: skill.title,
          summary: skill.summary,
          instructions: skill.instructions,
          origin: `marketplace:${listingSlug}`,
          ownerUserId: actor.id,
          by: actor.id,
        });
        await dependencies.skills.grant("skill", saved.id, agentId, actor.id);
      } catch (error) {
        console.error(
          `Could not add the skill /${skill.slug} for ${listingSlug}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  async function publisherForTenant(
    tenantId: string,
  ): Promise<PublisherProfile | null> {
    const [row] = await database
      .select({
        id: marketplacePublishers.id,
        displayName: marketplacePublishers.displayName,
        bio: marketplacePublishers.bio,
        official: marketplacePublishers.official,
      })
      .from(marketplacePublishers)
      .where(eq(marketplacePublishers.tenantId, tenantId))
      .limit(1);
    return row ?? null;
  }

  /** The publisher face of this person's account, if they have made one. */
  async function myPublisher(person: Viewer): Promise<PublisherProfile | null> {
    const tenantId = await accounts.tenantIdForUser(person.id);
    return tenantId ? publisherForTenant(tenantId) : null;
  }

  async function loadListing(id: string) {
    return loadListingWhere(eq(marketplaceListings.id, id));
  }

  async function loadListingWhere(condition: SQL) {
    const [row] = await database
      .select({
        ...cardColumns,
        description: marketplaceListings.description,
        content: marketplaceListings.content,
        status: marketplaceListings.status,
        reviewNote: marketplaceListings.reviewNote,
        publisherTenantId: marketplacePublishers.tenantId,
      })
      .from(marketplaceListings)
      .innerJoin(
        marketplacePublishers,
        eq(marketplacePublishers.id, marketplaceListings.publisherId),
      )
      .where(condition)
      .limit(1);
    return row;
  }

  /** A listing of the caller's own account, or "no such listing": never a hint that it exists. */
  async function ownListing(person: Viewer, listingId: string) {
    const [tenantId, listing] = await Promise.all([
      accounts.tenantIdForUser(person.id),
      loadListing(listingId),
    ]);
    if (
      listing?.kind !== "shared" ||
      !tenantId ||
      listing.publisherTenantId !== tenantId
    ) {
      throw new MarketplaceError("not_found", "No such listing.");
    }
    return { listing, tenantId };
  }

  /**
   * What a coworker looks like to a stranger: its words and the names of its tools.
   *
   * Read from the database directly rather than through the profile store, which hands back the
   * address and whether a key exists. This takes only the four things worth showing, so there is no
   * path from a coworker's endpoint or credentials to a listing.
   */
  async function snapshotOf(
    actor: AgentActor,
    agentId: string,
  ): Promise<SharedContent> {
    const [row] = await database
      .select({
        type: agents.type,
        configuration: agents.configuration,
        title: agentProfiles.title,
        roleDescription: agentProfiles.roleDescription,
      })
      .from(agents)
      .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
      .where(
        and(
          eq(agents.id, agentId),
          // Only a coworker the person made. Ark's own and other people's are not theirs to publish.
          eq(agentProfiles.ownerUserId, actor.id),
          isNull(agentProfiles.deletedAt),
        ),
      )
      .limit(1);
    if (!row) {
      throw new MarketplaceError(
        "not_found",
        "Choose one of your own coworkers to share.",
      );
    }
    const prompt =
      row.type === "built_in"
        ? (row.configuration as { systemPrompt?: unknown } | null)?.systemPrompt
        : undefined;
    const grants = await database
      .select({ ref: pluginGrants.ref })
      .from(pluginGrants)
      .where(
        and(eq(pluginGrants.agentId, agentId), eq(pluginGrants.kind, "mcp")),
      );
    const tools = [
      ...new Set(
        grants.map((grant) => grant.ref.slice(grant.ref.indexOf("/") + 1)),
      ),
    ]
      .sort()
      .slice(0, LIMITS.toolsShown);
    return {
      title: row.title,
      roleDescription: row.roleDescription,
      ...(typeof prompt === "string" && prompt.trim().length > 0
        ? { instructions: prompt.trim() }
        : {}),
      tools,
    };
  }

  async function detailOf(
    viewer: Viewer,
    row: NonNullable<Awaited<ReturnType<typeof loadListing>>>,
  ): Promise<ListingDetail> {
    const tenantId = await accounts.tenantIdForUser(viewer.id);
    const mine =
      row.kind === "shared" &&
      Boolean(tenantId) &&
      row.publisherTenantId === tenantId;
    const showState = mine || viewer.role === "admin";
    let installedByMe: boolean | undefined;
    if (row.kind === "official") {
      const [installed] = await database
        .select({ id: marketplaceInstalls.id })
        .from(marketplaceInstalls)
        .where(
          and(
            eq(marketplaceInstalls.listingId, row.id),
            eq(marketplaceInstalls.userId, viewer.id),
          ),
        )
        .limit(1);
      installedByMe = Boolean(installed);
    }
    return {
      ...toCard(row),
      description: row.description,
      content: row.content as OfficialContent | SharedContent,
      mine,
      ...(showState ? { status: row.status, reviewNote: row.reviewNote } : {}),
      ...(installedByMe !== undefined ? { installedByMe } : {}),
    };
  }

  async function pendingCount(publisherId: string): Promise<number> {
    const [row] = await database
      .select({ count: sql<number>`count(*)::int` })
      .from(marketplaceListings)
      .where(
        and(
          eq(marketplaceListings.publisherId, publisherId),
          eq(marketplaceListings.status, "pending"),
        ),
      );
    return row?.count ?? 0;
  }

  return {
    async syncOfficial() {
      const now = new Date();
      let [publisher] = await database
        .select({ id: marketplacePublishers.id })
        .from(marketplacePublishers)
        .where(eq(marketplacePublishers.official, true))
        .limit(1);
      if (!publisher) {
        await database
          .insert(marketplacePublishers)
          .values({
            displayName: "Ark",
            bio: "Digital employees made by the Ark team.",
            official: true,
          })
          .onConflictDoNothing();
        [publisher] = await database
          .select({ id: marketplacePublishers.id })
          .from(marketplacePublishers)
          .where(eq(marketplacePublishers.official, true))
          .limit(1);
      }
      if (!publisher) {
        throw new Error(
          'The name "Ark" is already taken by another publisher; free it before starting.',
        );
      }
      for (const listing of officialListings) {
        const values = {
          kind: "official" as const,
          slug: listing.slug,
          publisherId: publisher.id,
          title: listing.title,
          summary: listing.summary,
          category: listing.category,
          tags: listing.tags,
          description: listing.description,
          content: {
            install: listing.install,
            suggestedTools: listing.suggestedTools,
            role: listing.role,
          },
          status: "published" as const,
          reviewNote: null,
          version: listing.version,
          updatedAt: now,
        };
        await database
          .insert(marketplaceListings)
          .values({ ...values, publishedAt: now, createdAt: now })
          .onConflictDoUpdate({
            target: marketplaceListings.slug,
            set: values,
            // Only ever our own row. A shared listing cannot have this slug, and if one somehow did,
            // it would be left alone rather than overwritten with an installable one.
            setWhere: eq(marketplaceListings.kind, "official"),
          });
      }
      // One that is no longer in the catalogue is taken down, not deleted: installs point at it.
      await database
        .update(marketplaceListings)
        .set({ status: "removed", updatedAt: now })
        .where(
          and(
            eq(marketplaceListings.kind, "official"),
            eq(marketplaceListings.status, "published"),
            officialListings.length > 0
              ? notInArray(
                  marketplaceListings.slug,
                  officialListings.map((listing) => listing.slug),
                )
              : undefined,
          ),
        );
    },

    async browse(_viewer, query = {}) {
      const limit = pageSize(query.limit);
      const filters: SQL[] = [eq(marketplaceListings.status, "published")];
      if (query.kind) filters.push(eq(marketplaceListings.kind, query.kind));
      if (query.category) {
        filters.push(eq(marketplaceListings.category, query.category));
      }
      const terms = (query.q ?? "")
        .trim()
        .split(/\s+/)
        .filter((term) => term.length > 0)
        .slice(0, 5);
      for (const term of terms) {
        const like = likePattern(term.slice(0, 60));
        filters.push(
          or(
            ilike(marketplaceListings.title, like),
            ilike(marketplaceListings.summary, like),
            sql`array_to_string(${marketplaceListings.tags}, ' ') ilike ${like}`,
          ) as SQL,
        );
      }
      if (query.cursor) {
        const { at, id } = decodeCursor(query.cursor);
        filters.push(
          or(
            lt(marketplaceListings.publishedAt, at),
            and(
              eq(marketplaceListings.publishedAt, at),
              lt(marketplaceListings.id, id),
            ),
          ) as SQL,
        );
      }
      const rows = await database
        .select(cardColumns)
        .from(marketplaceListings)
        .innerJoin(
          marketplacePublishers,
          eq(marketplacePublishers.id, marketplaceListings.publisherId),
        )
        .where(and(...filters))
        .orderBy(
          desc(marketplaceListings.publishedAt),
          desc(marketplaceListings.id),
        )
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        listings: page.map(toCard),
        nextCursor:
          rows.length > limit && last?.publishedAt
            ? encodeCursor(last.publishedAt, last.id)
            : null,
      };
    },

    async get(viewer, slug) {
      const row = await loadListingWhere(eq(marketplaceListings.slug, slug));
      if (!row) throw new MarketplaceError("not_found", "No such listing.");
      const detail = await detailOf(viewer, row);
      // Not yet public: only its owner and our staff may see it. To anyone else it does not exist.
      if (
        row.status !== "published" &&
        !detail.mine &&
        viewer.role !== "admin"
      ) {
        throw new MarketplaceError("not_found", "No such listing.");
      }
      return detail;
    },

    async install(actor, slug) {
      const listing = await loadListingWhere(
        eq(marketplaceListings.slug, slug),
      );
      if (listing?.status !== "published") {
        throw new MarketplaceError("not_found", "No such listing.");
      }
      if (listing.kind !== "official") {
        throw new MarketplaceError(
          "view_only",
          "A shared coworker is for reading. It cannot be installed, copied or exported.",
        );
      }
      const { install, role } = parseOfficialContent(listing.content);
      const tenantId = await accounts.ensureTenant(actor.id);
      const company = await companyName(tenantId);
      const instruction = role.iam
        ? composeInstruction({ title: install.title, role }, company)
        : install.roleDescription;
      const profile = await profiles.create(actor, {
        name: install.name,
        title: install.title,
        roleDescription: install.roleDescription,
        // Private to the person who installed it, like anything they make. They may share it with
        // their account afterwards, and grant it tools one at a time.
        visibility: "private",
        // A listing written before roles had a persona has nothing to compose from, and runs on its role
        // description as it always did.
        systemPrompt: instruction,
        ...(role.iam ? { persona: instruction } : {}),
      });
      await addRoleSkills(actor, profile.id, listing.slug, role);
      await database.transaction(async (transaction) => {
        await transaction.insert(marketplaceInstalls).values({
          listingId: listing.id,
          tenantId,
          userId: actor.id,
          agentId: profile.id,
          version: listing.version,
        });
        await transaction
          .update(marketplaceListings)
          .set({
            installCount: sql`${marketplaceListings.installCount} + 1`,
          })
          .where(eq(marketplaceListings.id, listing.id));
      });
      return { agentId: profile.id, name: profile.name };
    },

    async publisherPage(publisherId) {
      const [publisher] = await database
        .select({
          id: marketplacePublishers.id,
          displayName: marketplacePublishers.displayName,
          bio: marketplacePublishers.bio,
          official: marketplacePublishers.official,
        })
        .from(marketplacePublishers)
        .where(eq(marketplacePublishers.id, publisherId))
        .limit(1);
      if (!publisher) {
        throw new MarketplaceError("not_found", "No such publisher.");
      }
      const rows = await database
        .select(cardColumns)
        .from(marketplaceListings)
        .innerJoin(
          marketplacePublishers,
          eq(marketplacePublishers.id, marketplaceListings.publisherId),
        )
        .where(
          and(
            eq(marketplaceListings.publisherId, publisherId),
            eq(marketplaceListings.status, "published"),
          ),
        )
        .orderBy(
          desc(marketplaceListings.publishedAt),
          desc(marketplaceListings.id),
        )
        .limit(PAGE_MAX);
      return { publisher, listings: rows.map(toCard) };
    },

    async mine(person) {
      const publisher = await myPublisher(person);
      if (!publisher) return { publisher: null, listings: [] };
      const rows = await database
        .select({
          ...cardColumns,
          status: marketplaceListings.status,
          reviewNote: marketplaceListings.reviewNote,
        })
        .from(marketplaceListings)
        .innerJoin(
          marketplacePublishers,
          eq(marketplacePublishers.id, marketplaceListings.publisherId),
        )
        .where(eq(marketplaceListings.publisherId, publisher.id))
        .orderBy(
          desc(marketplaceListings.createdAt),
          desc(marketplaceListings.id),
        )
        .limit(LIMITS.listingsPerAccount);
      return {
        publisher,
        listings: rows.map((row) => ({
          ...toCard(row),
          status: row.status,
          reviewNote: row.reviewNote,
        })),
      };
    },

    async savePublisher(person, input) {
      const displayName = input.displayName.trim();
      const bio = input.bio.trim();
      const problem = nameProblem(displayName);
      if (problem) throw new MarketplaceError("invalid", problem);
      if (bio.length > LIMITS.bio) {
        throw new MarketplaceError(
          "invalid",
          `The introduction can be at most ${LIMITS.bio} characters.`,
        );
      }
      if (judge({ bio }, { confirmedNoPrivateData: false }).ok === false) {
        throw new MarketplaceError(
          "invalid",
          "The introduction must not contain an email address, phone number, key or other private detail.",
        );
      }
      const tenantId = await accounts.ensureTenant(person.id);
      try {
        const [row] = await database
          .insert(marketplacePublishers)
          .values({ tenantId, displayName, bio })
          .onConflictDoUpdate({
            target: marketplacePublishers.tenantId,
            set: { displayName, bio },
          })
          .returning({
            id: marketplacePublishers.id,
            displayName: marketplacePublishers.displayName,
            bio: marketplacePublishers.bio,
            official: marketplacePublishers.official,
          });
        if (!row) throw new Error("The publisher was not saved.");
        return row;
      } catch (error) {
        if (isUniqueViolation(error, "marketplace_publishers_name_key")) {
          throw new MarketplaceError(
            "conflict",
            "Somebody already uses that name. Choose another.",
          );
        }
        throw error;
      }
    },

    async share(actor, input) {
      const fields = cleanFields(input);
      const tenantId = await accounts.ensureTenant(actor.id);
      const publisher = await publisherForTenant(tenantId);
      if (!publisher) {
        throw new MarketplaceError(
          "invalid",
          "Choose the name other people will see before you share.",
        );
      }
      const content = await snapshotOf(actor, input.agentId);
      assertClean(fields, content, input.confirmedNoPrivateData);

      const id = await database.transaction(async (transaction) => {
        // Two requests from one account must not both squeeze under the limits.
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`marketplace-submit:${publisher.id}`}))`,
        );
        const [counts] = await transaction
          .select({
            total: sql<number>`count(*)::int`,
            pending: sql<number>`count(*) filter (where ${marketplaceListings.status} = 'pending')::int`,
          })
          .from(marketplaceListings)
          .where(eq(marketplaceListings.publisherId, publisher.id));
        if ((counts?.pending ?? 0) >= LIMITS.pendingPerAccount) {
          throw new MarketplaceError(
            "limit",
            `You already have ${LIMITS.pendingPerAccount} listings waiting for review. Wait for those first.`,
          );
        }
        if ((counts?.total ?? 0) >= LIMITS.listingsPerAccount) {
          throw new MarketplaceError(
            "limit",
            `An account can have at most ${LIMITS.listingsPerAccount} listings.`,
          );
        }
        const now = new Date();
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const [inserted] = await transaction
            .insert(marketplaceListings)
            .values({
              kind: "shared",
              // A random tail, so that a title cannot be used to find out whether another account
              // has a listing of that name, and two of the same title are not an error.
              slug: `${slugify(fields.title)}-${randomBytes(3).toString("hex")}`,
              publisherId: publisher.id,
              ...fields,
              content,
              status: "pending",
              sourceAgentId: input.agentId,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoNothing({ target: marketplaceListings.slug })
            .returning({ id: marketplaceListings.id });
          if (inserted) return inserted.id;
        }
        throw new Error("Could not find a free address for the listing.");
      });
      const row = await loadListing(id);
      if (!row) throw new Error("The listing was not saved.");
      return detailOf(actor, row);
    },

    async update(actor, listingId, input) {
      const fields = cleanFields(input);
      const { listing } = await ownListing(actor, listingId);
      if (listing.status === "removed") {
        throw new MarketplaceError(
          "forbidden",
          "Our staff took this listing down, so it cannot be changed. You can share it again as a new listing once it is fixed.",
        );
      }
      const content = input.agentId
        ? await snapshotOf(actor, input.agentId)
        : (listing.content as SharedContent);
      assertClean(fields, content, input.confirmedNoPrivateData);
      await database.transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`marketplace-submit:${listing.publisherId}`}))`,
        );
        if (
          listing.status !== "pending" &&
          (await pendingCount(listing.publisherId)) >= LIMITS.pendingPerAccount
        ) {
          throw new MarketplaceError(
            "limit",
            `You already have ${LIMITS.pendingPerAccount} listings waiting for review. Wait for those first.`,
          );
        }
        // Any change goes back for review, so a clean listing cannot be swapped for a dirty one
        // after it was approved.
        await transaction
          .update(marketplaceListings)
          .set({
            ...fields,
            content,
            status: "pending",
            reviewNote: null,
            publishedAt: null,
            version: sql`${marketplaceListings.version} + 1`,
            ...(input.agentId ? { sourceAgentId: input.agentId } : {}),
            updatedAt: new Date(),
          })
          .where(eq(marketplaceListings.id, listingId));
      });
      const row = await loadListing(listingId);
      if (!row) throw new Error("The listing was not saved.");
      return detailOf(actor, row);
    },

    async withdraw(person, listingId) {
      const { listing } = await ownListing(person, listingId);
      if (listing.status === "removed") {
        throw new MarketplaceError(
          "forbidden",
          "Our staff took this listing down. It stays on record.",
        );
      }
      await database
        .delete(marketplaceListings)
        .where(eq(marketplaceListings.id, listingId));
    },

    async report(person, slug, input) {
      if (!REPORT_REASONS.some((reason) => reason.id === input.reason)) {
        throw new MarketplaceError("invalid", "Choose a reason from the list.");
      }
      const details = input.details.trim();
      if (details.length > LIMITS.reportDetails) {
        throw new MarketplaceError(
          "invalid",
          `Details can be at most ${LIMITS.reportDetails} characters.`,
        );
      }
      const listing = await loadListingWhere(
        eq(marketplaceListings.slug, slug),
      );
      if (listing?.status !== "published" || listing.kind !== "shared") {
        throw new MarketplaceError("not_found", "No such listing.");
      }
      const tenantId = await accounts.tenantIdForUser(person.id);
      if (tenantId && tenantId === listing.publisherTenantId) {
        throw new MarketplaceError(
          "forbidden",
          "This is your own listing. To take it down, withdraw it.",
        );
      }
      const [inserted] = await database
        .insert(marketplaceReports)
        .values({
          listingId: listing.id,
          reporterUserId: person.id,
          reason: input.reason,
          details,
          // From here and not the database, so the paging cursor, which carries milliseconds,
          // finds the same row again.
          createdAt: new Date(),
        })
        .onConflictDoNothing()
        .returning({ id: marketplaceReports.id });
      if (!inserted) {
        throw new MarketplaceError(
          "conflict",
          "You have already reported this listing. Our staff will look at it.",
        );
      }
    },

    async pending(staff, query = {}) {
      requireStaff(staff);
      const limit = pageSize(query.limit);
      const filters: SQL[] = [eq(marketplaceListings.status, "pending")];
      if (query.cursor) {
        const { at, id } = decodeCursor(query.cursor);
        filters.push(
          or(
            gt(marketplaceListings.updatedAt, at),
            and(
              eq(marketplaceListings.updatedAt, at),
              gt(marketplaceListings.id, id),
            ),
          ) as SQL,
        );
      }
      const rows = await database
        .select({
          id: marketplaceListings.id,
          updatedAt: marketplaceListings.updatedAt,
        })
        .from(marketplaceListings)
        .where(and(...filters))
        .orderBy(
          asc(marketplaceListings.updatedAt),
          asc(marketplaceListings.id),
        )
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const listings: ListingDetail[] = [];
      for (const { id } of page) {
        const row = await loadListing(id);
        if (row) listings.push(await detailOf(staff, row));
      }
      const last = page.at(-1);
      return {
        listings,
        nextCursor:
          rows.length > limit && last
            ? encodeCursor(last.updatedAt, last.id)
            : null,
      };
    },

    async approve(staff, listingId) {
      requireStaff(staff);
      const listing = await loadListing(listingId);
      if (listing?.kind !== "shared") {
        throw new MarketplaceError("not_found", "No such listing.");
      }
      if (listing.status !== "pending") {
        throw new MarketplaceError(
          "conflict",
          "Only a listing that is waiting for review can be approved.",
        );
      }
      // Checked again, because the checker improves and a person's confirmation covers only their own
      // reading. A secret is a secret whoever approves.
      const verdict = judge(
        scannedText(
          {
            title: listing.title,
            summary: listing.summary,
            category: listing.category,
            tags: listing.tags,
            description: listing.description,
          },
          listing.content as SharedContent,
        ),
        { confirmedNoPrivateData: true },
      );
      if (!verdict.ok) {
        throw new MarketplaceError(
          "unclean",
          "This now looks like it contains a secret. Reject it and say why.",
          verdict.secrets,
        );
      }
      const now = new Date();
      const updated = await database
        .update(marketplaceListings)
        .set({
          status: "published",
          reviewNote: null,
          publishedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(marketplaceListings.id, listingId),
            eq(marketplaceListings.status, "pending"),
          ),
        )
        .returning({ id: marketplaceListings.id });
      if (updated.length === 0) {
        throw new MarketplaceError("conflict", "That listing just changed.");
      }
    },

    async reject(staff, listingId, note) {
      requireStaff(staff);
      const reason = note.trim();
      if (reason.length === 0 || reason.length > LIMITS.reviewNote) {
        throw new MarketplaceError(
          "invalid",
          `Say why, in 1 to ${LIMITS.reviewNote} characters. The publisher is shown this.`,
        );
      }
      const updated = await database
        .update(marketplaceListings)
        .set({ status: "rejected", reviewNote: reason, updatedAt: new Date() })
        .where(
          and(
            eq(marketplaceListings.id, listingId),
            eq(marketplaceListings.kind, "shared"),
            eq(marketplaceListings.status, "pending"),
          ),
        )
        .returning({ id: marketplaceListings.id });
      if (updated.length === 0) {
        throw new MarketplaceError(
          "not_found",
          "No listing is waiting for review with that id.",
        );
      }
    },

    async remove(staff, listingId, note) {
      requireStaff(staff);
      const reason = note.trim();
      if (reason.length === 0 || reason.length > LIMITS.reviewNote) {
        throw new MarketplaceError(
          "invalid",
          `Say why, in 1 to ${LIMITS.reviewNote} characters. The publisher is shown this.`,
        );
      }
      await database.transaction(async (transaction) => {
        const updated = await transaction
          .update(marketplaceListings)
          .set({ status: "removed", reviewNote: reason, updatedAt: new Date() })
          .where(
            and(
              eq(marketplaceListings.id, listingId),
              eq(marketplaceListings.kind, "shared"),
              ne(marketplaceListings.status, "removed"),
            ),
          )
          .returning({ id: marketplaceListings.id });
        if (updated.length === 0) {
          throw new MarketplaceError("not_found", "No such listing.");
        }
        await transaction
          .update(marketplaceReports)
          .set({ status: "actioned" })
          .where(
            and(
              eq(marketplaceReports.listingId, listingId),
              eq(marketplaceReports.status, "open"),
            ),
          );
      });
    },

    async reports(staff, query = {}) {
      requireStaff(staff);
      const limit = pageSize(query.limit);
      const filters: SQL[] = [eq(marketplaceReports.status, "open")];
      if (query.cursor) {
        const { at, id } = decodeCursor(query.cursor);
        filters.push(
          or(
            gt(marketplaceReports.createdAt, at),
            and(
              eq(marketplaceReports.createdAt, at),
              gt(marketplaceReports.id, id),
            ),
          ) as SQL,
        );
      }
      const rows = await database
        .select({
          id: marketplaceReports.id,
          reason: marketplaceReports.reason,
          details: marketplaceReports.details,
          createdAt: marketplaceReports.createdAt,
          listingId: marketplaceListings.id,
          slug: marketplaceListings.slug,
          title: marketplaceListings.title,
          status: marketplaceListings.status,
          publisherName: marketplacePublishers.displayName,
        })
        .from(marketplaceReports)
        .innerJoin(
          marketplaceListings,
          eq(marketplaceListings.id, marketplaceReports.listingId),
        )
        .innerJoin(
          marketplacePublishers,
          eq(marketplacePublishers.id, marketplaceListings.publisherId),
        )
        .where(and(...filters))
        .orderBy(asc(marketplaceReports.createdAt), asc(marketplaceReports.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        reports: page.map((row) => ({
          id: row.id,
          reason: row.reason,
          details: row.details,
          createdAt: row.createdAt.toISOString(),
          listing: {
            id: row.listingId,
            slug: row.slug,
            title: row.title,
            status: row.status,
            publisherName: row.publisherName,
          },
        })),
        nextCursor:
          rows.length > limit && last
            ? encodeCursor(last.createdAt, last.id)
            : null,
      };
    },

    async dismissReport(staff, reportId) {
      requireStaff(staff);
      const updated = await database
        .update(marketplaceReports)
        .set({ status: "dismissed" })
        .where(
          and(
            eq(marketplaceReports.id, reportId),
            eq(marketplaceReports.status, "open"),
          ),
        )
        .returning({ id: marketplaceReports.id });
      if (updated.length === 0) {
        throw new MarketplaceError("not_found", "No open report with that id.");
      }
    },
  };
}
