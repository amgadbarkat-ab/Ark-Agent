/**
 * The counts a check-in carries from v0.1.49 (#149; Amgad, 18 Nov 2026: counts only, through the
 * normal release approval, with the privacy notice updated to say so).
 *
 * NUMBERS ONLY. How many people have an account on this install, how many of them used it in the
 * last 7 days, how many conversations were started in the last 7 days, whether a phone line is set
 * up, and which kind of system it runs on. Never a name, an email, a conversation's name or words,
 * or anything a person wrote. Each is one COUNT or EXISTS query; nothing is read row by row.
 */
import { platform } from "node:os";
import { sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { channels, phoneLine, sessions, users } from "../db/schema";

export type CheckInCounts = {
  people: number;
  activePeople7d: number;
  conversations7d: number;
  phoneLine: boolean;
  os?: "windows" | "macos" | "linux";
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function systemKind(
  name: string = platform(),
): CheckInCounts["os"] | undefined {
  if (name === "win32") return "windows";
  if (name === "darwin") return "macos";
  if (name === "linux") return "linux";
  return undefined;
}

export async function installCounts(
  database: Database,
  now: () => Date = () => new Date(),
): Promise<CheckInCounts> {
  // As text: a Date inside raw SQL is not sent as a timestamp.
  const since = new Date(now().getTime() - WEEK_MS).toISOString();
  const [people] = await database
    .select({ n: sql<number>`count(*)::int` })
    .from(users);
  // Used it in the last week: signed in, or a session that was still being used.
  const [active] = await database
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(
      sql`${users.lastSignedInAt} >= ${since} OR EXISTS (SELECT 1 FROM ${sessions} WHERE ${sessions.userId} = ${users.id} AND ${sessions.updatedAt} >= ${since})`,
    );
  const [started] = await database
    .select({ n: sql<number>`count(*)::int` })
    .from(channels)
    .where(sql`${channels.createdAt} >= ${since}`);
  const [line] = await database
    .select({ n: sql<number>`count(*)::int` })
    .from(phoneLine);
  const os = systemKind();
  return {
    people: people?.n ?? 0,
    activePeople7d: Math.min(active?.n ?? 0, people?.n ?? 0),
    conversations7d: started?.n ?? 0,
    phoneLine: (line?.n ?? 0) > 0,
    ...(os ? { os } : {}),
  };
}
