import type { BillingMode } from "../accounts/store";
import type { BillingProvider } from "../billing/provider";
import type { AuthConfig, DeploymentConfig } from "../config";
import type { DeploymentFacts } from "./checks";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether staff sign in through a directory the company controls: Okta, or one Microsoft Entra tenant.
 *
 * `common` and `organizations` admit anybody with a Microsoft account, so they are not a directory
 * the company controls, and an administrator who got in that way would be whoever signed up first.
 */
export function staffDirectoryConfigured(auth: AuthConfig | undefined) {
  if (!auth) return false;
  if (auth.okta) return true;
  return auth.microsoft !== undefined && GUID.test(auth.microsoft.tenantId);
}

/** The deployment's own settings, in the terms the go-live checks are written in. */
export function deploymentFacts(input: {
  config: Pick<
    DeploymentConfig,
    | "cloud"
    | "termsAcceptance"
    | "auditShipping"
    | "metricsPort"
    | "contentSecurityPolicy"
    | "appUrl"
    | "previousKeyEncryptionKeys"
    | "auth"
  >;
  billing: BillingProvider;
  billingMode: BillingMode;
  /** Whether cloud running has been priced. */
  cloudPriced: boolean;
}): DeploymentFacts {
  const { config, billing } = input;
  return {
    hosted: input.billingMode === "subscriptions",
    billing: {
      id: billing.id,
      ...(billing.environment ? { environment: billing.environment } : {}),
    },
    cloud: { mode: config.cloud.mode, priced: input.cloudPriced },
    termsAcceptance: config.termsAcceptance,
    auditShipping: config.auditShipping,
    metricsServed: config.metricsPort !== undefined,
    contentSecurityPolicy: config.contentSecurityPolicy,
    appUrl: config.appUrl,
    oldEncryptionKeys: config.previousKeyEncryptionKeys.length > 0,
    staffDirectory: staffDirectoryConfigured(config.auth),
  };
}
