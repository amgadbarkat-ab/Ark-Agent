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
 *   bun scripts/ark-trial.ts sign-trial-code --customer <id> --until <date> [--plan team] [--addons phone] [--key <pem>]
 *       Prints a trial activation code (v0.1.42): opens ArkAgent on any computer until that moment.
 *       Signed with the trial key. The trial setup file counts as activation too, so a code is only
 *       needed where there is no setup session.
 *
 *   bun scripts/ark-trial.ts sign-license --customer <id> --period-end <date> [--plan team]
 *       [--seats 1] [--addons phone] [--renew-url https://…] [--key <pem>]
 *       Prints a paid licence key (v0.1.42), valid until the period end plus 7 days' grace. Signed
 *       with the licence key; until BlackArk makes a separate one, that is the trial key
 *       (shared/license-public-key.ts). Typing the same key again on a reinstall works.
 *
 *   bun scripts/ark-trial.ts selfserve-keygen [--dir <folder>]
 *       Makes the self-serve trial key for blackark.uk (v0.1.58): writes the config.php line to
 *       <folder>/selfserve-config.php.txt (default ~/.arkselfserve) and prints only the PUBLIC key.
 *       The app trusts that key for 7-day Ark Team trial codes and nothing else.
 *
 *   bun scripts/ark-trial.ts license-keygen [--dir <folder>]
 *       Makes the SEPARATE licence signing key for the payment server on blackark.uk (v0.1.44).
 *       Writes <folder>/license-config.php.txt (default ~/.arklicense) holding the one config line
 *       for blackark.uk's config.php, readable by you alone, and the private key as PEM beside it.
 *       Prints only the PUBLIC key: post that one on #109 so it is built into the app.
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
  type ActivationCode,
  LICENSE_GRACE_DAYS,
  readActivationCode,
} from "../shared/activation";
import { planById } from "../shared/plans";
import {
  CODE_PREFIX,
  encodeBase64Url,
  PROFILE_FORMAT,
  readProfile,
  readProfileFile,
  readUnlockCode,
  TRIAL_ADDONS,
  type TrialAddon,
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

function licenseKeygen(args: string[]) {
  const dir = resolve(option(args, "--dir") ?? join(homedir(), ".arklicense"));
  const pem = join(dir, "ark-license-private.pem");
  const php = join(dir, "license-config.php.txt");
  if (existsSync(pem) || existsSync(php)) {
    fail(
      `${dir} already has a licence key. It is not replaced: every key signed with it would stop working.`,
    );
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  const seed = Buffer.from(der.subarray(der.length - 32));
  const raw = Buffer.from(publicKeyToBase64(publicKey), "base64");
  // PHP sodium wants the 64-byte secret key: the 32-byte seed, then the 32-byte public key.
  const sodiumSecret = Buffer.concat([seed, raw]).toString("base64");
  writeFileSync(
    pem,
    privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    { mode: 0o600, flag: "wx" },
  );
  writeFileSync(
    php,
    `// Paste into checkin/config.php on blackark.uk, inside the array. Never post it anywhere.\n'license_secret_key' => '${sodiumSecret}',\n'license_public_key' => '${publicKeyToBase64(publicKey)}',\n`,
    { mode: 0o600, flag: "wx" },
  );
  for (const path of [pem, php]) {
    try {
      chmodSync(path, 0o600);
    } catch {
      // Windows has no such mode; the folder is in the user's own profile.
    }
  }
  console.log(
    `Licence key written to ${dir} (keep it offline except on blackark.uk).`,
  );
  console.log(`The config.php line is in ${php}.`);
  console.log("");
  console.log("PUBLIC licence key (post this one on #109):");
  console.log(publicKeyToBase64(publicKey));
}

/**
 * The self-serve trial key for blackark.uk (v0.1.58; Amgad, 26 Nov 2026). Like the licence key: only
 * the config.php line holds the secret, and it goes on blackark.uk alone. The app trusts its public
 * key for one thing only, a 7-day Ark Team trial code (shared/trial-public-key.ts).
 */
function selfServeKeygen(args: string[]) {
  const dir = resolve(
    option(args, "--dir") ?? join(homedir(), ".arkselfserve"),
  );
  const php = join(dir, "selfserve-config.php.txt");
  if (existsSync(php)) {
    fail(
      `${dir} already has a self-serve trial key. It is not replaced: every self-serve trial signed with it would stop working.`,
    );
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  const seed = Buffer.from(der.subarray(der.length - 32));
  const raw = Buffer.from(publicKeyToBase64(publicKey), "base64");
  // PHP sodium wants the 64-byte secret key: the 32-byte seed, then the 32-byte public key.
  const sodiumSecret = Buffer.concat([seed, raw]).toString("base64");
  writeFileSync(
    php,
    `// Paste into checkin/config.php on blackark.uk, inside the array. Never post it anywhere.\n'selfserve_trial_secret_key' => '${sodiumSecret}',\n`,
    { mode: 0o600, flag: "wx" },
  );
  try {
    chmodSync(php, 0o600);
  } catch {
    // Windows has no such mode; the folder is in the user's own profile.
  }
  console.log(
    `The config.php line is in ${php} (blackark.uk only; never post it).`,
  );
  console.log("");
  console.log("PUBLIC self-serve trial key (post this one on #149):");
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

function addonsOption(args: string[]): { addons?: TrialAddon[] } {
  const raw = option(args, "--addons");
  if (!raw) return {};
  const names = raw.split(",").map((name) => name.trim());
  for (const name of names) {
    if (!TRIAL_ADDONS.includes(name as TrialAddon)) {
      fail(
        `There is no add-on called ${name}. Known: ${TRIAL_ADDONS.join(", ")}`,
      );
    }
  }
  return { addons: names as TrialAddon[] };
}

function dateOption(args: string[], name: string): string {
  const value = option(args, name) ?? fail(`Give ${name} <date>.`);
  const time = Date.parse(value);
  if (Number.isNaN(time)) fail(`${value} is not a date.`);
  return new Date(time).toISOString();
}

function printActivation(code: ActivationCode, args: string[]) {
  const key = loadKey(args);
  const payload = encodeBase64Url(JSON.stringify(code));
  const full = `${CODE_PREFIX}${payload}.${signText(key, payload)}`;
  // Checked back before it is printed, so a code that would be refused is never handed out.
  readActivationCode(full);
  console.log(full);
}

function signTrialCode(args: string[]) {
  const customer = option(args, "--customer") ?? fail("Give --customer <id>.");
  const plan = option(args, "--plan") ?? "team";
  if (!planById(plan) || plan === "internal") fail(`${plan} is not a plan.`);
  printActivation(
    {
      v: 1,
      action: "trial",
      customer,
      nonce: randomBytes(12).toString("base64url"),
      issuedAt: new Date().toISOString(),
      until: dateOption(args, "--until"),
      plan: plan as ActivationCode["plan"],
      ...addonsOption(args),
    },
    args,
  );
}

function signLicense(args: string[]) {
  const customer = option(args, "--customer") ?? fail("Give --customer <id>.");
  const plan = option(args, "--plan") ?? "team";
  if (!planById(plan)) fail(`${plan} is not a plan.`);
  const seats = Number(option(args, "--seats") ?? "1");
  if (!Number.isInteger(seats) || seats < 1) fail("--seats is a whole number.");
  const periodEnd = Date.parse(dateOption(args, "--period-end"));
  const renewUrl = option(args, "--renew-url");
  if (renewUrl && !renewUrl.startsWith("https://")) {
    fail("--renew-url must start with https://.");
  }
  printActivation(
    {
      v: 1,
      action: "license",
      customer,
      nonce: randomBytes(12).toString("base64url"),
      issuedAt: new Date().toISOString(),
      plan: plan as ActivationCode["plan"],
      seats,
      validUntil: new Date(
        periodEnd + LICENSE_GRACE_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString(),
      ...addonsOption(args),
      ...(renewUrl ? { renewUrl } : {}),
    },
    args,
  );
}

function show(args: string[]) {
  const target = args[0] ?? fail("Give a .arktrial file or an ARK1- code.");
  const publicKey = option(args, "--public-key");
  const keys = publicKey ? [publicKeyFromBase64(publicKey)] : [];
  if (target.startsWith(CODE_PREFIX)) {
    let read: { payload: string; signature: string; code: unknown };
    try {
      read = readActivationCode(target);
    } catch {
      read = readUnlockCode(target);
    }
    const { payload, signature, code } = read;
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
    case "license-keygen":
      licenseKeygen(rest);
      break;
    case "selfserve-keygen":
      selfServeKeygen(rest);
      break;
    case "sign-trial-code":
      signTrialCode(rest);
      break;
    case "sign-license":
      signLicense(rest);
      break;
    case "show":
      show(rest);
      break;
    default:
      fail(
        "Use: keygen | selfserve-keygen | sign-profile <draft.json> | sign-code --customer <id> --action extend|end|paid | sign-trial-code --customer <id> --until <date> | sign-license --customer <id> --period-end <date> | show <file|code>",
      );
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
