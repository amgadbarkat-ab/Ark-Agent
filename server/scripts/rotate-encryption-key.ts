/**
 * Re-seal everything stored under a retired data-encryption key with the current one.
 *
 *   bun server/scripts/rotate-encryption-key.ts            report only: what would change
 *   bun server/scripts/rotate-encryption-key.ts --apply    do it
 *
 * Needs DATABASE_URL, KEY_ENCRYPTION_KEY (the NEW key) and KEY_ENCRYPTION_KEY_PREVIOUS (the old one,
 * or all the old ones). The same variables the server runs with, so run it inside the server's own
 * container. The whole procedure, and why it is in this order, is in docs/ark/13-azure-hosting.md.
 *
 * EXIT CODE IS THE ANSWER, so a runbook can act on it without reading the output:
 *   0  nothing is sealed under any key but the current one. The old key can be removed. (Run it
 *      with KEY_ENCRYPTION_KEY_PREVIOUS UNSET for the final check: that is the condition the server
 *      will be in after the old key is gone, and anything it cannot open is listed.)
 *   1  something could not be opened by any key this process holds. Do NOT remove the old key; the
 *      ids are listed. (A missing key, or damaged data.)
 *   2  work remains: a report that finds values still under an old key, or an apply that lost a race
 *      with live writes. Run it again.
 *
 * NEVER PRINTS A VALUE. Counts and row ids only.
 */
import { loadConfig } from "../src/config";
import { useRetiredEncryptionKeys } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { resealAll } from "../src/rekey";

const apply = process.argv.includes("--apply");

const config = loadConfig();
if (config.previousKeyEncryptionKeys.length === 0) {
  // Not an error, and not a reason to stop: with no old key held, a report is exactly the condition
  // the server will be in once the old key is removed. Anything it cannot open then is listed.
  console.info(
    "KEY_ENCRYPTION_KEY_PREVIOUS is not set. Checking that everything opens with the current key alone.",
  );
}
useRetiredEncryptionKeys(config.previousKeyEncryptionKeys);

const database = createDatabase(config.databaseUrl);
try {
  const reports = await resealAll(database, {
    currentKey: config.keyEncryptionKey,
    dryRun: !apply,
  });

  for (const report of reports) {
    console.info(
      JSON.stringify({
        type: "rotate-encryption-key",
        mode: apply ? "apply" : "report",
        ...report,
      }),
    );
  }

  const unreadable = reports.flatMap((report) => report.unreadable);
  const toDo = reports.reduce(
    (total, report) => total + (apply ? report.raced : report.resealed),
    0,
  );

  if (unreadable.length > 0) {
    console.error(
      `${unreadable.length} value(s) cannot be opened by any key this process holds. Keep every old key until they are understood.`,
    );
    process.exitCode = 1;
  } else if (toDo > 0) {
    console.error(
      apply
        ? `${toDo} value(s) changed while this ran. Run it again.`
        : `${toDo} value(s) are still under an old key. Run it with --apply.`,
    );
    process.exitCode = 2;
  } else if (apply) {
    console.info(
      "Done. Run it once more without --apply: exit 0 there means the old key can be removed.",
    );
  } else {
    console.info("Nothing is under an old key. The old key can be removed.");
  }
} finally {
  await database.$client.close();
}
