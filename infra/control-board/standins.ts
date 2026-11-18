/**
 * Made-up data for the tests and for running the board locally (`bun dev.ts`). Every customer id
 * is invented (demo-…); nothing here is a real customer.
 */
import type {
  CheckinExport,
  CheckinSource,
  HealthSource,
  IssueSource,
  Sources,
  WorkItem,
} from "./sources";
import type { BillingSnapshot, BillingSource } from "./stripe";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export function demoExport(now: number): CheckinExport {
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const ahead = (ms: number) => new Date(now + ms).toISOString();
  return {
    v: 1,
    generatedAt: new Date(now).toISOString(),
    installs: [
      {
        customerId: "demo-bakery",
        installId: "aaaa1111-0000-4000-8000-000000000001",
        version: "0.1.48",
        status: "trial",
        daysLeft: 20,
        endsAt: ahead(20 * DAY),
        employees: 3,
        verified: true,
        firstSeen: ago(10 * DAY),
        lastSeen: ago(1 * HOUR),
        checkins: 10,
        people: 4,
        activePeople7d: 3,
        conversations7d: 27,
        phoneLine: false,
        os: "windows",
      },
      {
        customerId: "demo-clinic",
        installId: "bbbb2222-0000-4000-8000-000000000002",
        version: "0.1.47",
        status: "trial",
        daysLeft: 5,
        endsAt: ahead(5 * DAY),
        employees: 6,
        verified: true,
        firstSeen: ago(25 * DAY),
        lastSeen: ago(3 * HOUR),
        checkins: 25,
      },
      {
        customerId: "demo-clinic",
        installId: "bbbb3333-0000-4000-8000-000000000003",
        version: "0.1.45",
        status: "trial",
        daysLeft: 8,
        endsAt: ahead(8 * DAY),
        employees: 6,
        verified: false,
        firstSeen: ago(22 * DAY),
        lastSeen: ago(3 * DAY),
        checkins: 18,
      },
      {
        customerId: "demo-shop",
        installId: "cccc4444-0000-4000-8000-000000000004",
        version: "0.1.48",
        status: "paid",
        daysLeft: 0,
        endsAt: null,
        employees: null,
        verified: true,
        firstSeen: ago(60 * DAY),
        lastSeen: ago(2 * HOUR),
        checkins: 58,
      },
      {
        customerId: "demo-garage",
        installId: "dddd5555-0000-4000-8000-000000000005",
        version: "0.1.40",
        status: "ended",
        daysLeft: 0,
        endsAt: ago(9 * DAY),
        employees: 2,
        verified: true,
        firstSeen: ago(40 * DAY),
        lastSeen: ago(10 * DAY),
        checkins: 30,
      },
      {
        customerId: "demo-taverna",
        installId: "eeee6666-0000-4000-8000-000000000006",
        version: "0.1.48",
        status: "trial",
        daysLeft: 2,
        endsAt: ahead(2 * DAY),
        employees: 4,
        verified: true,
        firstSeen: ago(28 * DAY),
        lastSeen: ago(5 * HOUR),
        checkins: 27,
      },
    ],
    licences: [
      {
        customerId: "demo-shop",
        plan: "team",
        seats: 1,
        addons: ["phone"],
        status: "active",
        periodEnd: ahead(20 * DAY),
        validUntil: ahead(27 * DAY),
        updatedAt: ago(10 * DAY),
      },
      {
        customerId: "demo-taverna",
        plan: "team",
        seats: 2,
        addons: ["phone"],
        status: "active",
        periodEnd: ahead(25 * DAY),
        validUntil: ahead(32 * DAY),
        updatedAt: ago(5 * DAY),
      },
    ],
    phone: [
      {
        customerId: "demo-shop",
        balanceMils: 23400,
        state: "ok",
        autoTopup: false,
        updatedAt: ago(1 * DAY),
      },
      {
        customerId: "demo-taverna",
        balanceMils: 5000,
        state: "low",
        autoTopup: true,
        updatedAt: ago(4 * HOUR),
      },
    ],
    ledger: [
      {
        customerId: "demo-shop",
        kind: "block",
        minutes: 300,
        mils: 23400,
        writtenOffMils: 0,
        at: ago(10 * DAY),
      },
      {
        customerId: "demo-taverna",
        kind: "incoming",
        minutes: 3,
        mils: -234,
        writtenOffMils: 0,
        at: ago(4 * HOUR),
      },
      {
        customerId: "demo-taverna",
        kind: "mobile",
        minutes: 2,
        mils: -200,
        writtenOffMils: 78,
        at: ago(4 * HOUR + 60_000),
      },
    ],
  };
}

