/**
 * Charge the cloud running of months that have ended.
 *
 *   bun server/scripts/charge-cloud-usage.ts                 the last three months that have ended
 *   bun server/scripts/charge-cloud-usage.ts --period 2026-09  one month
 *
 * Run from a CronJob at the start of each month. Safe to run as often as you like: a month is
 * charged once (src/cloud/charging.ts says how that is guaranteed), so a run that finds nothing to do
 * does nothing, and a month that could not be charged is tried again.
 *
 * Does nothing unless this deployment charges for cloud running (`ARK_CLOUD_MODE=metered`) and staff
 * have set the rates: with neither, there is nothing anybody agreed to pay.
 *
 * EXIT CODE. Non-zero when a month was left `uncertain` (a person has to look at the payment service)
 * so that the failure is seen; refused cards are routine and are not a failure of the job.
 */
import { createAccountStore } from "../src/accounts/store";
import { createAuditStore } from "../src/audit";
import { billingFromEnvironment } from "../src/billing/select";
import { chargePeriod } from "../src/cloud/charging";
import { periodOf, previousPeriod } from "../src/cloud/intervals";
import { createCloudMeter } from "../src/cloud/meter";
import { createCloudStore } from "../src/cloud/store";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";

const config = loadConfig(process.env);
if (config.cloud.mode !== "metered") {
  console.info(
    JSON.stringify({
      type: "cloud-charge",
      skipped: `ARK_CLOUD_MODE is ${config.cloud.mode}, so nothing is charged.`,
    }),
  );
  process.exit(0);
}

const database = createDatabase(config.databaseUrl);
const given = process.argv.indexOf("--period");
const periods: string[] = [];
if (given >= 0) {
  periods.push(process.argv[given + 1] ?? "");
} else {
  let period = previousPeriod(periodOf(new Date()));
  for (let i = 0; i < 3; i++) {
    periods.unshift(period);
    period = previousPeriod(period);
  }
}

try {
  const deps = {
    database,
    meter: createCloudMeter(database),
    store: createCloudStore(database),
    billing: billingFromEnvironment(process.env, {
      appUrl: config.appUrl ?? config.publicUrl,
    }),
    accounts: createAccountStore(database, { billingMode: "subscriptions" }),
    audit: createAuditStore(database),
  };
  let uncertain = 0;
  for (const period of periods) {
    const report = await chargePeriod(deps, period);
    uncertain += report.uncertain;
    console.info(JSON.stringify({ type: "cloud-charge", ...report }));
  }
  if (uncertain > 0) process.exitCode = 1;
} finally {
  await database.$client.end({ timeout: 5 });
}
