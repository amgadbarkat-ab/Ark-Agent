import { and, asc, eq, sql } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "../credentials";
import type { Database } from "../db/client";
import { modelConnections } from "../db/schema";

/**
 * What the app and the routes may see of a connection. There is no key in it, ever: whether one is
 * stored is the only thing said about it.
 */
export type ModelConnection = {
  id: string;
  providerId: string;
  label: string;
  baseUrl: string;
  model: string;
  isDefault: boolean;
  hasKey: boolean;
  createdAt: Date;
  updatedAt: Date;
};

/** A connection with its key opened, for the one place that spends it. Never sent to a browser. */
export type ModelConnectionSecret = ModelConnection & { apiKey: string | null };

export type NewModelConnection = {
  providerId: string;
  label: string;
  baseUrl: string;
  model: string;
  /** Null or absent for a provider that needs none. */
  apiKey?: string | null;
};

export type ModelConnectionPatch = {
  label?: string;
  baseUrl?: string;
  model?: string;
  /** A new key. Null removes the stored one; absent leaves it alone. */
  apiKey?: string | null;
};

export type ModelConnectionStore = {
  list: (userId: string) => Promise<ModelConnection[]>;
  get: (userId: string, id: string) => Promise<ModelConnection | null>;
  /** The first connection a person makes becomes their default. */
  create: (
    userId: string,
    input: NewModelConnection,
  ) => Promise<ModelConnection>;
  update: (
    userId: string,
    id: string,
    patch: ModelConnectionPatch,
  ) => Promise<ModelConnection | null>;
  /** Removing the default hands that role to the person's oldest remaining connection. */
  remove: (userId: string, id: string) => Promise<boolean>;
  setDefault: (userId: string, id: string) => Promise<ModelConnection | null>;
  /** The person's default connection, without opening its key. */
  getDefault: (userId: string) => Promise<ModelConnection | null>;
  /** The named connection, or the person's default, with its key opened. */
  open: (userId: string, id?: string) => Promise<ModelConnectionSecret | null>;
};

/** Enough for anyone's real use, and a ceiling on what a stolen session can pile up. */
export const MAX_CONNECTIONS_PER_USER = 20;

export class TooManyConnectionsError extends Error {
  constructor() {
    super(
      `A person can keep ${MAX_CONNECTIONS_PER_USER} model connections. Remove one to add another.`,
    );
    this.name = "TooManyConnectionsError";
  }
}

type Row = typeof modelConnections.$inferSelect;

function view(row: Row): ModelConnection {
  return {
    id: row.id,
    providerId: row.providerId,
    label: row.label,
    baseUrl: row.baseUrl,
    model: row.model,
    isDefault: row.isDefault,
    hasKey: row.encryptedKey !== null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const owned = (userId: string, id: string) =>
  and(eq(modelConnections.userId, userId), eq(modelConnections.id, id));

export function createModelConnectionStore(
  database: Database,
  encryptionKey: string,
): ModelConnectionStore {
  const seal = async (key: string | null | undefined) =>
    key?.trim() ? encryptSecret(encryptionKey, key.trim()) : null;

  return {
    async list(userId) {
      const rows = await database
        .select()
        .from(modelConnections)
        .where(eq(modelConnections.userId, userId))
        .orderBy(asc(modelConnections.createdAt), asc(modelConnections.id));
      return rows.map(view);
    },

    async get(userId, id) {
      const [row] = await database
        .select()
        .from(modelConnections)
        .where(owned(userId, id))
        .limit(1);
      return row ? view(row) : null;
    },

    async create(userId, input) {
      const encryptedKey = await seal(input.apiKey);
      return database.transaction(async (tx) => {
        // Serialise a person's own writes, so two tabs cannot both believe they hold the first
        // connection, or both slip past the limit.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`model-connections:${userId}`}))`,
        );
        const existing = await tx
          .select({ id: modelConnections.id })
          .from(modelConnections)
          .where(eq(modelConnections.userId, userId));
        if (existing.length >= MAX_CONNECTIONS_PER_USER) {
          throw new TooManyConnectionsError();
        }
        const [row] = await tx
          .insert(modelConnections)
          .values({
            userId,
            providerId: input.providerId,
            label: input.label,
            baseUrl: input.baseUrl,
            model: input.model,
            encryptedKey,
            isDefault: existing.length === 0,
          })
          .returning();
        if (!row) throw new Error("The connection could not be saved.");
        return view(row);
      });
    },

    async update(userId, id, patch) {
      const changes: Partial<typeof modelConnections.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (patch.label !== undefined) changes.label = patch.label;
      if (patch.baseUrl !== undefined) changes.baseUrl = patch.baseUrl;
      if (patch.model !== undefined) changes.model = patch.model;
      if (patch.apiKey !== undefined)
        changes.encryptedKey = await seal(patch.apiKey);
      const [row] = await database
        .update(modelConnections)
        .set(changes)
        .where(owned(userId, id))
        .returning();
      return row ? view(row) : null;
    },

    async remove(userId, id) {
      return database.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`model-connections:${userId}`}))`,
        );
        const [gone] = await tx
          .delete(modelConnections)
          .where(owned(userId, id))
          .returning({ wasDefault: modelConnections.isDefault });
        if (!gone) return false;
        if (gone.wasDefault) {
          const [next] = await tx
            .select({ id: modelConnections.id })
            .from(modelConnections)
            .where(eq(modelConnections.userId, userId))
            .orderBy(asc(modelConnections.createdAt), asc(modelConnections.id))
            .limit(1);
          if (next) {
            await tx
              .update(modelConnections)
              .set({ isDefault: true, updatedAt: new Date() })
              .where(eq(modelConnections.id, next.id));
          }
        }
        return true;
      });
    },

    async setDefault(userId, id) {
      return database.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`model-connections:${userId}`}))`,
        );
        const [target] = await tx
          .select({ id: modelConnections.id })
          .from(modelConnections)
          .where(owned(userId, id))
          .limit(1);
        if (!target) return null;
        // Clear first: the unique index allows one default, and checks as each row changes.
        await tx
          .update(modelConnections)
          .set({ isDefault: false })
          .where(
            and(
              eq(modelConnections.userId, userId),
              eq(modelConnections.isDefault, true),
            ),
          );
        const [row] = await tx
          .update(modelConnections)
          .set({ isDefault: true, updatedAt: new Date() })
          .where(owned(userId, id))
          .returning();
        return row ? view(row) : null;
      });
    },

    async getDefault(userId) {
      const [row] = await database
        .select()
        .from(modelConnections)
        .where(
          and(
            eq(modelConnections.userId, userId),
            eq(modelConnections.isDefault, true),
          ),
        )
        .limit(1);
      return row ? view(row) : null;
    },

    async open(userId, id) {
      const [row] = await database
        .select()
        .from(modelConnections)
        .where(
          id
            ? owned(userId, id)
            : and(
                eq(modelConnections.userId, userId),
                eq(modelConnections.isDefault, true),
              ),
        )
        .limit(1);
      if (!row) return null;
      const apiKey = row.encryptedKey
        ? await decryptSecret(encryptionKey, row.encryptedKey)
        : null;
      return { ...view(row), apiKey };
    },
  };
}
