import { and, desc, eq, isNull } from "drizzle-orm";
import { type AuditStore, recordAuditEvent } from "./audit";
import type { Database } from "./db/client";
import { reasonWithoutStatement } from "./db/query-failure";
import { type credentialKind, credentials } from "./db/schema";

/**
 * What an encrypted value looks like in the database.
 *
 * Version 1 carries no hint of which key sealed it, so a reader with more than one key has to try
 * them. Version 2 names the key (`kid`, a short fingerprint of it, which reveals nothing about it), so
 * reading is a lookup, and so a person can tell from a row which key it still depends on. New values
 * are always version 2; version 1 is read for as long as any exist.
 */
type CredentialEnvelope =
  | { version: 1; iv: string; ciphertext: string }
  | { version: 2; kid: string; iv: string; ciphertext: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Derived from the enum rather than written out again.
 *
 * These were two lists that had to agree, and nothing made them. A kind added to the schema and not
 * here fails at the point of use with a type error about an unrelated call site; a kind removed from
 * the schema and left here compiles and then violates a check constraint at runtime. One source now.
 */
export type CredentialKind = (typeof credentialKind.enumValues)[number];

export type CredentialStatus = {
  id: string;
  kind: CredentialKind;
  provider: string;
  keyId: string;
  metadata: Record<string, unknown>;
  revokedAt: Date | null;
};

type StoredCredential = {
  id: string;
  revokedAt: Date | null;
};

export type CredentialStoreValue = {
  kind: CredentialKind;
  provider: string;
  keyId: string;
  metadata: Record<string, unknown>;
  encryptedValue: string;
};

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Where a credential write runs.
 *
 * A caller already inside a transaction passes it here, so the write joins that
 * transaction rather than opening one of its own on a second pooled connection.
 * Two connections would mean the credential committing separately from the
 * change that asked for it, and, since the caller is usually holding row locks
 * by then, a pool with nothing spare to hand out deadlocks instead. See the
 * note on `max` in `db/client.ts`.
 */
export type CredentialExecutor =
  | Pick<Database, "select" | "insert" | "update">
  | Pick<Transaction, "select" | "insert" | "update">;

export type CredentialStore = {
  create: (
    value: CredentialStoreValue,
    executor?: CredentialExecutor,
  ) => Promise<StoredCredential>;
  /**
   * Re-encrypt a live row in place, keeping the id everything already points at.
   *
   * A vendor whose refresh token ROTATES is the one caller. It has already killed the old token at
   * its end by the time it answers, so there is no second grant left to withdraw and nothing to
   * learn from a new row — only a row per tool call, forever. A person RECONNECTING still goes
   * through `rotate`, because that is the act that leaves a live grant behind for us to withdraw at
   * our side too.
   *
   * A revoked or missing row is refused rather than written through: a grant somebody withdrew must
   * not come back to life by being handed a fresh secret.
   *
   * Without an executor this writes on its own connection. With one it joins the caller's
   * transaction, which is how the caller that has locked this row spends the token under that lock:
   * the write has to commit with the lock rather than beside it.
   */
  updateSecret: (
    id: string,
    encryptedValue: string,
    executor?: CredentialExecutor,
  ) => Promise<void>;
  /**
   * Replace one credential with another, atomically.
   *
   * Retiring the old secret and storing the new one are one decision, so they
   * are one write. Two separate calls cannot be made safe from the outside:
   * an `UPDATE` can commit and still throw on the way back, and no compensating
   * revoke survives the process being killed between them.
   *
   * Without an executor this opens its own transaction. With one it runs inside
   * the caller's, and is atomic with whatever else that transaction is doing.
   */
  rotate: (
    input: CredentialStoreValue & { previousCredentialId: string },
    executor?: CredentialExecutor,
  ) => Promise<StoredCredential>;
  revoke: (id: string, executor?: CredentialExecutor) => Promise<Date>;
  /** Whether this credential exists and has not been revoked. */
  isLive: (id: string, executor?: CredentialExecutor) => Promise<boolean>;
  /**
   * The live credential for a key, if this deployment holds one.
   *
   * At most one can exist, which is what `credentials_active_key_idx`
   * enforces, so a caller about to store a secret for a key can ask whether it
   * is replacing something rather than finding out from a failed insert.
   */
  findLiveByKey: (
    key: { kind: CredentialKind; provider: string; keyId: string },
    executor?: CredentialExecutor,
  ) => Promise<{ id: string } | null>;
};

export type CredentialSecretReader = {
  readSecret: (id: string) => Promise<{
    encryptedValue: string;
    revokedAt: Date | null;
  } | null>;
};

export type CredentialStatusReader = {
  list: () => Promise<CredentialStatus[]>;
};

export type ModelCredentialSecretReader = {
  readModelSecret: (input: {
    provider: "openai" | "anthropic";
    keyId: string;
  }) => Promise<{ encryptedValue: string } | null>;
};

type CredentialService = {
  encryptionKey: string;
  store: CredentialStore;
  auditStore: AuditStore;
};

async function aesKey(encodedKey: string) {
  return crypto.subtle.importKey(
    "raw",
    Buffer.from(encodedKey, "base64"),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

function parseEnvelope(value: string): CredentialEnvelope {
  try {
    const envelope = JSON.parse(value) as CredentialEnvelope;
    if (
      (envelope.version !== 1 && envelope.version !== 2) ||
      typeof envelope.iv !== "string" ||
      typeof envelope.ciphertext !== "string" ||
      (envelope.version === 2 && typeof envelope.kid !== "string")
    ) {
      throw new Error("invalid envelope");
    }
    return envelope;
  } catch {
    throw new Error("Credential envelope is invalid");
  }
}

/*
 * KEY ROTATION.
 *
 * One key seals everything the server stores for somebody (credentials, model keys, directory
 * secrets), so a key that leaks, or a policy that says keys are replaced every so often, needs a way
 * to change it without losing any of it. The current key (`KEY_ENCRYPTION_KEY`) seals every new
 * value. The retired keys (`KEY_ENCRYPTION_KEY_PREVIOUS`) are only ever used to READ what they sealed,
 * until `server/scripts/rotate-encryption-key.ts` has re-sealed it all under the current one and they
 * are removed. The steps are in docs/ark/13-azure-hosting.md.
 *
 * Held here, once, rather than threaded through the twenty places that pass the current key around:
 * those all end in `encryptSecret` or `decryptSecret`, which is where a key is chosen.
 */
const retiredKeys: string[] = [];
const fingerprints = new Map<string, string>();

/** Keys that may still be read with, and are never written with. Replaces whatever was set before. */
export function useRetiredEncryptionKeys(keys: readonly string[]) {
  retiredKeys.length = 0;
  retiredKeys.push(...keys);
}

/** A short, public name for a key, so a value can say which one sealed it without giving it away. */
export async function encryptionKeyId(encodedKey: string): Promise<string> {
  const known = fingerprints.get(encodedKey);
  if (known) return known;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    Buffer.from(encodedKey, "base64"),
  );
  const id = Buffer.from(digest).subarray(0, 8).toString("hex");
  fingerprints.set(encodedKey, id);
  return id;
}

async function open(encodedKey: string, envelope: CredentialEnvelope) {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: Buffer.from(envelope.iv, "base64") },
    await aesKey(encodedKey),
    Buffer.from(envelope.ciphertext, "base64"),
  );
  return decoder.decode(plaintext);
}

