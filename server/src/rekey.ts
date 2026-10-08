import { and, asc, eq, gt, isNotNull } from "drizzle-orm";
import { isEnvelope } from "./auth/encrypt-sso-config";
import { decryptSecret, encryptSecret, needsResealing } from "./credentials";
import type { Database } from "./db/client";
import { credentials, modelConnections, ssoProviders } from "./db/schema";

/**
 * Re-seal everything the server keeps encrypted under the current key, so a retired key can be
 * removed (docs/ark/13-azure-hosting.md, "Rotating the data encryption key").
 *
 * WHAT HOLDS A SEALED VALUE. Four columns in three tables, and nowhere else: a stored credential
 * (`credentials.encrypted_value`, which also holds connected-app tokens and agent endpoint keys), a
 * person's model key (`model_connections.encrypted_key`), and a company's directory secrets
 * (`sso_providers.oidc_config` and `saml_config`). A value added somewhere new belongs in this list,
 * and the test that seals one of each fails until it is.
 *
 * SAFE TO RUN WHILE THE SERVICE RUNS, and to run twice. A row is rewritten only if it still holds
 * exactly the value that was read, so a person changing a key at the same moment is not overwritten
 * with the old one; that row is simply picked up by the next pass. A row already under the current
 * key is left alone.
 *
 * A VALUE NO KEY OPENS is not touched and not hidden: it is listed by table and id, and the run
 * fails. It cannot be recovered by this, and silently dropping it would turn a missing key into
 * missing data.
 */

export type RekeyTarget = {
  table: string;
  column: string;
};

export type RekeyReport = RekeyTarget & {
  /** Rows that hold a sealed value. */
  sealed: number;
  /** Re-sealed (or, in a dry run, that would be). */
  resealed: number;
  /** Already under the current key. */
  current: number;
  /** Rows changed by somebody else while this ran; the next pass takes them. */
  raced: number;
  /** Plaintext written before the value was sealed at all; sealed the next time it is written. */
  plaintext: number;
  /** Ids no key this deployment holds can open. */
  unreadable: string[];
};

type Row = { id: string; value: string };

export type SealedColumn = RekeyTarget & {
  page: (after: string | null, size: number) => Promise<Row[]>;
  /** Writes `next` only where the row still holds `previous`; true if it did. */
  replace: (id: string, previous: string, next: string) => Promise<boolean>;
};

/** Every column that holds a sealed value, with how to page through it and how to rewrite one safely. */
export function sealedColumns(database: Database): SealedColumn[] {
  const ssoColumn = (
    column: "oidc_config" | "saml_config",
    field: "oidcConfig" | "samlConfig",
  ): SealedColumn => ({
    table: "sso_providers",
    column,
    page: async (after, size) => {
      const rows = await database
        .select({ id: ssoProviders.id, value: ssoProviders[field] })
        .from(ssoProviders)
        .where(
          and(
            after === null ? undefined : gt(ssoProviders.id, after),
            isNotNull(ssoProviders[field]),
          ),
        )
        .orderBy(asc(ssoProviders.id))
        .limit(size);
      return rows.flatMap((row) =>
        row.value === null ? [] : [{ id: row.id, value: row.value }],
      );
    },
    replace: async (id, previous, next) => {
      const done = await database
        .update(ssoProviders)
        .set({ [field]: next })
        .where(and(eq(ssoProviders.id, id), eq(ssoProviders[field], previous)))
        .returning({ id: ssoProviders.id });
      return done.length > 0;
    },
  });

  return [
    {
      table: "credentials",
      column: "encrypted_value",
      page: async (after, size) =>
        database
          .select({ id: credentials.id, value: credentials.encryptedValue })
          .from(credentials)
          .where(after === null ? undefined : gt(credentials.id, after))
          .orderBy(asc(credentials.id))
          .limit(size),
      replace: async (id, previous, next) => {
        const done = await database
          .update(credentials)
          .set({ encryptedValue: next })
          .where(
            and(
              eq(credentials.id, id),
              eq(credentials.encryptedValue, previous),
            ),
          )
          .returning({ id: credentials.id });
        return done.length > 0;
      },
    },
    {
      table: "model_connections",
      column: "encrypted_key",
      page: async (after, size) => {
        const rows = await database
          .select({
            id: modelConnections.id,
            value: modelConnections.encryptedKey,
          })
          .from(modelConnections)
          .where(
            and(
              after === null ? undefined : gt(modelConnections.id, after),
              isNotNull(modelConnections.encryptedKey),
            ),
          )
          .orderBy(asc(modelConnections.id))
          .limit(size);
        return rows.flatMap((row) =>
          row.value === null ? [] : [{ id: row.id, value: row.value }],
        );
      },
      replace: async (id, previous, next) => {
        const done = await database
          .update(modelConnections)
          .set({ encryptedKey: next })
          .where(
            and(
              eq(modelConnections.id, id),
              eq(modelConnections.encryptedKey, previous),
            ),
          )
          .returning({ id: modelConnections.id });
        return done.length > 0;
      },
    },
    ssoColumn("oidc_config", "oidcConfig"),
    ssoColumn("saml_config", "samlConfig"),
  ];
}

const PAGE = 200;
/** A row raced by a live write is taken by another pass; this many is far more than will ever be needed. */
const PASSES = 5;

export async function resealAll(
  database: Database,
  options: {
    /** The current key: everything is left sealed under this one. */
    currentKey: string;
    /** Report what would change and change nothing. */
    dryRun: boolean;
  },
): Promise<RekeyReport[]> {
  const { currentKey, dryRun } = options;
  const reports: RekeyReport[] = [];

  for (const source of sealedColumns(database)) {
    const report: RekeyReport = {
      table: source.table,
      column: source.column,
      sealed: 0,
      resealed: 0,
      current: 0,
      raced: 0,
      plaintext: 0,
      unreadable: [],
    };

    for (let pass = 1; pass <= PASSES; pass++) {
      // Each pass counts afresh what it sees; the last pass is the report.
      report.sealed = 0;
      report.resealed = 0;
      report.current = 0;
      report.raced = 0;
      report.plaintext = 0;
      report.unreadable = [];

      let after: string | null = null;
      for (;;) {
        const rows = await source.page(after, PAGE);
        if (rows.length === 0) break;
        for (const row of rows) {
          after = row.id;
          if (!isEnvelope(row.value)) {
            report.plaintext += 1;
            continue;
          }
          report.sealed += 1;
          try {
            if (!(await needsResealing(currentKey, row.value))) {
              report.current += 1;
              continue;
            }
            const plaintext = await decryptSecret(currentKey, row.value);
            if (dryRun) {
              report.resealed += 1;
              continue;
            }
            const next = await encryptSecret(currentKey, plaintext);
            if (await source.replace(row.id, row.value, next)) {
              report.resealed += 1;
            } else {
              report.raced += 1;
            }
          } catch {
            report.unreadable.push(row.id);
          }
        }
      }

      // A dry run changes nothing, so another pass would see the same; and a pass nothing raced
      // is complete.
      if (dryRun || report.raced === 0) break;
    }
    reports.push(report);
  }
  return reports;
}
