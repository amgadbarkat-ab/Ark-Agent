import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@ag-ui/client";
import { eq } from "drizzle-orm";
import { Observable, type Subscriber } from "rxjs";
import { RunGateAgent } from "../src/accounts/run-gate";
import { createRequestAgents } from "../src/copilot";
import { createRunSlots } from "../src/accounts/run-slots";
import { createAccountStore } from "../src/accounts/store";
import { createDatabase } from "../src/db/client";
import { runSlots, tenantMemberships, tenants, users } from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const accounts = createAccountStore(database, { billingMode: "subscriptions" });
const slots = createRunSlots(database);
const made: string[] = [];

async function person(plan: "agent" | "team" | "internal" | null = "agent") {
  const id = `gate-${randomUUID()}`;
  await database.insert(users).values({ id, email: `${id}@example.com` });
  made.push(id);
  const tenantId = await accounts.ensureTenant(id);
  if (plan)
    await accounts.applySubscription(tenantId, {
      planId: plan,
      status: "active",
    });
  return { id, tenantId };
}

afterEach(async () => {
  for (const id of made.splice(0)) {
    const rows = await database
      .select({ tenantId: tenantMemberships.tenantId })
      .from(tenantMemberships)
      .where(eq(tenantMemberships.userId, id));
    await database.delete(users).where(eq(users.id, id));
    for (const row of rows)
      await database.delete(tenants).where(eq(tenants.id, row.tenantId));
  }
});
afterAll(async () => {
  await database.$client.close();
});

/** A coworker whose run stays open until the test lets it finish. */
class FakeBot extends AbstractAgent {
  runs: Array<{ subscriber: Subscriber<BaseEvent>; input: RunAgentInput }> = [];
  constructor(id: string) {
    super({ agentId: id, description: id });
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      this.runs.push({ subscriber, input });
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);
    });
  }
  // The runtime clones before every run, and the base clone carries only its own fields.
  clone(): FakeBot {
    const cloned = super.clone() as FakeBot;
    cloned.runs = this.runs;
    return cloned;
  }
  finishAll() {
    for (const { subscriber, input } of this.runs.splice(0)) {
      subscriber.next({
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);
      subscriber.complete();
    }
  }
}

const input = (): RunAgentInput =>
  ({
    threadId: `t-${randomUUID()}`,
    runId: `r-${randomUUID()}`,
    messages: [],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  }) as RunAgentInput;

function start(
  person: { id: string },
  botId: string,
  bot: FakeBot,
  options: Partial<ConstructorParameters<typeof RunGateAgent>[2]> = {},
) {
  const gate = new RunGateAgent(
    bot,
    { actorId: person.id, botId },
    { accounts, slots, pollMs: 20, heartbeatMs: 40, ...options },
  );
  const events: BaseEvent[] = [];
  const done: { error?: Error; complete: boolean } = { complete: false };
  const subscription = gate.run(input()).subscribe({
    next: (event) => events.push(event),
    error: (error) => {
      done.error = error;
    },
    complete: () => {
      done.complete = true;
    },
  });
  return { events, done, subscription };
}

const until = async (check: () => boolean | Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("timed out waiting");
};

/** What a person reads once every link to the plan page is taken out, as a store app does. */
const withoutPurchaseLinks = (message: string) =>
  message.replace(/\s*\[[^\]]*\]\(\/settings\/plan[^)]*\)/g, "");

const text = (events: BaseEvent[]) =>
  events
    .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
    .map((e) => (e as unknown as { delta: string }).delta)
    .join("");

