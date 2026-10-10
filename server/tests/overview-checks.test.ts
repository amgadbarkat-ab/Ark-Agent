import { describe, expect, test } from "bun:test";
import { goLiveChecks, type DeploymentFacts } from "../src/overview/checks";
import {
  deploymentFacts,
  staffDirectoryConfigured,
} from "../src/overview/facts";
import { attentionFrom } from "../src/overview/routes";
import type { OverviewCounts } from "../src/overview/store";

/**
 * The overview's verdicts are read straight off the deployment's settings, so a wrong one tells an
 * administrator a service is ready when it is not. These pin the cases that matter: a company's own
 * deployment is never nagged about customers' concerns, and a hosted one is told plainly.
 */

const ready: DeploymentFacts = {
  hosted: true,
  billing: { id: "paddle", environment: "live" },
  cloud: { mode: "metered", priced: true },
  termsAcceptance: "required",
  auditShipping: "log",
  metricsServed: true,
  contentSecurityPolicy: "enforce",
  appUrl: "https://app.example.com",
  oldEncryptionKeys: false,
  staffDirectory: true,
};
const stateOf = (facts: DeploymentFacts, id: string) =>
  goLiveChecks(facts).find((check) => check.id === id)?.state;

describe("go-live checks", () => {
  test("a fully set up hosted service has nothing left to do", () => {
    expect(
      goLiveChecks(ready).filter((check) => check.state === "todo"),
    ).toEqual([]);
  });

  test("a hosted service in payment test mode is told no real money is taken", () => {
    const checks = goLiveChecks({
      ...ready,
      billing: { id: "paddle", environment: "test" },
    });
    const payments = checks.find((check) => check.id === "payments");
    expect(payments?.state).toBe("todo");
    expect(payments?.detail).toContain("test mode");
  });

  test("manual payments on a hosted service are a to-do, on a company's own deployment only information", () => {
    const manual = { id: "manual" };
    expect(stateOf({ ...ready, billing: manual }, "payments")).toBe("todo");
    expect(
      stateOf({ ...ready, hosted: false, billing: manual }, "payments"),
    ).toBe("info");
  });

  test("everything that matters to customers is only information for a company's own deployment", () => {
    const own = goLiveChecks({
      ...ready,
      hosted: false,
      billing: { id: "manual" },
      termsAcceptance: "off",
      auditShipping: "off",
      metricsServed: false,
      appUrl: "http://localhost:3010",
      staffDirectory: false,
      cloud: { mode: "included", priced: false },
    });
    expect(own.filter((check) => check.state === "todo")).toEqual([]);
  });

  test("terms that are not required are a to-do for a hosted service", () => {
    expect(stateOf({ ...ready, termsAcceptance: "off" }, "terms")).toBe("todo");
  });

  test("an add-on with no prices is a to-do, because nobody can switch it on", () => {
    expect(
      stateOf(
        { ...ready, cloud: { mode: "metered", priced: false } },
        "cloud-prices",
      ),
    ).toBe("todo");
    expect(
      stateOf(
        { ...ready, cloud: { mode: "included", priced: false } },
        "cloud-prices",
      ),
    ).toBe("info");
  });

  test("a policy that only reports is information, one that is off is a to-do", () => {
    expect(
      stateOf(
        { ...ready, contentSecurityPolicy: "report-only" },
        "content-security-policy",
      ),
    ).toBe("info");
    expect(
      stateOf(
        { ...ready, contentSecurityPolicy: "off" },
        "content-security-policy",
      ),
    ).toBe("todo");
  });

  test("a plain-HTTP or missing address is a to-do", () => {
    expect(
      stateOf({ ...ready, appUrl: "http://app.example.com" }, "https"),
    ).toBe("todo");
    expect(stateOf({ ...ready, appUrl: undefined }, "https")).toBe("todo");
  });

  test("an unfinished key rotation is a to-do whether or not there are customers", () => {
    expect(
      stateOf(
        { ...ready, hosted: false, oldEncryptionKeys: true },
        "encryption-key",
      ),
    ).toBe("todo");
  });
});

