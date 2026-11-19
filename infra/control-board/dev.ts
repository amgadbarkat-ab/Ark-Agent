/**
 * The board on this computer with made-up data, to look at it:  bun infra/control-board/dev.ts
 *
 * A throwaway SQLite file stands in for D1, and every source is a stand-in, refreshed every minute
 * as the Cron Trigger would: nothing leaves the computer. It makes a pending owner "demo" and prints
 * its setup link: open it, add the TOTP key to an authenticator app, and make a passkey (browsers
 * allow passkeys on http://localhost). Then sign in with the passkey and the app's code.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPendingAccount } from "./accounts";
import { createBoard } from "./board";
import { casesExtension, openCase } from "./cases";
import { refreshSources } from "./cron";
import { openLocalStore } from "./sql-sqlite";
import { standIns } from "./standins";

const port = Number(process.env.PORT ?? 8787);
const origin = `http://localhost:${port}`;
const dir = mkdtempSync(join(tmpdir(), "control-board-dev-"));
const sql = await openLocalStore(join(dir, "board.sqlite"));
const token = await createPendingAccount(
  sql,
  { username: "demo", role: "owner" },
  "dev",
  Date.now(),
);
await openCase(
  sql,
  {
    customerId: "demo-clinic",
    channel: "in-app",
    language: "el",
    priority: "urgent",
    plan: "trial",
    subject: "Η γραμμή δεν απαντά μετά τις 18:00",
    note: "Made-up case for the local board.",
  },
  "demo",
  Date.now() - 30 * 3_600_000,
);
const sources = standIns(Date.now);
sources.stripeConnected = true;
await refreshSources(sql, sources, Date.now);
setInterval(() => void refreshSources(sql, sources, Date.now), 60_000);

const board = createBoard({
  sql,
  publicOrigin: origin,
  firstFactor: "passkey",
  extensions: [casesExtension(sql)],
});
Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch: (request) => board.fetch(request, "127.0.0.1"),
});
console.log(`Control Board (made-up data): ${origin}/login`);
console.log(`Set up the owner "demo" first: ${origin}/setup/${token}`);