describe("a run inside the plan", () => {
  test("holds a place while it works and gives it back when it ends", async () => {
    const ann = await person("agent");
    const bot = new FakeBot("analyst");
    const run = start(ann, "analyst", bot);
    await until(() => bot.runs.length === 1);
    expect(await slots.activeBots(ann.tenantId)).toBe(1);
    bot.finishAll();
    await until(() => run.done.complete);
    await until(async () => (await slots.activeBots(ann.tenantId)) === 0);
    expect(run.events.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_FINISHED,
    ]);
  });

  test("a second conversation with the same bot takes no extra place", async () => {
    const ann = await person("agent");
    const bot = new FakeBot("analyst");
    start(ann, "analyst", bot);
    start(ann, "analyst", bot);
    await until(() => bot.runs.length === 2);
    expect(await slots.activeBots(ann.tenantId)).toBe(1);
    bot.finishAll();
  });

  test("an unlimited account never waits", async () => {
    const staff = await person("internal");
    const bots = ["a", "b", "c", "d"].map((id) => new FakeBot(id));
    for (const [i, bot] of bots.entries()) start(staff, `bot-${i}`, bot);
    await until(() => bots.every((bot) => bot.runs.length === 1));
    expect(await slots.activeBots(staff.tenantId)).toBe(4);
    for (const bot of bots) bot.finishAll();
  });

  test("stopping a run gives its place back", async () => {
    const ann = await person("agent");
    const bot = new FakeBot("analyst");
    const run = start(ann, "analyst", bot);
    await until(() => bot.runs.length === 1);
    run.subscription.unsubscribe();
    await until(async () => (await slots.activeBots(ann.tenantId)) === 0);
  });

  test("a place is kept alive while the run works, past the time it would have expired", async () => {
    const ann = await person("agent");
    const shortLived = createRunSlots(database, { ttlMs: 150 });
    const bot = new FakeBot("analyst");
    const run = start(ann, "analyst", bot, {
      slots: shortLived,
      heartbeatMs: 40,
    });
    await until(() => bot.runs.length === 1);
    await new Promise((r) => setTimeout(r, 400));
    expect(await shortLived.activeBots(ann.tenantId)).toBe(1);
    run.subscription.unsubscribe();
  });
});

