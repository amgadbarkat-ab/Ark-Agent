/**
 * The board on this computer with made-up data, to look at it:  bun infra/control-board/dev.ts
 *
 * It makes a throwaway SQLite file, an owner "demo" with the password "demo-password-1" and a
 * printed TOTP key (add it to an authenticator app, or read the current code from the console),
 * and serves http://localhost:8787. Browsers keep `Secure` and `__Host-` cookies on localhost.
 * Nothing leaves the computer: every source is a stand-in.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateDirectly } from "./accounts";
import { createBoard } from "./board";
import { standIns } from "./standins";
import { openStore } from "./store";
import { newTotpSecret, totp } from "./totp";

const dir = mkdtempSync(join(tmpdir(), "control-board-dev-"));
const db = openStore(join(dir, "board.sqlite"));
const secret = newTotpSecret();
await activateDirectly(
  db,
  "demo",
  "owner",
  "demo-password-1",
  secret,
  -1,
  Date.now(),
);
const port = Number(process.env.PORT ?? 8787);
const board = createBoard({
  db,
  sources: standIns(Date.now),
  publicOrigin: `http://localhost:${port}`,
});
Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch: (request) => board.fetch(request, "127.0.0.1"),
});
console.log(`Control Board (made-up data): http://localhost:${port}/login`);
console.log(
  `User name: demo   Password: demo-password-1   TOTP key: ${secret}`,
);
setInterval(
  () => console.log(`Current code: ${totp(secret, Date.now())}`),
  30_000,
);
console.log(`Current code: ${totp(secret, Date.now())}`);
