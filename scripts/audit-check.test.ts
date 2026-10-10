import { describe, expect, test } from "bun:test";
import {
  type Advisory,
  type AllowEntry,
  allowlistProblems,
  type AuditReport,
  advisoryId,
  evaluate,
} from "./audit-check";

const advisory = (
  ghsa: string,
  severity: string,
  title = "Something is wrong",
): Advisory => ({
  id: 1,
  url: `https://github.com/advisories/${ghsa}`,
  title,
  severity,
});

const TODAY = "2026-10-08";
const REASON = "Reached only by build tooling, never by customer input.";

describe("the dependency audit gate", () => {
  test("an advisory is named by its GHSA id", () => {
    expect(advisoryId(advisory("GHSA-aaaa-bbbb-cccc", "high"))).toBe(
      "GHSA-aaaa-bbbb-cccc",
    );
  });

  test("a high advisory that nobody has looked at fails", () => {
    const report: AuditReport = {
      left: [advisory("GHSA-1111-2222-3333", "high")],
    };
    const verdict = evaluate(report, [], { level: "high", today: TODAY });
    expect(verdict.failing.map((f) => f.advisory)).toEqual([
      "GHSA-1111-2222-3333",
    ]);
  });

  test("lower severities are counted and never fail", () => {
    const report: AuditReport = {
      a: [advisory("GHSA-1", "low"), advisory("GHSA-2", "moderate")],
    };
    const verdict = evaluate(report, [], { level: "high", today: TODAY });
    expect(verdict.failing).toEqual([]);
    expect(verdict.belowLevel).toBe(2);
  });

  test("at critical level a high advisory is not judged", () => {
    const report: AuditReport = { a: [advisory("GHSA-1", "high")] };
    expect(
      evaluate(report, [], { level: "critical", today: TODAY }).failing,
    ).toEqual([]);
    expect(
      evaluate({ a: [advisory("GHSA-2", "critical")] }, [], {
        level: "critical",
        today: TODAY,
      }).failing,
    ).toHaveLength(1);
  });

  test("a live decision lets it through, and says why", () => {
    const allow: AllowEntry[] = [
      {
        advisory: "GHSA-1",
        package: "a",
        reason: REASON,
        expires: "2026-12-01",
      },
    ];
    const verdict = evaluate({ a: [advisory("GHSA-1", "high")] }, allow, {
      level: "high",
      today: TODAY,
    });
    expect(verdict.failing).toEqual([]);
    expect(verdict.allowed[0]).toMatchObject({ reason: REASON });
  });

  test("a decision whose date has passed fails again, and is shown as expired", () => {
    const allow: AllowEntry[] = [
      {
        advisory: "GHSA-1",
        package: "a",
        reason: REASON,
        expires: "2026-10-07",
      },
    ];
    const verdict = evaluate({ a: [advisory("GHSA-1", "high")] }, allow, {
      level: "high",
      today: TODAY,
    });
    expect(verdict.failing).toHaveLength(1);
    expect(verdict.expired).toHaveLength(1);
  });

  test("a decision about one package does not cover the same advisory in another, nor another advisory in it", () => {
    const allow: AllowEntry[] = [
      {
        advisory: "GHSA-1",
        package: "a",
        reason: REASON,
        expires: "2026-12-01",
      },
    ];
    const verdict = evaluate(
      {
        a: [advisory("GHSA-2", "high")],
        b: [advisory("GHSA-1", "high")],
      },
      allow,
      { level: "high", today: TODAY },
    );
    expect(verdict.failing.map((f) => `${f.package}:${f.advisory}`)).toEqual([
      "a:GHSA-2",
      "b:GHSA-1",
    ]);
  });

  test("a decision about something that is gone is reported as stale", () => {
    const allow: AllowEntry[] = [
      {
        advisory: "GHSA-9",
        package: "z",
        reason: REASON,
        expires: "2026-12-01",
      },
    ];
    const verdict = evaluate({}, allow, { level: "high", today: TODAY });
    expect(verdict.stale).toEqual(allow);
    expect(verdict.failing).toEqual([]);
  });

  test("a decision without a reason, a date, or a reasonable date is not a decision", () => {
    const bad: AllowEntry[] = [
      { advisory: "GHSA-1", package: "a", reason: "ok", expires: "2026-12-01" },
      { advisory: "GHSA-2", package: "a", reason: REASON, expires: "someday" },
      {
        advisory: "GHSA-3",
        package: "a",
        reason: REASON,
        expires: "2030-01-01",
      },
      {
        advisory: "GHSA-3",
        package: "a",
        reason: REASON,
        expires: "2026-12-01",
      },
    ];
    const problems = allowlistProblems(bad, TODAY);
    expect(problems.join("\n")).toContain("a GHSA-1 has no real reason");
    expect(problems.join("\n")).toContain("a GHSA-2 has no expiry date");
    expect(problems.join("\n")).toContain(
      "a GHSA-3 expires more than 200 days",
    );
    expect(problems.join("\n")).toContain("a GHSA-3 is listed twice");
    expect(
      allowlistProblems(
        [
          {
            advisory: "G",
            package: "a",
            reason: REASON,
            expires: "2026-12-01",
          },
        ],
        TODAY,
      ),
    ).toEqual([]);
  });

  test("the allow-list in the repository is itself well formed", async () => {
    const file = (await Bun.file("security/audit-allowlist.json").json()) as {
      allow: AllowEntry[];
    };
    expect(allowlistProblems(file.allow, TODAY)).toEqual([]);
  });
});
