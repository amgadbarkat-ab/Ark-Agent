/**
 * The marketplace's fixed vocabulary, shared by the server (which enforces it) and the app (which
 * shows it). Decision D7 in docs/ark/01-product-decisions.md.
 *
 * Two kinds of listing, and the difference is the whole point:
 * - "official": an Ark digital employee. Anyone can install it into their own account.
 * - "shared": somebody's own coworker, published as a guide. It is view-only: nothing can be
 *   installed, cloned, imported or exported from it, and it never runs on anyone's account.
 */

export type ListingKind = "official" | "shared";

export type ListingStatus = "pending" | "published" | "rejected" | "removed";

export const CATEGORIES = [
  { id: "productivity", name: "Productivity" },
  { id: "research", name: "Research" },
  { id: "writing", name: "Writing" },
  { id: "engineering", name: "Engineering" },
  { id: "finance", name: "Finance" },
  { id: "support", name: "Support" },
  { id: "operations", name: "Operations" },
  { id: "other", name: "Other" },
] as const;

export type CategoryId = (typeof CATEGORIES)[number]["id"];

export function isCategory(value: string): value is CategoryId {
  return CATEGORIES.some((category) => category.id === value);
}

export const LIMITS = {
  title: 80,
  summary: 200,
  description: 4000,
  tags: 8,
  tagLength: 24,
  displayName: 60,
  bio: 500,
  /** How many listings one account may have waiting for review at once. */
  pendingPerAccount: 10,
  /** How many listings one account may have in all, published or not. */
  listingsPerAccount: 50,
  /** The reason staff give when they reject or remove something. */
  reviewNote: 500,
  /** How many tool names a shared listing shows. */
  toolsShown: 50,
  reportDetails: 1000,
} as const;

export const REPORT_REASONS = [
  { id: "secrets", name: "Contains a secret or private data" },
  { id: "harmful", name: "Harmful or deceptive" },
  { id: "copied", name: "Copied from somebody else" },
  { id: "spam", name: "Spam" },
  { id: "other", name: "Something else" },
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number]["id"];

/** A web-safe name from a title: lower case, letters and digits, single dashes. */
export function slugify(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || "listing";
}
