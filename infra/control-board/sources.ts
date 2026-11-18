/**
 * Where the board's data comes from. Each source is an interface with one real implementation and
 * a stand-in in the tests. The board holds none of this data itself: it asks, keeps the answer in
 * memory for a minute, and shows it.
 *
 *  - check-ins, licences and phone balances: blackark.uk/checkin/export/ (signed both ways);
 *  - the phone relay: its public GET /health;
 *  - GitHub issues and PRs: the REST API, only once a read-only token is given;
 *  - Stripe: an interface only, until a restricted read-only key is given.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { BillingSource } from "./stripe";

export type InstallStatus = "trial" | "ended" | "paid";

export type Install = {
  customerId: string;
  installId: string;
  version: string;
  status: InstallStatus;
  daysLeft: number;
  endsAt: string | null;
  employees: number | null;
  verified: boolean;
  firstSeen: string;
  lastSeen: string;
  checkins: number;
  /** Counts from v0.1.49 (never a name): absent or null for older installs. */
  people?: number | null;
  activePeople7d?: number | null;
  conversations7d?: number | null;
  phoneLine?: boolean | null;
  os?: "windows" | "macos" | "linux" | null;
};

export type Licence = {
  customerId: string | null;
  plan: string | null;
  seats: number | null;
  addons: string[];
  status: string;
  periodEnd: string | null;
  validUntil: string | null;
  updatedAt: string;
};

export type PhoneAccount = {
  customerId: string;
  balanceMils: number;
  state: "ok" | "low" | "empty";
  autoTopup: boolean;
  updatedAt: string;
};

export type LedgerEntry = {
  customerId: string;
  kind: string;
  minutes: number;
  mils: number;
  writtenOffMils: number;
  at: string;
};

export type CheckinExport = {
  v: 1;
  generatedAt: string;
  installs: Install[];
  licences: Licence[];
  phone: PhoneAccount[];
  ledger: LedgerEntry[];
};

export interface CheckinSource {
  /** The whole export. Throws when the service cannot be reached or its answer is not signed. */
  load(): Promise<CheckinExport>;
}

export type Health = {
  /** True: up. False: down. Null: not connected yet (no key or token given). */
  up: boolean | null;
  detail: string;
  ms?: number;
};

export interface HealthSource {
  check(): Promise<Health>;
}

export type WorkItem = {
  number: number;
  title: string;
  kind: "issue" | "pr";
  state: "open" | "closed" | "merged";
  labels: string[];
  url: string;
  updatedAt: string;
};

export interface IssueSource {
  /** Null: not connected (no token yet). */
  list(): Promise<WorkItem[] | null>;
}

/** Stripe, read-only: stripe.ts. */
export type { BillingSource } from "./stripe";

export type Sources = {
  checkins: CheckinSource;
  /** The check-in service's own health is whether the export answers. */
  relay: HealthSource;
  issues: IssueSource;
  billing: BillingSource;
};

// ---- Check-ins: blackark.uk/checkin/export/ ------------------------------------------------------

export function signExport(
  secret: string,
  time: string,
  nonce: string,
  body: string,
): string {
  return createHmac("sha256", secret)
    .update(`${time}.${nonce}.${body}`)
    .digest("hex");
}

