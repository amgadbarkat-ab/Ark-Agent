/**
 * Fail when a dependency has a serious known vulnerability that nobody has looked at.
 *
 *   bun scripts/audit-check.ts [--level high|critical] [--allowlist security/audit-allowlist.json]
 *
 * `bun audit` lists every advisory and exits non-zero if there is any, which is useless as a gate:
 * there are always some, and a gate that is always red is ignored. This reads its output and fails
 * only on an advisory of at least the chosen level (default `high`) that is NOT in the allow-list, or
 * whose allow-list entry has expired.
 *
 * An allow-list entry is a decision with a reason and a date, not a silence:
 *
 *   { "advisory": "GHSA-vfj7-8cjw-p6xm", "package": "braces", "reason": "...", "expires": "2027-01-31" }
 *
 * When `expires` passes, the advisory fails the check again and somebody has to look at it and either
 * fix it or renew the decision in writing. An entry that no advisory matches any more is reported
 * (and fails with `--strict`), so the list cannot quietly fill with decisions about things that are
 * gone.
 */
import { readFileSync } from "node:fs";

export type Advisory = {
  id: number;
  url: string;
  title: string;
  severity: "low" | "moderate" | "high" | "critical" | string;
  vulnerable_versions?: string;
};

/** `bun audit --json`: advisories keyed by package name. */
export type AuditReport = Record<string, Advisory[]>;

export type AllowEntry = {
  advisory: string;
  package: string;
  reason: string;
  /** The day (YYYY-MM-DD) the decision stops holding. */
  expires: string;
};

export type Finding = {
  package: string;
  advisory: string;
  severity: string;
  title: string;
};

const RANK: Record<string, number> = {
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
};

/** The advisory's own id (GHSA-...), which is the last part of its address. */
export function advisoryId(advisory: Advisory): string {
  return advisory.url.split("/").filter(Boolean).at(-1) ?? String(advisory.id);
}

export type Verdict = {
  /** At or above the level, not allow-listed (or the allowance has expired). These fail the check. */
  failing: Finding[];
  /** At or above the level, covered by a live decision. */
  allowed: (Finding & { reason: string; expires: string })[];
  /** Covered by a decision that has expired: shown separately because the cause is the date. */
  expired: (Finding & { reason: string; expires: string })[];
  /** Entries that no advisory matches any more. */
  stale: AllowEntry[];
  /** Below the level: counted, not judged. */
  belowLevel: number;
};

export function evaluate(
  report: AuditReport,
  allowlist: readonly AllowEntry[],
  options: { level: "high" | "critical"; today: string },
): Verdict {
  const floor = RANK[options.level] ?? RANK.high ?? 3;
  const verdict: Verdict = {
    failing: [],
    allowed: [],
    expired: [],
    stale: [],
    belowLevel: 0,
  };
  const matched = new Set<AllowEntry>();
  for (const [name, advisories] of Object.entries(report)) {
    for (const advisory of advisories) {
      if ((RANK[advisory.severity] ?? 0) < floor) {
        verdict.belowLevel += 1;
        continue;
      }
      const finding: Finding = {
        package: name,
        advisory: advisoryId(advisory),
        severity: advisory.severity,
        title: advisory.title,
      };
      const entry = allowlist.find(
        (candidate) =>
          candidate.advisory === finding.advisory && candidate.package === name,
      );
      if (!entry) {
        verdict.failing.push(finding);
        continue;
      }
      matched.add(entry);
      if (entry.expires < options.today) {
        verdict.expired.push({
          ...finding,
          reason: entry.reason,
          expires: entry.expires,
        });
        verdict.failing.push(finding);
      } else {
        verdict.allowed.push({
          ...finding,
          reason: entry.reason,
          expires: entry.expires,
        });
      }
    }
  }
  verdict.stale = allowlist.filter((entry) => !matched.has(entry));
  return verdict;
}

/** The problems with an allow-list as written: a decision without a reason or a date is not one. */
export function allowlistProblems(
  allowlist: readonly AllowEntry[],
  today: string,
  maxDays = 200,
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of allowlist) {
    const label = `${entry.package} ${entry.advisory}`;
    if (!entry.advisory || !entry.package) {
      problems.push("An entry names no advisory or package.");
      continue;
    }
    if (seen.has(label)) problems.push(`${label} is listed twice.`);
    seen.add(label);
    if (!entry.reason || entry.reason.trim().length < 20) {
      problems.push(`${label} has no real reason.`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.expires)) {
      problems.push(`${label} has no expiry date (YYYY-MM-DD).`);
      continue;
    }
    // A decision that never has to be looked at again is a silence.
    const limit = new Date(`${today}T00:00:00Z`);
    limit.setUTCDate(limit.getUTCDate() + maxDays);
    if (entry.expires > limit.toISOString().slice(0, 10)) {
      problems.push(`${label} expires more than ${maxDays} days from now.`);
    }
  }
  return problems;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const level = (flag("--level") ?? "high") as "high" | "critical";
  if (level !== "high" && level !== "critical") {
    console.error("--level is high or critical.");
    process.exit(2);
  }
  const strict = args.includes("--strict");
  const allowFile = flag("--allowlist") ?? "security/audit-allowlist.json";
  const today = new Date().toISOString().slice(0, 10);

  const allowlist = (
    JSON.parse(readFileSync(allowFile, "utf8")) as { allow: AllowEntry[] }
  ).allow;
  const problems = allowlistProblems(allowlist, today);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`allow-list: ${problem}`);
    process.exit(2);
  }

  const run = Bun.spawnSync(["bun", "audit", "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = new TextDecoder().decode(run.stdout).trim();
  let report: AuditReport;
  try {
    report = text ? (JSON.parse(text) as AuditReport) : {};
  } catch {
    console.error(
      `bun audit did not produce JSON, so nothing was checked:\n${new TextDecoder().decode(run.stderr)}`,
    );
    process.exit(2);
  }

  const verdict = evaluate(report, allowlist, { level, today });
  const line = (finding: Finding) =>
    `  ${finding.severity.padEnd(8)} ${finding.package}  ${finding.advisory}  ${finding.title}`;
  console.info(
    `${verdict.allowed.length} allowed, ${verdict.belowLevel} below ${level}, ${verdict.failing.length} failing.`,
  );
  for (const allowed of verdict.allowed) {
    console.info(`allowed until ${allowed.expires}:\n${line(allowed)}`);
  }
  for (const entry of verdict.stale) {
    console.warn(
      `stale allow-list entry (nothing matches it any more): ${entry.package} ${entry.advisory}`,
    );
  }
  if (verdict.failing.length > 0) {
    console.error(
      `\nA vulnerability of ${level} or worse has no live decision:`,
    );
    for (const finding of verdict.failing) console.error(line(finding));
    for (const expired of verdict.expired) {
      console.error(
        `  (${expired.package} ${expired.advisory} was allowed until ${expired.expires}: look again, fix it or renew the reason.)`,
      );
    }
    process.exit(1);
  }
  if (strict && verdict.stale.length > 0) process.exit(1);
}

if (import.meta.main) await main();
