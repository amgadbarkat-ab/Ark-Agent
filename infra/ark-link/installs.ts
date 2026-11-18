/**
 * Adds or removes an install (a customer's desktop) on the relay. Run inside the container by deploy.sh:
 *   bun installs.ts add <id>      prints the new install token once
 *   bun installs.ts remove <id>   that desktop can no longer connect; its phones stop working
 *   bun installs.ts list
 * Only the token's SHA-256 is stored. The token goes to the administrator at the desktop, who types it
 * into Settings → Phones once.
 */
import { newInstallToken, tokenHash } from "../../shared/ark-link";
import { INSTALL_ID, readInstalls, writeInstalls } from "./store";

const file = process.env.LINK_INSTALLS_FILE?.trim() || "/data/installs.json";
const [command, id] = process.argv.slice(2);
const fail = (text: string): never => {
  console.error(text);
  process.exit(1);
};

if (command === "add") {
  if (!id || !INSTALL_ID.test(id))
    fail(
      "The id is 2-40 lower-case letters, digits or hyphens, e.g. demo-shop.",
    );
  const token = newInstallToken();
  const installs = readInstalls(file).filter((entry) => entry.id !== id);
  installs.push({ id: id as string, tokenSha256: await tokenHash(token) });
  writeInstalls(file, installs);
  console.log(`Install ${id} saved.`);
  console.log(
    "Install token (shown once; type it into Settings → Phones on that computer, never into a chat):",
  );
  console.log(token);
} else if (command === "remove") {
  const installs = readInstalls(file);
  const kept = installs.filter((entry) => entry.id !== id);
  if (kept.length === installs.length)
    fail(`There is no install called ${id}.`);
  writeInstalls(file, kept);
  console.log(`Install ${id} removed. Its computer can no longer connect.`);
} else if (command === "list") {
  for (const entry of readInstalls(file)) console.log(entry.id);
} else {
  fail("Use: add <id> | remove <id> | list");
}
