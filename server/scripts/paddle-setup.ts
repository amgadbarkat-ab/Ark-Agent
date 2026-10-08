/**
 * Create Ark's product, prices and notification destination in a Paddle account.
 *
 *   PADDLE_SETUP_API_KEY=pdl_sdbx_apikey_... PADDLE_ENVIRONMENT=sandbox APP_URL=https://ark.example.com \
 *     bun server/scripts/paddle-setup.ts [--vault <key-vault-name>]
 *
 * Idempotent, and it never changes a price that exists (server/src/billing/paddle-setup.ts says why).
 * The key it needs (product.write, price.write, notification_setting.write) is NOT the key the server
 * runs with; make it for this, and revoke it after.
 *
 * With `--vault`, the notification secret is put straight into that Azure Key Vault as
 * `ark-paddle-webhook-secret`, and is never printed. Without it the secret is not shown either: copy
 * it from Paddle's notification page. The price ids are not secret, and are printed as the settings
 * the server reads.
 */
import { setupPaddle } from "../src/billing/paddle-setup";

const key = process.env.PADDLE_SETUP_API_KEY?.trim();
const environment = process.env.PADDLE_ENVIRONMENT?.trim() ?? "sandbox";
const appUrl = process.env.APP_URL?.trim().replace(/\/+$/, "");
if (!key || !appUrl || !["sandbox", "production"].includes(environment)) {
  console.error(
    "Set PADDLE_SETUP_API_KEY, APP_URL (https://...) and PADDLE_ENVIRONMENT (sandbox or production).",
  );
  process.exit(2);
}
const vaultFlag = process.argv.indexOf("--vault");
const vault = vaultFlag >= 0 ? process.argv[vaultFlag + 1] : undefined;
if (vaultFlag >= 0 && !vault) {
  console.error("--vault needs the name of the Key Vault.");
  process.exit(2);
}

const result = await setupPaddle({
  apiKey: key,
  environment: environment as "sandbox" | "production",
  webhookUrl: `${appUrl}/api/billing/webhook/paddle`,
});

console.info(
  result.created.length > 0
    ? `Created in Paddle: ${result.created.join(", ")}.`
    : "Everything was already there.",
);
for (const line of result.drift) {
  console.warn(
    `DRIFT: the ${line.plan} price in Paddle is ${line.paddleCents} cents and shared/plans.ts says ${line.tableCents}. Left alone; decide which is right.`,
  );
}

console.info("\nSettings for the server (not secret):");
for (const [plan, id] of Object.entries(result.prices)) {
  console.info(`PADDLE_PRICE_${plan.toUpperCase()}=${id}`);
}

if (result.notification.secret) {
  if (vault) {
    const stored = Bun.spawnSync(
      [
        "az",
        "keyvault",
        "secret",
        "set",
        "--vault-name",
        vault,
        "--name",
        "ark-paddle-webhook-secret",
        "--file",
        "/dev/stdin",
        "--encoding",
        "utf-8",
        "--only-show-errors",
        "--output",
        "none",
      ],
      { stdin: new TextEncoder().encode(result.notification.secret) },
    );
    if (stored.exitCode !== 0) {
      console.error(
        "Could not store the notification secret in the vault. Copy it from Paddle's notification page.",
      );
      process.exitCode = 1;
    } else {
      console.info(
        "The notification secret is in the vault as ark-paddle-webhook-secret.",
      );
    }
  } else {
    console.info(
      "The notification secret was returned by Paddle and is not shown. Run again with --vault <name> on a fresh destination, or copy it from Paddle's notification page.",
    );
  }
} else {
  console.info(
    "The notification destination already existed: copy its secret from Paddle's notification page if the server does not have it.",
  );
}
console.info(
  "\nStill by hand in Paddle: the client-side token (Authentication page), and approving the checkout domain.",
);
