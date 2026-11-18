/**
 * The board's command line, run on the server (`./deploy.sh owner`, or `bun cli.ts …` in the
 * container). Everything it changes goes into the audit log as the actor "cli".
 *
 *   bun cli.ts create-owner        the first owner: user name, password at a hidden prompt, 2FA
 *   bun cli.ts reset <user>        a new setup link for someone who lost their phone or password
 *   bun cli.ts unlock <user>       clears the 15-minute sign-in lock for that name
 *   bun cli.ts list                the accounts, their roles and states
 *   bun cli.ts verify-audit        checks that no audit entry was changed or removed
 */
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  activateDirectly,
  activeOwners,
  argon2id,
  findAccount,
  listAccounts,
  MIN_PASSWORD,
  type PasswordHasher,
  resetAccount,
  validUsername,
} from "./accounts";
import { appendAudit, verifyAudit } from "./audit";
import { openStore } from "./store";
import { newTotpSecret, otpauthUri, verifyTotp } from "./totp";

export type Io = {
  ask(question: string): Promise<string>;
  askHidden(question: string): Promise<string>;
  print(line: string): void;
};

export async function runCli(
  args: string[],
  db: Database,
  io: Io,
  options: {
    now?: () => number;
    hasher?: PasswordHasher;
    publicOrigin?: string;
  } = {},
): Promise<number> {
  const now = options.now ?? Date.now;
  const hasher = options.hasher ?? argon2id;
  const [command, name] = args;
  const audit = (
    action: string,
    target: string | null,
    outcome: "ok" | "refused" = "ok",
    detail?: string,
  ) =>
    appendAudit(db, { actor: "cli", action, target, outcome, detail }, now());

  if (command === "create-owner") {
    if (activeOwners(db) > 0) {
      io.print(
        "An owner exists already. Add people on the Accounts page; use `reset` if an owner is locked out.",
      );
      return 1;
    }
    const username = (
      await io.ask("User name (lower-case letters, digits, . _ -): ")
    )
      .trim()
      .toLowerCase();
    if (!validUsername(username) || findAccount(db, username)) {
      io.print("That user name is not valid or is taken.");
      return 1;
    }
    const password = await io.askHidden(
      `Password (at least ${MIN_PASSWORD} characters, hidden): `,
    );
    const repeat = await io.askHidden("The same password again (hidden): ");
    if (password.length < MIN_PASSWORD || password !== repeat) {
      io.print("The passwords are too short or not the same.");
      return 1;
    }
    const secret = newTotpSecret();
    io.print("");
    io.print(
      "Add this key to your authenticator app (time-based, 6 digits, 30 seconds):",
    );
    io.print(`  ${secret.match(/.{1,4}/g)?.join(" ")}`);
    io.print(`  ${otpauthUri("BlackArk Board", username, secret)}`);
    io.print("Do not copy it anywhere else. It is shown only now.");
    const code = (await io.ask("The 6-digit code your app shows now: ")).trim();
    const step = verifyTotp(secret, code, now());
    if (step === null) {
      io.print(
        "That code is not right. Check the phone's time and run create-owner again.",
      );
      audit("account.create", username, "refused", "owner: wrong first code");
      return 1;
    }
    await activateDirectly(
      db,
      username,
      "owner",
      password,
      secret,
      step,
      now(),
      hasher,
    );
    audit("account.create", username, "ok", "role owner");
    io.print(`Owner ${username} is ready. Sign in on the board.`);
    return 0;
  }

  if (command === "reset" && name) {
    const account = findAccount(db, name);
    if (!account) {
      io.print("No such account.");
      return 1;
    }
    const token = resetAccount(db, account, now());
    audit("account.reset", account.username);
    io.print(`Setup link for ${account.username}, valid 24 hours, shown once:`);
    io.print(`  ${options.publicOrigin ?? "https://<board>"}/setup/${token}`);
    return 0;
  }

  if (command === "unlock" && name) {
    db.query("DELETE FROM login_failures WHERE username = ?").run(
      name.toLowerCase(),
    );
    audit("account.unlock", name.toLowerCase());
    io.print(`${name} can try to sign in again.`);
    return 0;
  }

  if (command === "list") {
    for (const account of listAccounts(db)) {
      io.print(
        `${account.username}\t${account.role}\t${account.status}\t${account.created_at}`,
      );
    }
    return 0;
  }

  if (command === "verify-audit") {
    const broken = verifyAudit(db);
    io.print(
      broken === null
        ? "The audit log is intact."
        : `Audit entry ${broken} does not follow from the one before it.`,
    );
    return broken === null ? 0 : 2;
  }

  io.print(
    "Commands: create-owner | reset <user> | unlock <user> | list | verify-audit",
  );
  return 1;
}

/** Reads one line from the terminal without showing what is typed. */
function hiddenPrompt(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY)
    throw new Error(
      "A hidden prompt needs a terminal (docker compose exec -it).",
    );
  process.stdout.write(question);
  return new Promise((resolve, reject) => {
    let typed = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const done = (error?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(typed);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return done();
        if (char === "\u0003") return done(new Error("Cancelled."));
        if (char === "\u007f" || char === "\b") typed = typed.slice(0, -1);
        else if (char >= " ") typed += char;
      }
    };
    stdin.on("data", onData);
  });
}

async function linePrompt(question: string): Promise<string> {
  process.stdout.write(question);
  for await (const line of console) return line;
  return "";
}

if (import.meta.main) {
  const dir = process.env.BOARD_DATA_DIR ?? "/data";
  const db = openStore(join(dir, "board.sqlite"));
  const code = await runCli(
    process.argv.slice(2),
    db,
    {
      ask: linePrompt,
      askHidden: hiddenPrompt,
      print: (line) => console.log(line),
    },
    { publicOrigin: process.env.BOARD_PUBLIC_ORIGIN },
  );
  db.close();
  process.exit(code);
}
