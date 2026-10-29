/**
 * What an administrator should settle before customers arrive, read from how this deployment is
 * configured right now.
 *
 * Each check says one thing: it is fine (`ok`), it has to be done before this is a service customers
 * can rely on (`todo`), or it is a choice that is fine either way and only worth knowing (`info`).
 * Nothing here changes anything. It reports the deployment's own settings back, so the list cannot
 * drift from the truth the way a checklist in a document does.
 *
 * Pure: the settings go in, the verdicts come out. The route gathers the settings.
 */

export type CheckState = "ok" | "todo" | "info";

export type Check = {
  id: string;
  title: string;
  state: CheckState;
  /** One sentence: what is true, and when it is not fine, what to do. */
  detail: string;
};

export type DeploymentFacts = {
  /** Whether customers get accounts of their own (`ARK_BILLING_MODE=subscriptions`). */
  hosted: boolean;
  billing: { id: string; environment?: "live" | "test" };
  cloud: { mode: "included" | "metered" | "off"; priced: boolean };
  termsAcceptance: "off" | "required";
  auditShipping: "off" | "log";
  metricsServed: boolean;
  contentSecurityPolicy: "off" | "report-only" | "enforce";
  appUrl: string | undefined;
  /** Whether an old encryption key is still configured, which means a rotation is unfinished. */
  oldEncryptionKeys: boolean;
  /** Whether staff sign in through a directory the company controls (one Entra tenant, or Okta). */
  staffDirectory: boolean;
};

export function goLiveChecks(facts: DeploymentFacts): Check[] {
  /** A check that matters to a service with customers, and is only worth knowing for a company's own. */
  const forCustomers = (ok: boolean): CheckState =>
    ok ? "ok" : facts.hosted ? "todo" : "info";

  const checks: Check[] = [];

  if (!facts.hosted) {
    checks.push({
      id: "payments",
      title: "Payments",
      state: "info",
      detail:
        "This deployment runs for one company and takes no payments (ARK_BILLING_MODE is not subscriptions).",
    });
  } else if (facts.billing.id === "manual") {
    checks.push({
      id: "payments",
      title: "Payments",
      state: "todo",
      detail:
        "Customers cannot pay: the payment provider is manual. Set ARK_BILLING_PROVIDER=paddle (docs/ark/12-paddle.md).",
    });
  } else if (facts.billing.environment !== "live") {
    checks.push({
      id: "payments",
      title: "Payments",
      state: "todo",
      detail:
        facts.billing.id === "stripe"
          ? "The payment provider (stripe) is in test mode, so no real money is taken. Stripe is supported in test mode only for now (docs/ark/26-stripe.md)."
          : `The payment provider (${facts.billing.id}) is in test mode, so no real money is taken. Switch to the live Paddle account once the sandbox run has passed.`,
    });
  } else {
    checks.push({
      id: "payments",
      title: "Payments",
      state: "ok",
      detail: `Taking real payments through ${facts.billing.id}.`,
    });
  }

  checks.push({
    id: "terms",
    title: "Terms of service",
    state: forCustomers(facts.termsAcceptance === "required"),
    detail:
      facts.termsAcceptance === "required"
        ? "New customers must accept the current terms before using Ark."
        : "Customers are not asked to accept the terms. Once a lawyer has reviewed the text, set TERMS_ACCEPTANCE=required.",
  });

  if (facts.cloud.mode === "metered") {
    checks.push({
      id: "cloud-prices",
      title: "Cloud running prices",
      state: facts.cloud.priced ? "ok" : "todo",
      detail: facts.cloud.priced
        ? "Prices are set, so customers can switch cloud running on."
        : "Cloud running is an add-on but has no prices, so nobody can switch it on. Set them under Cloud costs, from measured cost.",
    });
  } else {
    checks.push({
      id: "cloud-prices",
      title: "Cloud running prices",
      state: "info",
      detail:
        facts.cloud.mode === "off"
          ? "Cloud running is switched off on this deployment."
          : "Cloud running is included for everyone, so there is nothing to price.",
    });
  }

  checks.push({
    id: "audit-shipping",
    title: "Audit trail copy",
    state: forCustomers(facts.auditShipping === "log"),
    detail:
      facts.auditShipping === "log"
        ? "Each audit event is also written to the process log, where the application cannot rewrite it."
        : "The audit trail lives only in the database. Set AUDIT_SHIPPING=log so there is a copy the application cannot change.",
  });

  checks.push({
    id: "metrics",
    title: "Metrics",
    state: forCustomers(facts.metricsServed),
    detail: facts.metricsServed
      ? "Metrics are served on their own port for the monitoring system to read."
      : "No metrics are served, so there is nothing to graph or alert on. Set METRICS_PORT.",
  });

  checks.push({
    id: "content-security-policy",
    title: "Content Security Policy",
    state:
      facts.contentSecurityPolicy === "enforce"
        ? "ok"
        : facts.contentSecurityPolicy === "off"
          ? forCustomers(false)
          : "info",
    detail:
      facts.contentSecurityPolicy === "enforce"
        ? "The browser blocks anything the policy does not allow."
        : facts.contentSecurityPolicy === "report-only"
          ? "The policy only reports what it would block. Change it to enforce once the reports are quiet (docs/ark/15-security-review.md)."
          : "No policy is sent beyond frame-ancestors. Use report-only or enforce.",
  });

  const secure = facts.appUrl?.startsWith("https://") === true;
  checks.push({
    id: "https",
    title: "Public address",
    state: forCustomers(secure),
    detail: secure
      ? "The app is served over HTTPS."
      : facts.appUrl
        ? "The app address is not HTTPS. Customers' sign-ins and payments must not cross plain HTTP."
        : "The app address is not set (OPENBOT_APP_URL or TRUSTED_ORIGINS).",
  });

  checks.push({
    id: "staff-sign-in",
    title: "Staff sign-in",
    state: forCustomers(facts.staffDirectory),
    detail: facts.staffDirectory
      ? "Staff sign in through the company's own directory."
      : "Staff are not tied to a directory the company controls. Configure a single Entra tenant (or Okta) so only staff can be administrators.",
  });

  checks.push({
    id: "encryption-key",
    title: "Encryption key",
    state: facts.oldEncryptionKeys ? "todo" : "ok",
    detail: facts.oldEncryptionKeys
      ? "An older encryption key is still configured, so a key rotation is unfinished. Re-seal what it protects, then remove it (docs/ark/13-azure-hosting.md, key rotation)."
      : "Only the current encryption key is configured.",
  });

  return checks;
}