export async function encryptSecret(encodedKey: string, plaintext: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await aesKey(encodedKey),
    encoder.encode(plaintext),
  );

  return JSON.stringify({
    version: 2,
    kid: await encryptionKeyId(encodedKey),
    iv: Buffer.from(iv).toString("base64"),
    ciphertext: Buffer.from(ciphertext).toString("base64"),
  } satisfies CredentialEnvelope);
}

export async function decryptSecret(encodedKey: string, value: string) {
  const envelope = parseEnvelope(value);
  const candidates = [encodedKey, ...retiredKeys];

  if (envelope.version === 2) {
    for (const candidate of candidates) {
      if ((await encryptionKeyId(candidate)) === envelope.kid) {
        return open(candidate, envelope);
      }
    }
    throw new Error(
      `This value was sealed with a key this deployment no longer holds (${envelope.kid}).`,
    );
  }

  // Version 1 does not say which key sealed it. AES-GCM authenticates, so a wrong key fails rather
  // than returning something that looks like a value.
  let failure: unknown;
  for (const candidate of candidates) {
    try {
      return await open(candidate, envelope);
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

/** Whether a stored value is sealed under anything but the current key, and so still needs re-sealing. */
export async function needsResealing(
  encodedKey: string,
  value: string,
): Promise<boolean> {
  const envelope = parseEnvelope(value);
  return (
    envelope.version === 1 ||
    envelope.kid !== (await encryptionKeyId(encodedKey))
  );
}

/**
 * The vault answered, and what it holds cannot be spent: the row is gone, or it is revoked.
 *
 * CRITERION. This is the ONLY thing {@link decryptCredentialForUse} raises that means "access was
 * withdrawn". Everything else it can raise — a query this database refused, a connection it could
 * not open, an envelope that would not decrypt — is a fault, and a caller must be able to tell the
 * two apart without reading either message.
 *
 * REASON. The two used to be plain `Error`s and the only thing separating them from a fault was
 * their wording, which `plugins/store.ts` matched on: a message containing "revoked" or "not found"
 * was a withdrawal, anything else was an error. drizzle reports a failed query as a message that
 * BEGINS `Failed query: select "encrypted_value", "revoked_at" from "credentials" …`, so the column
 * this function reads put the substring into every database fault on this very read — Postgres
 * down, a wrong address, a cancelled statement — and each was announced to the person, the model and
 * the operator as an administrator having taken the credential away. A class cannot be produced by
 * accident that way, and it survives a reworded sentence, which is the same argument
 * `TokenRefusedError` carries a `code` for rather than a phrase in its prose.
 *
 * ONE CLASS FOR BOTH STATES, because no caller acts on the difference: the row being absent and the
 * row being retired are both "this credential is not available and will not become available", and
 * the step is the same. The messages stay distinct for whoever is reading a log.
 */
export class CredentialUnusableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialUnusableError";
  }
}

export async function decryptCredentialForUse(
  encodedKey: string,
  reader: CredentialSecretReader,
  credentialId: string,
) {
  const credential = await reader.readSecret(credentialId);
  if (!credential) {
    throw new CredentialUnusableError("Credential was not found");
  }
  if (credential.revokedAt) {
    throw new CredentialUnusableError("Credential is revoked");
  }

  return decryptSecret(encodedKey, credential.encryptedValue);
}

export async function resolveModelApiKey(input: {
  encryptionKey: string;
  reader: ModelCredentialSecretReader;
  provider: "openai" | "anthropic";
  keyId: string;
  environment: Record<string, string | undefined>;
}) {
  const stored = await input.reader.readModelSecret({
    provider: input.provider,
    keyId: input.keyId,
  });
  if (stored) {
    return decryptSecret(input.encryptionKey, stored.encryptedValue);
  }

  const environmentKey =
    input.environment[
      input.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"
    ]?.trim();
  return environmentKey || null;
}

export function createCredentialStore(
  database: Database,
): CredentialStore &
  CredentialSecretReader &
  CredentialStatusReader &
  ModelCredentialSecretReader {
  return {
    create: async (value, executor = database) => {
      const [credential] = await executor
        .insert(credentials)
        .values(value)
        .returning({ id: credentials.id, revokedAt: credentials.revokedAt });

      if (!credential) {
        throw new Error("Credential could not be stored");
      }
      return credential;
    },
    updateSecret: async (id, encryptedValue, executor = database) => {
      const [credential] = await executor
        .update(credentials)
        .set({ encryptedValue, updatedAt: new Date() })
        .where(and(eq(credentials.id, id), isNull(credentials.revokedAt)))
        .returning({ id: credentials.id });

      /*
       * One statement, so nothing can revoke the row between a check and the write.
       *
       * The cost is that "no such row" and "revoked" arrive as the same answer, hence the one
       * message naming both. The caller acts identically on either: it refuses its call.
       */
      if (!credential) {
        throw new Error("Credential was not found or is revoked");
      }
    },
    rotate: async (input, executor) => {
      const write = async (transaction: CredentialExecutor) => {
        /**
         * The previous credential, locked for the rest of the transaction.
         *
         * Two replicas rotating the same secret would otherwise both read it
         * as live and both act; the second waits here and then finds it
         * revoked. Its identity is read alongside its state so a rotation
         * aimed at the wrong id is refused rather than silently retiring a
         * secret the caller never named.
         */
        const [previous] = await transaction
          .select({
            revokedAt: credentials.revokedAt,
            kind: credentials.kind,
            provider: credentials.provider,
            keyId: credentials.keyId,
          })
          .from(credentials)
          .where(eq(credentials.id, input.previousCredentialId))
          .for("update");
        if (!previous) {
          throw new Error("Previous credential was not found");
        }
        if (previous.revokedAt) {
          throw new Error("Previous credential is already revoked");
        }
        if (
          previous.kind !== input.kind ||
          previous.provider !== input.provider ||
          previous.keyId !== input.keyId
        ) {
          throw new Error(
            "Previous credential does not match the input's kind, provider or keyId",
          );
        }

        // Revoke, then insert. Both orders are invisible from outside the
        // transaction, and this one never holds two live rows for one key even
        // in the middle of it, which is the invariant a uniqueness constraint
        // on live credentials would later depend on.
        const revokedAt = new Date();
        const [revoked] = await transaction
          .update(credentials)
          .set({ revokedAt, updatedAt: revokedAt })
          .where(
            and(
              eq(credentials.id, input.previousCredentialId),
              isNull(credentials.revokedAt),
            ),
          )
          .returning({ revokedAt: credentials.revokedAt });
        if (!revoked?.revokedAt) {
          // Ruled out by the lock above under contention; reaching here means
          // the row was deleted outright between the two statements, which
          // aborts the transaction and leaves nothing committed.
          throw new Error("Previous credential was not found");
        }

        const [inserted] = await transaction
          .insert(credentials)
          .values({
            kind: input.kind,
            provider: input.provider,
            keyId: input.keyId,
            metadata: input.metadata,
            encryptedValue: input.encryptedValue,
          })
          .returning({
            id: credentials.id,
            revokedAt: credentials.revokedAt,
          });
        if (!inserted) {
          throw new Error("Credential could not be stored");
        }

        return inserted;
      };

      // A caller already in a transaction has its own atomicity to keep, and
      // the credential belongs to it rather than to a transaction of its own.
      return executor ? write(executor) : database.transaction(write);
    },
    revoke: async (id, executor = database) => {
      const revokedAt = new Date();
      const [credential] = await executor
        .update(credentials)
        .set({ revokedAt, updatedAt: revokedAt })
        // Only a live row is stamped. Without the guard a second revoke would
        // overwrite the first one's timestamp and report success, so a caller
        // could not tell retiring a credential from finding it already gone.
        .where(and(eq(credentials.id, id), isNull(credentials.revokedAt)))
        .returning({ revokedAt: credentials.revokedAt });

      if (!credential?.revokedAt) {
        throw new Error("Credential was not found or already revoked");
      }
      return credential.revokedAt;
    },
    isLive: async (id, executor = database) => {
      const [credential] = await executor
        .select({ id: credentials.id })
        .from(credentials)
        .where(and(eq(credentials.id, id), isNull(credentials.revokedAt)));

      return credential !== undefined;
    },
    findLiveByKey: async ({ kind, provider, keyId }, executor = database) => {
      const [credential] = await executor
        .select({ id: credentials.id })
        .from(credentials)
        .where(
          and(
            eq(credentials.kind, kind),
            eq(credentials.provider, provider),
            eq(credentials.keyId, keyId),
            isNull(credentials.revokedAt),
          ),
        );

      return credential ?? null;
    },
    readSecret: async (id) => {
      const [credential] = await database
        .select({
          encryptedValue: credentials.encryptedValue,
          revokedAt: credentials.revokedAt,
        })
        .from(credentials)
        .where(eq(credentials.id, id));

      return credential ?? null;
    },
    readModelSecret: async ({ provider, keyId }) => {
      const [credential] = await database
        .select({ encryptedValue: credentials.encryptedValue })
        .from(credentials)
        .where(
          and(
            eq(credentials.kind, "model"),
            eq(credentials.provider, provider),
            eq(credentials.keyId, keyId),
            isNull(credentials.revokedAt),
          ),
        )
        .orderBy(
          desc(credentials.createdAt),
          // UUID descending selects the lexicographically greatest ID on a timestamp tie.
          desc(credentials.id),
        )
        .limit(1);

      return credential ?? null;
    },
    list: async () => {
      const records = await database
        .select({
          id: credentials.id,
          kind: credentials.kind,
          provider: credentials.provider,
          keyId: credentials.keyId,
          metadata: credentials.metadata,
          revokedAt: credentials.revokedAt,
        })
        .from(credentials)
        .orderBy(credentials.createdAt);

      return records.map((credential) => ({
        ...credential,
        metadata: credential.metadata as Record<string, unknown>,
      }));
    },
  };
}

export type CredentialInput = {
  kind: CredentialKind;
  provider: string;
  keyId: string;
  metadata: Record<string, unknown>;
  plaintext: string;
  actorUserId?: string;
};

export type CredentialAdminService = CredentialStatusReader & {
  create: (input: CredentialInput) => Promise<CredentialStatus>;
  rotate: (
    input: CredentialInput & { previousCredentialId: string },
  ) => Promise<CredentialStatus>;
  revoke: (
    credentialId: string,
    actorUserId?: string,
  ) => Promise<{
    id: string;
    revokedAt: Date;
  }>;
};

async function persistCredential(
  service: CredentialService,
  input: CredentialInput,
): Promise<CredentialStatus> {
  const stored = await service.store.create({
    kind: input.kind,
    provider: input.provider,
    keyId: input.keyId,
    metadata: input.metadata,
    encryptedValue: await encryptSecret(service.encryptionKey, input.plaintext),
  });

  return {
    id: stored.id,
    kind: input.kind,
    provider: input.provider,
    keyId: input.keyId,
    metadata: input.metadata,
    revokedAt: stored.revokedAt,
  };
}

/**
 * Store a credential for a key.
 *
 * A key holds one live credential, so storing a second one for a key that
 * already has one is a replacement rather than an addition, and it is carried
 * out as a rotation: the two writes are atomic and the trail records
 * `credential.rotated` naming what was replaced.
 *
 * This is the shape the product asks for. The Credentials page offers Add and
 * Revoke and has no rotate control, so replacing a model key is done by adding
 * one for the same provider and keyId. Refusing that would leave no way to
 * replace a key at all, and inserting it would raise a bare unique violation
 * from `credentials_active_key_idx`.
 */
export async function createCredential(
  service: CredentialService,
  input: CredentialInput,
): Promise<CredentialStatus> {
  const existing = await service.store.findLiveByKey({
    kind: input.kind,
    provider: input.provider,
    keyId: input.keyId,
  });
  if (existing) {
    return rotateCredential(service, {
      ...input,
      previousCredentialId: existing.id,
    });
  }

  const credential = await persistCredential(service, input);

  await recordAuditEvent(service.auditStore, {
    eventType: "credential.created",
    targetType: "credential",
    targetId: credential.id,
    actorUserId: input.actorUserId,
    payload: {
      kind: input.kind,
      provider: input.provider,
      keyId: input.keyId,
    },
  });

  return credential;
}

export async function rotateCredential(
  service: CredentialService,
  input: CredentialInput & { previousCredentialId: string },
): Promise<CredentialStatus> {
  // Encryption happens before the transaction opens, so no database connection
  // is held while it runs. The store then performs both writes atomically, and
  // a failure leaves the vault as it was, which is why the success event below
  // is written only once that has returned.
  let stored: StoredCredential;
  try {
    stored = await service.store.rotate({
      previousCredentialId: input.previousCredentialId,
      kind: input.kind,
      provider: input.provider,
      keyId: input.keyId,
      metadata: input.metadata,
      encryptedValue: await encryptSecret(
        service.encryptionKey,
        input.plaintext,
      ),
    });
  } catch (error) {
    /*
     * A refused rotation is worth a row of its own.
     *
     * The vault refuses one aimed at a credential that is already revoked, one aimed at a credential
     * that does not exist, and one whose key does not match the credential it names. Each of those is
     * either a caller with a bug or an attempt to retire a key the caller was not asked to retire,
     * and each of them left nothing behind while only successes were recorded.
     *
     * Written outside the transaction that has just rolled back, so the row survives the failure it
     * describes.
     *
     * THE REASON IS ASKED FOR THROUGH {@link reasonWithoutStatement}, and the sentence this comment
     * used to carry — "the vault's own message and never the secret, which never left this
     * function" — was false. Not every throw caught here is the vault's own: the rotation runs
     * three statements, and a `DrizzleQueryError` from any of them has `Failed query: <the
     * statement>` and `params: <every bound value>` for a message. The insert binds
     * `encryptedValue`, so the values in that message include the credential envelope this function
     * had just built — and `audit_events` is append-only by trigger, exported, and kept for the
     * deployment's whole retention window, so a secret landing there is not one anybody can take
     * back out. A refusal the vault itself wrote still arrives here word for word; only the shape
     * that carries a statement is answered with the driver's complaint instead.
     */
    await recordAuditEvent(service.auditStore, {
      eventType: "credential.rotation_refused",
      targetType: "credential",
      targetId: input.previousCredentialId,
      actorUserId: input.actorUserId,
      payload: {
        kind: input.kind,
        provider: input.provider,
        keyId: input.keyId,
        reason: reasonWithoutStatement(error),
      },
    });
    throw error;
  }

  await recordAuditEvent(service.auditStore, {
    eventType: "credential.rotated",
    targetType: "credential",
    targetId: stored.id,
    actorUserId: input.actorUserId,
    payload: {
      previousCredentialId: input.previousCredentialId,
      kind: input.kind,
      provider: input.provider,
      keyId: input.keyId,
    },
  });

  return {
    id: stored.id,
    kind: input.kind,
    provider: input.provider,
    keyId: input.keyId,
    metadata: input.metadata,
    revokedAt: stored.revokedAt,
  };
}

export async function revokeCredential(
  service: CredentialService,
  credentialId: string,
  actorUserId?: string,
) {
  const revokedAt = await service.store.revoke(credentialId);

  await recordAuditEvent(service.auditStore, {
    eventType: "credential.revoked",
    targetType: "credential",
    targetId: credentialId,
    actorUserId,
    payload: {},
  });

  return { id: credentialId, revokedAt };
}

export function createCredentialAdminService(
  encryptionKey: string,
  store: CredentialStore & CredentialStatusReader,
  auditStore: AuditStore,
): CredentialAdminService {
  const service = { encryptionKey, store, auditStore };

  return {
    list: store.list,
    create: (input) => createCredential(service, input),
    rotate: (input) => rotateCredential(service, input),
    revoke: (credentialId, actorUserId) =>
      revokeCredential(service, credentialId, actorUserId),
  };
}
