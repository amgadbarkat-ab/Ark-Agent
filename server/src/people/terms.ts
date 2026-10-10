import { and, asc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { termsAcceptances } from "../db/schema";

/** Where one person stands against the terms currently in force. */
export type TermsStatus = {
  /** The version in force. */
  version: string;
  /**
   * Whether this person has to accept before using the app. False when the deployment does not ask
   * (nothing is final yet), and for staff, who work for the operator and are not its customers.
   */
  required: boolean;
  /** When they accepted this version, or null. */
  acceptedAt: string | null;
};

export type TermsStore = {
  status: (userId: string, isStaff: boolean) => Promise<TermsStatus>;
  /**
   * Records that this person accepted this version. Returns false, writing nothing, when it is not
   * the version in force: they were looking at a text that has since changed, and agreeing to it
   * would record agreement to something they were not shown.
   *
   * Idempotent: accepting again keeps the first time.
   */
  accept: (userId: string, version: string, at?: Date) => Promise<boolean>;
  /** Every acceptance by this person, oldest first, for the copy of their data they can download. */
  history: (
    userId: string,
  ) => Promise<{ version: string; acceptedAt: string }[]>;
};

export function createTermsStore(
  database: Database,
  options: { version: string; required: boolean },
): TermsStore {
  return {
    async status(userId, isStaff) {
      const [row] = await database
        .select({ acceptedAt: termsAcceptances.acceptedAt })
        .from(termsAcceptances)
        .where(
          and(
            eq(termsAcceptances.userId, userId),
            eq(termsAcceptances.version, options.version),
          ),
        )
        .limit(1);
      return {
        version: options.version,
        required: options.required && !isStaff,
        acceptedAt: row ? row.acceptedAt.toISOString() : null,
      };
    },

    async accept(userId, version, at = new Date()) {
      if (version !== options.version) return false;
      await database
        .insert(termsAcceptances)
        .values({ userId, version, acceptedAt: at })
        .onConflictDoNothing();
      return true;
    },

    async history(userId) {
      const rows = await database
        .select({
          version: termsAcceptances.version,
          acceptedAt: termsAcceptances.acceptedAt,
        })
        .from(termsAcceptances)
        .where(eq(termsAcceptances.userId, userId))
        .orderBy(asc(termsAcceptances.acceptedAt));
      return rows.map((row) => ({
        version: row.version,
        acceptedAt: row.acceptedAt.toISOString(),
      }));
    },
  };
}