function sameHex(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function checkinExport(options: {
  url: string;
  secret: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}): CheckinSource {
  const send = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  return {
    async load() {
      const body = JSON.stringify({ want: "export" });
      const time = String(Math.floor(now() / 1000));
      const nonce = randomBytes(18).toString("base64url");
      const response = await send(options.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ark-time": time,
          "x-ark-nonce": nonce,
          "x-ark-signature": signExport(options.secret, time, nonce, body),
        },
        body,
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
      if (!response.ok)
        throw new Error(`The check-in export answered ${response.status}.`);
      const text = await response.text();
      const answeredAt = response.headers.get("x-ark-time") ?? "";
      const signature = response.headers.get("x-ark-signature") ?? "";
      if (
        !/^\d{1,12}$/.test(answeredAt) ||
        Math.abs(Number(answeredAt) - now() / 1000) > 300 ||
        !sameHex(signExport(options.secret, answeredAt, nonce, text), signature)
      ) {
        throw new Error("The check-in export's answer is not signed for us.");
      }
      const data = JSON.parse(text) as CheckinExport;
      if (data.v !== 1 || !Array.isArray(data.installs))
        throw new Error("The check-in export's answer is not version 1.");
      return data;
    },
  };
}

// ---- The phone relay: GET /health --------------------------------------------------------------

export function relayHealth(options: {
  url: string;
  fetch?: typeof fetch;
  now?: () => number;
}): HealthSource {
  const send = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  return {
    async check() {
      const started = now();
      try {
        const response = await send(options.url, {
          signal: AbortSignal.timeout(5_000),
        });
        const text = (await response.text()).trim();
        const ms = now() - started;
        return response.ok && text === "ok"
          ? { up: true, detail: "ok", ms }
          : { up: false, detail: `HTTP ${response.status}`, ms };
      } catch (error) {
        return {
          up: false,
          detail: error instanceof Error ? error.name : "unreachable",
        };
      }
    },
  };
}

// ---- GitHub issues and PRs ---------------------------------------------------------------------

type GitHubIssue = {
  number: number;
  title: string;
  state: "open" | "closed";
  html_url: string;
  updated_at: string;
  labels: Array<{ name?: string } | string>;
  pull_request?: { merged_at?: string | null };
};

/**
 * GitHub's REST API with a fine-grained, read-only token (Issues: read, Pull requests: read, on
 * this one repository). Without a token it is "not connected" and sends nothing.
 */
export function githubIssues(options: {
  repo: string;
  token?: string;
  fetch?: typeof fetch;
  apiBase?: string;
}): IssueSource {
  const send = options.fetch ?? fetch;
  const base = options.apiBase ?? "https://api.github.com";
  return {
    async list() {
      if (!options.token) return null;
      const response = await send(
        `${base}/repos/${options.repo}/issues?state=all&per_page=100&sort=updated`,
        {
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${options.token}`,
            "x-github-api-version": "2022-11-28",
            "user-agent": "blackark-control-board",
          },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) throw new Error(`GitHub answered ${response.status}.`);
      const items = (await response.json()) as GitHubIssue[];
      return items.map((item) => ({
        number: item.number,
        title: item.title,
        kind: item.pull_request ? "pr" : "issue",
        state:
          item.pull_request?.merged_at != null
            ? "merged"
            : item.state === "open"
              ? "open"
              : "closed",
        labels: item.labels
          .map((label) => (typeof label === "string" ? label : label.name))
          .filter((name): name is string => !!name),
        url: item.html_url,
        updatedAt: item.updated_at,
      }));
    },
  };
}

// ---- A minute's memory -------------------------------------------------------------------------

/**
 * Keeps a source's last answer for `ttlMs`, and the last good answer when a later call fails, so a
 * page still shows something, marked with when it was fetched and the error. One request at a time.
 */
export function remembered<T>(
  load: () => Promise<T>,
  ttlMs: number,
  now: () => number = Date.now,
): () => Promise<{
  value: T | null;
  fetchedAt: number | null;
  error?: string;
}> {
  let last: { value: T; at: number } | null = null;
  let lastError: { message: string; at: number } | null = null;
  let running: Promise<void> | null = null;
  return async () => {
    const fresh = (at: number | undefined) =>
      at !== undefined && now() - at < ttlMs;
    if (!fresh(last?.at) && !fresh(lastError?.at)) {
      running ??= load()
        .then((value) => {
          last = { value, at: now() };
          lastError = null;
        })
        .catch((error: unknown) => {
          lastError = {
            message: error instanceof Error ? error.message : String(error),
            at: now(),
          };
        })
        .finally(() => {
          running = null;
        });
      await running;
    }
    const kept = last as { value: T; at: number } | null;
    const failed = lastError as { message: string; at: number } | null;
    return {
      value: kept?.value ?? null,
      fetchedAt: kept?.at ?? null,
      ...(failed ? { error: failed.message } : {}),
    };
  };
}
