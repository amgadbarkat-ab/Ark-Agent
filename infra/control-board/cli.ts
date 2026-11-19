/**
 * The board's command line, run on the COO's computer. The board's data is in D1, which this
 * script cannot reach (no keys, no wrangler dependency): it prints SQL to stdout, for
 * `npx wrangler d1 execute`, and anything to show the person (a setup link) to stderr, so the
 * link never lands in a file or in the SQL:
 *
 *   bun cli.ts schema > schema.sql                the tables, once:  … d1 execute board --remote --file schema.sql
 *   bun cli.ts owner <user> [access-email]        the first owner (refused in SQL if an active owner exists)
 *   bun cli.ts reset <user>                       a new setup link for someone who lost their phone or passkey
 *   bun cli.ts unlock <user>                      clears that account's sign-in failures
 *
 * Used as:  npx wrangler d1 execute board --remote --command "$(bun cli.ts owner maria)"
 *
 * A setup link carries only the SHA-256 of its token in D1; the token itself is printed once. The
 * TOTP key for the link is made here and travels in the SQL, as the board would store it. The
 * audit log gets its entry when the link is used (`account.setup`): its hash chain is computed in
 * the board, not in SQL.
 */
import {
  newToken,
  SETUP_LINK_MS,
  sha256,
  validEmail,
  validUsername,
} from "./accounts";
import { schemaFile } from "./store";
import { newTotpSecret } from "./totp";

export type Io = { out(text: string): void; err(line: string): void };

/** An SQL literal; only for values this script made or checked (names, hex, base32, numbers). */
function lit(value: string | number | null): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(Math.trunc(value));
  return `'${value.replace(/'/g, "''")}'`;
}

function setupLinkSql(
  username: string,
  now: number,
): { sql: string[]; token: string } {
  const token = newToken();
  const id = `(SELECT id FROM accounts WHERE username = ${lit(username)})`;
  return {
    token,
    sql: [
      `DELETE FROM setup_links WHERE account_id = ${id};`,
      `INSERT INTO setup_links (token_hash, account_id, totp_secret, expires_at) SELECT ${lit(sha256(token))}, id, ${lit(
        newTotpSecret(),
      )}, ${lit(now + SETUP_LINK_MS)} FROM accounts WHERE username = ${lit(username)} AND status = 'pending';`,
    ],
  };
}

export function runCli(
  args: string[],
  io: Io,
  options: { now?: () => number; publicOrigin?: string } = {},
): number {
  const now = (options.now ?? Date.now)();
  const origin = options.publicOrigin ?? "https://<board>";
  const [command, rawName, rawEmail] = args;
  const name = (rawName ?? "").trim().toLowerCase();
  const email = rawEmail ? rawEmail.trim().toLowerCase() : null;

  if (command === "schema") {
    io.out(schemaFile());
    return 0;
  }

  if (
    (command === "owner" || command === "reset" || command === "unlock") &&
    !validUsername(name)
  ) {
    io.err(
      "That user name is not valid (2 to 32 of: lower-case letters, digits, . _ -).",
    );
    return 1;
  }

  if (command === "owner") {
    if (email !== null && !validEmail(email)) {
      io.err("That email address is not valid.");
      return 1;
    }
    const link = setupLinkSql(name, now);
    io.out(
      [
        `INSERT INTO accounts (username, role, status, access_email, created_at, created_by) SELECT ${lit(name)}, 'owner', 'pending', ${lit(
          email,
        )}, ${lit(new Date(now).toISOString())}, 'cli' WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE role = 'owner' AND status = 'active');`,
        ...link.sql,
        "",
      ].join("\n"),
    );
    io.err(
      `Setup link for ${name}, valid 24 hours, shown once (it does nothing if an owner exists already):`,
    );
    io.err(`  ${origin}/setup/${link.token}`);
    return 0;
  }

  if (command === "reset") {
    const id = `(SELECT id FROM accounts WHERE username = ${lit(name)})`;
    const link = setupLinkSql(name, now);
    io.out(
      [
        `UPDATE accounts SET status = 'pending', totp_secret = NULL, totp_last_step = -1 WHERE username = ${lit(name)} AND status != 'disabled';`,
        `DELETE FROM passkeys WHERE account_id = ${id};`,
        `DELETE FROM sessions WHERE account_id = ${id};`,
        ...link.sql,
        "",
      ].join("\n"),
    );
    io.err(
      `Setup link for ${name}, valid 24 hours, shown once (it does nothing if there is no such account):`,
    );
    io.err(`  ${origin}/setup/${link.token}`);
    return 0;
  }

  if (command === "unlock") {
    io.out(
      `DELETE FROM login_failures WHERE key = 'account:' || (SELECT id FROM accounts WHERE username = ${lit(name)});\n`,
    );
    io.err(`${name} can try to sign in again once this runs.`);
    return 0;
  }

  io.err(
    "Commands: schema | owner <user> [access-email] | reset <user> | unlock <user>",
  );
  return 1;
}

if (import.meta.main) {
  const code = runCli(
    process.argv.slice(2),
    {
      out: (text) => process.stdout.write(text),
      err: (line) => console.error(line),
    },
    { publicOrigin: process.env.BOARD_PUBLIC_ORIGIN },
  );
  process.exit(code);
}
