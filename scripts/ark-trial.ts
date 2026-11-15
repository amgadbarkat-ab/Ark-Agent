#!/usr/bin/env bun
/**
 * BlackArk's trial signing tool (#109). Run on the signing computer only.
 *
 *   bun scripts/ark-trial.ts keygen [--dir <folder>]
 *       Makes the signing key. The PRIVATE key is written to <folder>/ark-trial-private.pem
 *       (default ~/.arktrial), readable by you alone, and is never printed. Only the PUBLIC key is
 *       printed: that is the one to post on #109 or set as ARK_TRIAL_PUBLIC_KEY.
 *
 *   bun scripts/ark-trial.ts sign-profile <draft.json> [--key <pem>] [--out <file>]
 *       Checks a draft profile and writes <customer>.arktrial next to it (or to --out).
 *       issuedAt is set to now when the draft has none.
 *
 *   bun scripts/ark-trial.ts sign-code --customer <id> --action extend --until <date> [--key <pem>]
 *   bun scripts/ark-trial.ts sign-code --customer <id> --action end|paid [--key <pem>]
 *       Prints one single-use unlock code for that customer.
 *
 *   bun scripts/ark-trial.ts show <file.arktrial | ARK1-code> [--public-key <base64>]
 *       Prints what a profile or a code says, and whether that key signed it.
 *
 * The private key is never committed, never sent anywhere and never put in an app. Anyone who has
 * it can make trials and codes for any customer: keep the file, and a backup of it, offline.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { ROLES } from "../server/src/marketplace/official-roles";
import {
  CODE_PREFIX,
  encodeBase64Url,
  PROFILE_FORMAT,
  readProfile,
  readProfileFile,
  readUnlockCode,
  trialLengthDays,
  type UnlockCode,
} from "../shared/trial";
import {
  privateKeyFromPem,
  publicKeyFromBase64,
  publicKeyToBase64,
  signedByAny,
  signText,
} from "../shared/trial-sign";

const DEFAULT_DIR = join(homedir(), ".arktrial");
const KEY_FILE = "ark-trial-private.pem";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  const value = args[at + 1];
  if (!value || value.startsWith("--")) fail(`${name} needs a value.`);
  return value;
}

function loadKey(args: string[]) {
  const path = resolve(option(args, "--key") ?? join(DEFAULT_DIR, KEY_FILE));
  if (!existsSync(path)) {
    fail(`No private key at ${path}. Run keygen first, or give --key.`);
  }
  return privateKeyFromPem(readFileSync(path, "utf8"));
}

function keygen(args: string[]) {
  const dir = resolve(option(args, "--dir") ?? DEFAULT_DIR);
  const path = join(dir, KEY_FILE);
  if (existsSync(path)) {
    fail(
      `${path} already exists. It is not replaced: every trial signed with it would stop working.`,
    );
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  writeFileSync(
    path,
    privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    { mode: 0o600, flag: "wx" },
  );
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows has no such mode; the file is in the user's own profile folder.
  }
  console.log(
    `Private key written to ${path} (keep it offline; never share it).`,
  );
  console.log("");
  console.log("PUBLIC key (post this one):");
  console.log(publicKeyToBase64(publicKey));
}

function signProfile(args: string[]) {
  const draftPath = args[0];
  if (!draftPath || draftPath.startsWith("--")) {
    fail("Give the draft profile: sign-profile <draft.json>");
  }
  const key = loadKey(args);
  const draft = JSON.parse(readFileSync(resolve(draftPath), "utf8")) as Record<
    string,
    unknown
  >;
  draft.issuedAt ??= new Date().toISOString();
  const profile = readProfile(draft);
  const roles = new Set(ROLES.map((role) => role.slug));
  for (const entry of profile.roster) {
    if (entry.basedOn && !roles.has(entry.basedOn)) {
      fail(
        `${entry.key}: basedOn "${entry.basedOn}" is not an official role. Use one of: ${[...roles].join(", ")}`,
      );
    }
  }
  const encoded = encodeBase64Url(JSON.stringify(profile));
  const file = {
    format: PROFILE_FORMAT,
    profile: encoded,
    signature: signText(key, encoded),
  };
  const out = resolve(
    option(args, "--out") ??
      join(dirname(resolve(draftPath)), `${profile.customer.id}.arktrial`),
  );
  writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);
  console.log(`Signed ${basename(out)} for ${profile.customer.name}:`);
  console.log(
    `  ${profile.startsAt} to ${profile.endsAt} (${trialLengthDays(profile.startsAt, profile.endsAt)} days), plan ${profile.plan}`,
  );
  console.log(
    `  ${profile.roster.length} employees, making more ${profile.createBlocked ? "blocked" : "allowed"}`,
  );
  console.log(`  check-in: ${profile.checkInUrl ?? "none"}`);
  console.log(
    `  paid add-ons: ${profile.addons?.join(", ") ?? "none (phone answering stays off)"}`,
  );
}

function signCode(args: string[]) {
  const customer = option(args, "--customer") ?? fail("Give --customer <id>.");
  const action = option(args, "--action");
  if (action !== "extend" && action !== "end" && action !== "paid") {
    fail("Give --action extend, end or paid.");
  }
  const code: UnlockCode = {
    v: 1,
    customer,
    nonce: randomBytes(12).toString("base64url"),
    action,
    issuedAt: new Date().toISOString(),
  };
  if (action === "extend") {
    const until =
      option(args, "--until") ?? fail("extend needs --until <date>.");
    const time = Date.parse(until);
    if (Number.isNaN(time)) fail(`${until} is not a date.`);
    code.until = new Date(time).toISOString();
  }
  const key = loadKey(args);
  const payload = encodeBase64Url(JSON.stringify(code));
  const full = `${CODE_PREFIX}${payload}.${signText(key, payload)}`;
  // Checked back before it is printed, so a code that would be refused is never handed out.
  readUnlockCode(full);
  console.log(full);
}

function show(args: string[]) {
  const target = args[0] ?? fail("Give a .arktrial file or an ARK1- code.");
  const publicKey = option(args, "--public-key");
  const keys = publicKey ? [publicKeyFromBase64(publicKey)] : [];
  if (target.startsWith(CODE_PREFIX)) {
    const { payload, signature, code } = readUnlockCode(target);
    console.log(JSON.stringify(code, null, 2));
    if (publicKey) {
      console.log(
        signedByAny(keys, payload, signature)
          ? "Signed by that key."
          : "NOT signed by that key.",
      );
    }
    return;
  }
  const { file, profile } = readProfileFile(
    readFileSync(resolve(target), "utf8"),
  );
  console.log(JSON.stringify(profile, null, 2));
  if (publicKey) {
    console.log(
      signedByAny(keys, file.profile, file.signature)
        ? "Signed by that key."
        : "NOT signed by that key.",
    );
  }
}

const [command, ...rest] = process.argv.slice(2);
try {
  switch (command) {
    case "keygen":
      keygen(rest);
      break;
    case "sign-profile":
      signProfile(rest);
      break;
    case "sign-code":
      signCode(rest);
      break;
    case "show":
      show(rest);
      break;
    default:
      fail(
        "Use: keygen | sign-profile <draft.json> | sign-code --customer <id> --action extend|end|paid | show <file|code>",
      );
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
