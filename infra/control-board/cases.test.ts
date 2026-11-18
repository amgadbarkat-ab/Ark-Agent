import { afterEach, describe, expect, test } from "bun:test";
import { readAudit } from "./audit";
import { casesExtension } from "./cases";
import { Browser, testBoard } from "./test-helpers";

const PASSWORD = "correct horse battery";
let current: ReturnType<typeof testBoard> | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

async function signedIn(
  role: "owner" | "admin" | "support" | "read-only" = "support",
) {
  const t = testBoard((db) => [
    casesExtension(db, { githubRepo: "example/repo" }),
  ]);
  current = t;
  await t.addAccount("maria", role);
  const browser = t.browser();
  await browser.signIn("maria", PASSWORD, t.code("maria"));
  return { t, browser };
}

async function openOne(browser: Browser, fields: Record<string, string> = {}) {
  const form = await browser.get("/cases/new?customer=demo-clinic");
  return browser.post("/cases", {
    csrf: Browser.csrfFrom(form.text),
    customer: "demo-clinic",
    subject: "The line does not answer after 18:00",
    channel: "phone",
    language: "el",
    priority: "high",
    owner: "maria",
    github: "",
    note: "Called at 18:05, busy tone.",
    ...fields,
  });
}

function fact(page: string, label: string): string {
  const match = page.match(
    new RegExp(`<dt>${label}</dt><dd>([\\s\\S]*?)</dd>`),
  );
  return (match?.[1] ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

describe("support cases", () => {
  test("support opens a case: number, customer, channel, language, priority, owner, SLA due, note", async () => {
    const { t, browser } = await signedIn();
    const made = await openOne(browser);
    expect(made.status).toBe(303);
    expect(made.location).toBe("/cases/1");
    const page = (await browser.get("/cases/1")).text;
    expect(page).toContain(
      "<h1>Case #1: The line does not answer after 18:00</h1>",
    );
    expect(fact(page, "Customer")).toBe("demo-clinic");
    expect(fact(page, "Channel")).toBe("Phone");
    expect(fact(page, "Language")).toBe("Greek");
    expect(fact(page, "Priority")).toBe("high");
    expect(fact(page, "Status")).toBe("new");
    expect(fact(page, "Assigned to")).toBe("maria");
    // high: 24 hours from 18/11/2026 12:00 Athens.
    expect(fact(page, "Due by")).toBe("19/11/2026 12:00");
    expect(page).toContain("Called at 18:05, busy tone.");
    expect(
      readAudit(t.db, 5, 0).map(
        (row) => `${row.action} ${row.target} ${row.detail ?? ""}`,
      ),
    ).toContain("case.create case:1 customer demo-clinic, high");
  });

  test("the list shows open cases, marks a case past its SLA overdue, and links the customer", async () => {
    const { t, browser } = await signedIn();
    await openOne(browser);
    await openOne(browser, { subject: "Low one", priority: "low" });
    t.clock.now += 25 * 3_600_000;
    await browser.get("/login");
    await browser.signIn("maria", PASSWORD, t.code("maria"));
    const list = (await browser.get("/cases")).text;
    const rows = [
      ...list.matchAll(/<tr><td><a href="\/cases\/(\d+)">[\s\S]*?<\/tr>/g),
    ].map((m) => ({ n: m[1], overdue: m[0].includes("overdue") }));
    expect(rows).toEqual([
      { n: "2", overdue: false },
      { n: "1", overdue: true },
    ]);
    expect(list).toContain('<a href="/customers/demo-clinic">demo-clinic</a>');
  });

  test("changing status, priority and owner is audited by what changed; notes are kept, their text is not in the audit log", async () => {
    const { t, browser } = await signedIn();
    await t.addAccount("nikos", "support");
    await openOne(browser);
    const page = (await browser.get("/cases/1")).text;
    const csrf = Browser.csrfFrom(page);
    const update = await browser.post("/cases/1", {
      csrf,
      action: "update",
      status: "waiting",
      priority: "urgent",
      owner: "nikos",
      github: "",
    });
    expect(update.status).toBe(303);
    const after = (await browser.get("/cases/1")).text;
    expect(fact(after, "Status")).toBe("waiting");
    expect(fact(after, "Due by")).toBe("18/11/2026 16:00");
    expect(
      readAudit(t.db, 10, 0).find((row) => row.action === "case.update")
        ?.detail,
    ).toBe("status new→waiting, priority high→urgent, owner maria→nikos");
    await browser.post("/cases/1", {
      csrf,
      action: "note",
      body: "Customer's router restarts at 18:00.",
    });
    expect((await browser.get("/cases/1")).text).toContain(
      "Customer&#39;s router restarts at 18:00.",
    );
    expect(JSON.stringify(readAudit(t.db, 50, 0))).not.toContain("router");
    expect(() =>
      t.db.query("UPDATE case_notes SET body = 'x'").run(),
    ).toThrow();
  });

  test("a case links to a GitHub issue", async () => {
    const { browser } = await signedIn();
    await openOne(browser, { github: "#149" });
    const page = (await browser.get("/cases/1")).text;
    expect(page).toContain(
      '<a href="https://github.com/example/repo/issues/149" rel="noreferrer">#149</a>',
    );
    const csrf = Browser.csrfFrom(page);
    await browser.post("/cases/1", {
      csrf,
      action: "update",
      status: "open",
      priority: "high",
      owner: "maria",
      github: "150",
    });
    expect((await browser.get("/cases")).text).toContain("issues/150");
    const bad = await browser.post("/cases/1", {
      csrf,
      action: "update",
      status: "open",
      priority: "high",
      owner: "maria",
      github: "abc",
    });
    expect(bad.status).toBe(400);
  });

  test("the customer's timeline shows its cases, and offers to open one", async () => {
    const { browser } = await signedIn();
    await openOne(browser);
    const page = (await browser.get("/customers/demo-clinic")).text;
    expect(page).toContain(
      '<a href="/cases/1">Case #1</a>: The line does not answer after 18:00 (new)',
    );
    expect(page).toContain('href="/cases/new?customer=demo-clinic"');
  });

  test("read-only reads cases but cannot open, change or note one", async () => {
    const { t, browser } = await signedIn("support");
    await openOne(browser);
    await t.addAccount("viewer", "read-only");
    const viewer = t.browser();
    await viewer.signIn("viewer", PASSWORD, t.code("viewer"));
    const page = await viewer.get("/cases/1");
    expect(page.status).toBe(200);
    expect(page.text).toContain(
      "Your role can read cases but not change them.",
    );
    expect(page.text).not.toContain('name="action" value="update"');
    const csrf = Browser.csrfFrom((await viewer.get("/")).text);
    expect((await viewer.get("/cases/new")).status).toBe(403);
    expect(
      (
        await viewer.post("/cases", {
          csrf,
          customer: "demo-shop",
          subject: "x",
          channel: "email",
          language: "en",
          priority: "low",
        })
      ).status,
    ).toBe(403);
    expect(
      (await viewer.post("/cases/1", { csrf, action: "note", body: "x" }))
        .status,
    ).toBe(403);
    expect(
      (
        await viewer.post("/cases/1", {
          csrf,
          action: "update",
          status: "closed",
          priority: "low",
        })
      ).status,
    ).toBe(403);
  });

  test("a case form without the CSRF token is refused", async () => {
    const { t, browser } = await signedIn();
    const forged = await browser.post("/cases", {
      customer: "demo-shop",
      subject: "x",
      channel: "email",
      language: "en",
      priority: "low",
    });
    expect(forged.status).toBe(403);
    expect(t.db.query("SELECT COUNT(*) AS n FROM cases").get()).toEqual({
      n: 0,
    });
  });

  test("a bad customer id or no subject is refused with a message; a subject is escaped", async () => {
    const { browser } = await signedIn();
    expect((await openOne(browser, { customer: "<b>x</b>" })).text).toContain(
      "That customer id is not valid.",
    );
    expect((await openOne(browser, { subject: "  " })).text).toContain(
      "Give the case a subject.",
    );
    await openOne(browser, { subject: "<img src=x onerror=alert(1)>" });
    const list = (await browser.get("/cases")).text;
    expect(list).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(list).not.toContain("<img");
  });

  test("the case pages are in Greek too", async () => {
    const { browser } = await signedIn();
    await openOne(browser);
    await browser.get("/lang?to=el&back=/cases/1");
    const page = (await browser.get("/cases/1")).text;
    expect(page).toContain("<h1>Υπόθεση #1:");
    expect(fact(page, "Κανάλι")).toBe("Τηλέφωνο");
    expect(fact(page, "Προτεραιότητα")).toBe("υψηλή");
    expect(page).toContain("Εσωτερικές σημειώσεις");
  });
});
