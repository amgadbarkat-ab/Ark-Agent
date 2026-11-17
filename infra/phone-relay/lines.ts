/**
 * Adds or removes a line in the relay's lines file. Run inside the relay container by deploy.sh:
 *   bun lines.ts add <name> <+number> [<+fallback>]   prints the new line token once
 *   bun lines.ts bill <name> <customer-id|none>      pays the line's calls from that customer's
 *                                                     prepaid phone balance (v0.1.47), or stops
 *   bun lines.ts remove <name>
 *   bun lines.ts list
 * Only the token's SHA-256 is stored; the token itself goes to the on-site installer.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { type Line, sha256Hex } from "./relay";

const file = process.env.RELAY_LINES_FILE?.trim() || "/data/lines.json";
const E164 = /^\+[1-9]\d{6,14}$/;
const NAME = /^[a-z0-9-]{2,40}$/;

function read(): Line[] {
  if (!existsSync(file)) return [];
  const raw = JSON.parse(readFileSync(file, "utf8")) as { lines?: Line[] };
  return raw.lines ?? [];
}

function write(lines: Line[]) {
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ lines }, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temp, file);
}

const [command, name, number, fallback] = process.argv.slice(2);
const fail = (text: string) => {
  console.error(text);
  process.exit(1);
};

if (command === "add") {
  if (!name || !NAME.test(name))
    fail(
      "The name is 2-40 lower-case letters, digits or hyphens, e.g. demo-shop.",
    );
  if (!number || !E164.test(number))
    fail("The number is the Twilio number in +E.164 form, e.g. +302101234567.");
  if (fallback && !E164.test(fallback))
    fail("The fallback is a number in +E.164 form.");
  const lines = read().filter(
    (line) => line.name !== name && line.number !== number,
  );
  const token = randomBytes(32).toString("base64url");
  lines.push({
    name: name as string,
    number: number as string,
    tokenSha256: sha256Hex(token),
    ...(fallback ? { fallback } : {}),
  });
  write(lines);
  console.log(`Line ${name} on ${number} saved.`);
  console.log(
    "Line token (shown once; type it into the install's masked field, never into a chat):",
  );
  console.log(token);
} else if (command === "bill") {
  // The third argument is the ArkAgent customer id here, not a number.
  const customer = number;
  const lines = read();
  const found = lines.find((line) => line.name === name);
  if (!found) fail(`There is no line called ${name}.`);
  if (
    !customer ||
    !(customer === "none" || /^[a-z0-9][a-z0-9-]{1,63}$/.test(customer))
  )
    fail(
      "Give the ArkAgent customer id (lower-case letters, digits, hyphens), or none.",
    );
  write(
    lines.map((line) => {
      if (line.name !== name) return line;
      const { customerId: _, ...rest } = line;
      return customer === "none" ? rest : { ...rest, customerId: customer };
    }),
  );
  console.log(
    customer === "none"
      ? `Line ${name} is no longer billed.`
      : `Line ${name} is billed to ${customer}'s prepaid phone balance.`,
  );
} else if (command === "remove") {
  const lines = read();
  const kept = lines.filter((line) => line.name !== name);
  if (kept.length === lines.length) fail(`There is no line called ${name}.`);
  write(kept);
  console.log(`Line ${name} removed. Its install can no longer connect.`);
} else if (command === "list") {
  for (const line of read())
    console.log(
      `${line.name}\t${line.number}\tfallback ${line.fallback ?? "(none)"}\tbilled to ${line.customerId ?? "(not billed)"}`,
    );
} else {
  fail(
    "Use: add <name> <+number> [<+fallback>] | bill <name> <customer-id|none> | remove <name> | list",
  );
}