export function demoIssues(now: number): WorkItem[] {
  const ago = (ms: number) => new Date(now - ms).toISOString();
  return [
    {
      number: 149,
      title: "ArkAgent Control Board",
      kind: "issue",
      state: "open",
      labels: ["board"],
      url: "https://github.example/demo/issues/149",
      updatedAt: ago(2 * HOUR),
    },
    {
      number: 150,
      title: "Phone relay: <script>alert(1)</script> in a title",
      kind: "pr",
      state: "merged",
      labels: ["phone", "fix"],
      url: "https://github.example/demo/pull/150",
      updatedAt: ago(1 * DAY),
    },
    {
      number: 151,
      title: "Greek date on the key page",
      kind: "issue",
      state: "closed",
      labels: [],
      url: "https://github.example/demo/issues/151",
      updatedAt: ago(3 * DAY),
    },
  ];
}

/** What the read-only Stripe source would return, made up. */
export function demoBilling(now: number): BillingSnapshot {
  const ahead = (ms: number) => new Date(now + ms).toISOString();
  const ago = (ms: number) => new Date(now - ms).toISOString();
  return {
    subscriptions: [
      {
        id: "sub_demo_shop",
        customerId: "demo-shop",
        status: "active",
        cancelAtPeriodEnd: false,
        currentPeriodEnd: ahead(20 * DAY),
        amountCents: 4900,
        currency: "EUR",
        interval: "month",
      },
      {
        id: "sub_demo_taverna",
        customerId: "demo-taverna",
        status: "past_due",
        cancelAtPeriodEnd: false,
        currentPeriodEnd: ahead(25 * DAY),
        amountCents: 9800,
        currency: "EUR",
        interval: "month",
      },
      {
        id: "sub_demo_old",
        customerId: "stripe-cus_DEMO1",
        status: "active",
        cancelAtPeriodEnd: true,
        currentPeriodEnd: ahead(3 * DAY),
        amountCents: 4900,
        currency: "EUR",
        interval: "month",
      },
    ],
    failed: [
      {
        invoiceId: "in_demo_1",
        customerId: "demo-taverna",
        amountDueCents: 9800,
        currency: "EUR",
        attempts: 2,
        nextAttempt: ahead(2 * DAY),
        at: ago(3 * DAY),
      },
    ],
  };
}

export type StandIns = Sources & {
  /** Switches for the tests: make a source fail, or answer again. */
  checkinsDown: boolean;
  relayDown: boolean;
  githubConnected: boolean;
  /** Off by default, as on a board with no Stripe key yet. */
  stripeConnected: boolean;
  checkinCalls: number;
};

export function standIns(now: () => number): StandIns {
  const state = {
    checkinsDown: false,
    relayDown: false,
    githubConnected: true,
    stripeConnected: false,
    checkinCalls: 0,
  };
  const checkins: CheckinSource = {
    async load() {
      state.checkinCalls += 1;
      if (state.checkinsDown)
        throw new Error("The check-in export answered 503.");
      return demoExport(now());
    },
  };
  const relay: HealthSource = {
    async check() {
      return state.relayDown
        ? { up: false, detail: "unreachable" }
        : { up: true, detail: "ok", ms: 12 };
    },
  };
  const issues: IssueSource = {
    async list() {
      return state.githubConnected ? demoIssues(now()) : null;
    },
  };
  const billing: BillingSource = {
    async snapshot() {
      return state.stripeConnected ? demoBilling(now()) : null;
    },
    async health() {
      return state.stripeConnected
        ? { up: true, detail: "ok", ms: 40 }
        : { up: null, detail: "not connected" };
    },
  };
  return Object.assign(state, { checkins, relay, issues, billing });
}