describe("facts read from the configuration", () => {
  const auth = (extra: Record<string, unknown>) =>
    ({
      baseUrl: "https://x",
      secret: "s",
      trustedOrigins: [],
      initialAdminEmails: [],
      allowedEmailDomains: [],
      ...extra,
    }) as never;
  const tenant = "0b0d3c1e-5a52-4b5e-8f3e-0d6f2f6f9a11";

  test("one Entra tenant, or Okta, is a directory the company controls; `common` is not", () => {
    const microsoft = (tenantId: string) =>
      auth({ microsoft: { clientId: "a", clientSecret: "b", tenantId } });
    expect(staffDirectoryConfigured(microsoft(tenant))).toBe(true);
    expect(staffDirectoryConfigured(microsoft("common"))).toBe(false);
    expect(staffDirectoryConfigured(microsoft("organizations"))).toBe(false);
    expect(
      staffDirectoryConfigured(
        auth({
          okta: { clientId: "a", clientSecret: "b", issuer: "https://o" },
        }),
      ),
    ).toBe(true);
    expect(
      staffDirectoryConfigured(
        auth({ google: { clientId: "a", clientSecret: "b" } }),
      ),
    ).toBe(false);
    expect(staffDirectoryConfigured(undefined)).toBe(false);
  });

  test("a provider with no environment reports none, and the settings map across", () => {
    const facts = deploymentFacts({
      config: {
        cloud: { mode: "off", volumeBytes: 0, defaultCapCents: 0 },
        termsAcceptance: "off",
        auditShipping: "log",
        metricsPort: 9100,
        contentSecurityPolicy: "enforce",
        appUrl: "https://a",
        previousKeyEncryptionKeys: ["old"],
        auth: undefined,
      },
      billing: { id: "manual" } as never,
      billingMode: "subscriptions",
      cloudPriced: false,
    });
    expect(facts).toMatchObject({
      hosted: true,
      billing: { id: "manual" },
      metricsServed: true,
      oldEncryptionKeys: true,
      staffDirectory: false,
    });
    expect("environment" in facts.billing).toBe(false);
  });
});

describe("what needs attention", () => {
  const quiet: OverviewCounts = {
    accounts: { total: 3, suspended: 0, newLast7Days: 0, newLast30Days: 0 },
    subscriptions: [],
    people: { total: 3, newLast7Days: 0 },
    running: { runs: 0, accounts: 0 },
    work: { waiting: 0, gaveUp: 0 },
    marketplace: { pendingListings: 0, openReports: 0 },
    charges: { uncertain: 0, stuck: 0 },
  };

  test("a quiet service has nothing to look at", () => {
    expect(attentionFrom(quiet, 0)).toEqual([]);
  });

  test("things waiting on a decision come before things to watch, each pointing at its screen", () => {
    const items = attentionFrom(
      {
        ...quiet,
        accounts: { ...quiet.accounts, suspended: 1 },
        marketplace: { pendingListings: 2, openReports: 1 },
        charges: { uncertain: 1, stuck: 0 },
        work: { waiting: 4, gaveUp: 1 },
      },
      3,
    );
    expect(items.map((item) => item.id)).toEqual([
      "charges-uncertain",
      "marketplace-review",
      "marketplace-reports",
      "work-gave-up",
      "accounts-past-due",
      "accounts-suspended",
    ]);
    expect(items.map((item) => item.severity)).toEqual([
      "action",
      "action",
      "action",
      "action",
      "watch",
      "watch",
    ]);
    expect(items.find((item) => item.id === "charges-uncertain")?.to).toBe(
      "/admin/cloud",
    );
    expect(items.find((item) => item.id === "work-gave-up")?.to).toBe(null);
  });

  test("the wording agrees with the number", () => {
    const one = attentionFrom(
      { ...quiet, marketplace: { pendingListings: 1, openReports: 0 } },
      0,
    );
    expect(one[0]?.detail).toContain("1 listing is");
    const many = attentionFrom(
      { ...quiet, marketplace: { pendingListings: 3, openReports: 0 } },
      0,
    );
    expect(many[0]?.detail).toContain("3 listings are");
  });
});
