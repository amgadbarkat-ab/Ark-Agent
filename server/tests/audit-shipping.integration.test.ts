import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  createAuditStore,
  recordAuditEvent,
  SHIPPED_PAYLOAD_LIMIT,
} from "../src/audit";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { auditEvents } from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

/**
 * The audit trail is a table, so whoever can write to the database can change it. A copy written to
 * the log as each event happens is how a change is noticed: compare the row with the line.
 *
 * What is pinned: the line is the row (same id, same time, same redacted payload), it is never more
 * than the row, a big payload is cut with a note, and a sink that fails loses nothing.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

const target = () => `shipping-${randomUUID()}`;

describe("copying the trail to the log", () => {
  test("each event is written as it is recorded, and the line matches the row", async () => {
    const lines: string[] = [];
    const store = createAuditStore(database, {
      ship: (line) => lines.push(line),
    });
    const targetId = target();

    await recordAuditEvent(store, {
      eventType: "configuration.changed",
      targetType: "test",
      targetId,
      actorUserId: undefined,
      payload: { change: "something", count: 3 },
    });

    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0] as string);
    const [row] = await database
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.targetId, targetId));
    expect(line).toMatchObject({
      type: "audit",
      id: row?.id,
      at: row?.createdAt.toISOString(),
      eventType: "configuration.changed",
      targetType: "test",
      targetId,
      actor: null,
      initiator: "person",
      payload: { change: "something", count: 3 },
    });
  });

  test("is the redacted payload and never more: a secret is not in the log either", async () => {
    const lines: string[] = [];
    const store = createAuditStore(database, {
      ship: (line) => lines.push(line),
    });

    await recordAuditEvent(store, {
      eventType: "configuration.changed",
      targetType: "test",
      targetId: target(),
      payload: {
        change: "x",
        apiKey: "sk-SECRET-VALUE",
        nested: { token: "t-SECRET" },
      },
    });

    expect(lines[0]).not.toContain("SECRET");
    expect(lines[0]).toContain("[REDACTED]");
  });

  test("a payload too big for a log line is cut, and says so; the row keeps all of it", async () => {
    const lines: string[] = [];
    const store = createAuditStore(database, {
      ship: (line) => lines.push(line),
    });
    const targetId = target();

    await recordAuditEvent(store, {
      eventType: "configuration.changed",
      targetType: "test",
      targetId,
      payload: { note: "x".repeat(SHIPPED_PAYLOAD_LIMIT * 2) },
    });

    const line = JSON.parse(lines[0] as string);
    expect(line.payloadTruncated).toBe(true);
    expect(String(line.payload).length).toBe(SHIPPED_PAYLOAD_LIMIT);
    const [row] = await database
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.targetId, targetId));
    const kept = row?.payload as { note: string } | undefined;
    expect(kept?.note.length).toBe(SHIPPED_PAYLOAD_LIMIT * 2);
  });

  test("a log that cannot be written to loses no event", async () => {
    const store = createAuditStore(database, {
      ship: () => {
        throw new Error("stdout closed");
      },
    });
    const targetId = target();

    await recordAuditEvent(store, {
      eventType: "configuration.changed",
      targetType: "test",
      targetId,
      payload: { change: "kept" },
    });

    const rows = await database
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.targetId, targetId));
    expect(rows).toHaveLength(1);
  });

  test("without a sink nothing is written anywhere but the table", async () => {
    const written: unknown[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => written.push(args);
    try {
      await recordAuditEvent(createAuditStore(database), {
        eventType: "configuration.changed",
        targetType: "test",
        targetId: target(),
        payload: { change: "quiet" },
      });
    } finally {
      console.log = original;
    }
    expect(written).toEqual([]);
  });
});

describe("the setting", () => {
  test("is off unless the deployment says log, and anything else stops it starting", () => {
    expect(loadConfig(testEnvironment()).auditShipping).toBe("off");
    expect(
      loadConfig(testEnvironment({ AUDIT_SHIPPING: " LOG " })).auditShipping,
    ).toBe("log");
    expect(() =>
      loadConfig(testEnvironment({ AUDIT_SHIPPING: "yes" })),
    ).toThrow(/AUDIT_SHIPPING/);
  });
});