describe("a run at the limit", () => {
  test("waits its turn, says why and how to get more, and starts when a place frees", async () => {
    const ann = await person("agent");
    const first = new FakeBot("first");
    const second = new FakeBot("second");
    start(ann, "first", first);
    await until(() => first.runs.length === 1);

    const waiting = start(ann, "second", second);
    await until(() => text(waiting.events).length > 0);
    expect(second.runs).toHaveLength(0);
    expect(waiting.events[0]?.type).toBe(EventType.RUN_STARTED);
    expect(
      waiting.events.some(
        (e) =>
          e.type === EventType.CUSTOM &&
          (e as unknown as { name: string }).name === "ark.queued",
      ),
    ).toBe(true);
    const notice = text(waiting.events);
    expect(notice).toContain(
      "Ark Agent lets 1 digital employee work at the same time",
    );
    expect(notice).toContain("upgrade to Ark Team");
    expect(notice).toContain("](/settings/plan)");
    // The offer is one whole link, so a store app that may not show a way to buy can leave it out and
    // be left with the rest of the message, whole.
    const withoutOffer = withoutPurchaseLinks(notice);
    expect(withoutOffer).not.toContain("upgrade");
    expect(withoutOffer).not.toContain("€");
    expect(withoutOffer.endsWith("I'll start as soon as one finishes.")).toBe(
      true,
    );
    expect(notice).toContain("€100");

    first.finishAll();
    await until(() => second.runs.length === 1);
    // Exactly one RUN_STARTED reaches the conversation, though two agents tried to send one.
    expect(
      waiting.events.filter((e) => e.type === EventType.RUN_STARTED),
    ).toHaveLength(1);
    second.finishAll();
    await until(() => waiting.done.complete);
    expect(waiting.done.error).toBeUndefined();
  });

  test("gives up after the wait, ending the run cleanly with a way forward", async () => {
    const ann = await person("agent");
    const first = new FakeBot("first");
    const second = new FakeBot("second");
    start(ann, "first", first);
    await until(() => first.runs.length === 1);
    const waiting = start(ann, "second", second, { queueTimeoutMs: 120 });
    await until(() => waiting.done.complete);
    expect(second.runs).toHaveLength(0);
    expect(text(waiting.events)).toContain("Still waiting for a free place");
    const withoutOffer = withoutPurchaseLinks(text(waiting.events));
    expect(withoutOffer).not.toContain("upgrade");
    expect(
      withoutOffer.endsWith(
        "Try again when another digital employee has finished.",
      ),
    ).toBe(true);
    expect(waiting.events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    expect(await slots.activeBots(ann.tenantId)).toBe(1);
    first.finishAll();
  });

  test("a waiting run that is stopped never starts and takes nothing", async () => {
    const ann = await person("agent");
    const first = new FakeBot("first");
    const second = new FakeBot("second");
    start(ann, "first", first);
    await until(() => first.runs.length === 1);
    const waiting = start(ann, "second", second);
    await until(() => text(waiting.events).length > 0);
    waiting.subscription.unsubscribe();
    first.finishAll();
    await new Promise((r) => setTimeout(r, 150));
    expect(second.runs).toHaveLength(0);
    expect(await slots.activeBots(ann.tenantId)).toBe(0);
  });

  test("one account's limit never holds up another's", async () => {
    const ann = await person("agent");
    const bob = await person("agent");
    const a = new FakeBot("a");
    const b = new FakeBot("b");
    start(ann, "a", a);
    start(bob, "b", b);
    await until(() => a.runs.length === 1 && b.runs.length === 1);
    a.finishAll();
    b.finishAll();
  });

  test("a run that crashed without letting go stops counting once its lease runs out", async () => {
    const ann = await person("agent");
    const crashed = createRunSlots(database, { ttlMs: 100 });
    await crashed.tryAcquire({
      tenantId: ann.tenantId,
      userId: ann.id,
      botId: "ghost",
      runId: "never-released",
      limit: 1,
    });
    expect(await slots.activeBots(ann.tenantId)).toBe(1);
    await new Promise((r) => setTimeout(r, 200));
    expect(await slots.activeBots(ann.tenantId)).toBe(0);
    const bot = new FakeBot("real");
    start(ann, "real", bot);
    await until(() => bot.runs.length === 1);
    bot.finishAll();
  });
});

describe("an account that may not run", () => {
  test("is refused with the reason, and takes no place", async () => {
    const ann = await person("agent");
    await accounts.suspend(ann.tenantId, "chargeback");
    const bot = new FakeBot("analyst");
    const run = start(ann, "analyst", bot);
    await until(() => run.done.error !== undefined);
    expect(run.done.error?.message).toContain("suspended: chargeback");
    expect(bot.runs).toHaveLength(0);
    expect(
      await database
        .select()
        .from(runSlots)
        .where(eq(runSlots.tenantId, ann.tenantId)),
    ).toHaveLength(0);
  });

  test("with no plan chosen is told to choose one", async () => {
    const nobody = await person(null);
    const run = start(nobody, "analyst", new FakeBot("analyst"));
    await until(() => run.done.error !== undefined);
    expect(run.done.error?.message).toMatch(/choose a plan/i);
  });
});

describe("the wrapper", () => {
  test("survives the clone the runtime makes before every run", async () => {
    const ann = await person("agent");
    const bot = new FakeBot("analyst");
    const gate = new RunGateAgent(
      bot,
      { actorId: ann.id, botId: "analyst" },
      { accounts, slots, pollMs: 20 },
    );
    const events: BaseEvent[] = [];
    gate
      .clone()
      .run(input())
      .subscribe((event) => events.push(event));
    await until(() => bot.runs.length === 1 || events.length > 0);
    expect(await slots.activeBots(ann.tenantId)).toBe(1);
    bot.finishAll();
  });
});

describe("where the gate is applied", () => {
  test("every Bot the request path builds is behind it, and a suspended account is refused before any network call", async () => {
    const ann = await person("agent");
    await accounts.suspend(ann.tenantId, "chargeback");
    // Every positional collaborator absent except the four it needs and the gate itself.
    const args: unknown[] = new Array(createRequestAgents.length).fill(
      undefined,
    );
    args[0] = async () => ({ id: ann.id, role: "user" as const });
    args[1] = async () => [
      {
        id: "expense",
        name: "Expense",
        type: "remote_ag_ui" as const,
        endpoint: "http://127.0.0.1:9/never-contacted",
        standingMessage: {
          id: "s",
          role: "system",
          content: "Review receipts.",
        },
      },
    ];
    args[2] = { provider: "openai", defaultModel: "m" };
    args[3] = async () => null;
    args[args.length - 1] =
      (actor: { id: string }) => (botId: string, agent: AbstractAgent) =>
        new RunGateAgent(
          agent,
          { actorId: actor.id, botId },
          { accounts, slots },
        );
    const factory = (
      createRequestAgents as (
        ...a: unknown[]
      ) => (c: { request: Request }) => Promise<Record<string, AbstractAgent>>
    )(...args);

    const built = await factory({
      request: new Request("http://ark.test/api/copilotkit"),
    });
    expect(built.expense).toBeInstanceOf(RunGateAgent);

    const failure = await new Promise<Error | undefined>((resolve) =>
      built.expense?.run(input()).subscribe({
        error: (error) => resolve(error as Error),
        complete: () => resolve(undefined),
      }),
    );
    expect(failure?.message).toContain("suspended: chargeback");
  });
});
