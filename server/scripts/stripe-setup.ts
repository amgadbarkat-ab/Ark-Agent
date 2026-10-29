/**
 * Create Ark's product and monthly prices in a Stripe account's test mode, and print the settings.
 *
 *   STRIPE_SECRET_KEY=sk_test_... APP_URL=https://ark.example.com \
 *     bun server/scripts/stripe-setup.ts [--try-checkout]
 *
 * Idempotent, test mode only, and it never changes a price that exists
 * (server/src/billing/stripe-setup.ts says why). The key is read from the environment and never
 * printed. With `--try-checkout` it also opens one test checkout session for the cheapest plan, the
 * same request the server makes, and prints its address: proof that the key and the price work end to
 * end. Nothing is paid unless somebody opens it and pays with a test card.
 */
import {
  STRIPE_EVENTS,
  setupStripe,
  tryStripeCheckout,
} from "../src/billing/stripe-setup";

const key = process.env.STRIPE_SECRET_KEY?.trim();
const appUrl = (process.env.APP_URL?.trim() || "http://localhost:3010").replace(
  /\/+$/,
  "",
);
if (!key) {
  console.error(
    "Set STRIPE_SECRET_KEY (a test key, sk_test_... or rk_test_...).",
  );
  process.exit(2);
}
if (!key.startsWith("sk_test_") && !key.startsWith("rk_test_")) {
  console.error(
    "STRIPE_SECRET_KEY is not a test key. Stripe is set up in test mode only; nothing was sent.",
  );
  process.exit(2);
}

const result = await setupStripe({ secretKey: key });
console.info(
  result.created.length > 0
    ? `Created in Stripe (test mode): ${result.created.join(", ")}.`
    : "Everything was already there.",
);
for (const line of result.drift) {
  console.warn(
    `DRIFT: the ${line.plan} price in Stripe is ${line.stripeCents} cents and shared/plans.ts says ${line.tableCents}. Left alone; decide which is right.`,
  );
}
console.info("\nSettings for the server (not secret):");
console.info("ARK_BILLING_PROVIDER=stripe");
for (const [plan, id] of Object.entries(result.prices)) {
  console.info(`STRIPE_PRICE_${plan.toUpperCase()}=${id}`);
}

if (process.argv.includes("--try-checkout")) {
  const [first] = Object.values(result.prices);
  if (first) {
    const session = await tryStripeCheckout({
      secretKey: key,
      priceId: first,
      returnUrl: `${appUrl}/settings/plan`,
    });
    console.info(
      `\nA test checkout session (${session.id}) is open at:\n${session.url}`,
    );
  }
}

console.info(
  `\nStill by hand in Stripe's dashboard (test mode): a webhook endpoint at ${appUrl}/api/billing/webhook/stripe for ${STRIPE_EVENTS.join(", ")}; its signing secret (whsec_...) goes in STRIPE_WEBHOOK_SECRET, in the secret store. And save the customer portal's settings once, or Manage billing is refused.`,
);
