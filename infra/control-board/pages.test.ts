import { afterEach, describe, expect, test } from "bun:test";
import { appendAudit, readAudit } from "./audit";
import { nightly } from "./cron";
import { type TestBoard, testBoard } from "./test-helpers";

let current: TestBoard | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

async function signedIn(
  role: "owner" | "admin" | "support" | "read-only" = "support",
) {
  const t = await testBoard();
  current = t;
  await t.addAccount("maria", role);
  const browser = t.browser();
  await browser.signIn("maria", t.code("maria"));
  return { t, browser };
}

/** The number in an overview tile, by its label. */
function tile(page: string, label: string): number | null {
  const match = page.match(
    new RegExp(`<span class="n">(\\d+)</span><a href="[^"]*">${label}</a>`),
  );
  return match ? Number(match[1]) : null;
}

/** A table row's cells as text, for the row that mentions `key`. */
function row(page: string, key: string): string[] {
  const found = [...page.matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
    .map((m) => m[1] ?? "")
    .find((r) => r.includes(key));
  if (!found) return [];
  return [...found.matchAll(/<td>([\s\S]*?)<\/td>/g)].map((m) =>
    (m[1] ?? "")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

describe("Overview", () => {
  test("counts installs, customers on trial and paid, trials ending, silent installs and low balances", async () => {
    const { browser } = await signedIn();
    const page = (await browser.get("/")).text;
    expect(tile(page, "Installs")).toBe(6);
    expect(tile(page, "Customers")).toBe(5);
    expect(tile(page, "On trial")).toBe(2);
    expect(tile(page, "Paid")).toBe(2);
    expect(tile(page, "Trial ends within 7 days")).toBe(1);
    expect(tile(page, "Installs silent for 2 days")).toBe(2);
    expect(tile(page, "Phone balances low")).toBe(1);
  });

  test("counts paying Ark Team customers per tier, and meter events waiting (v0.1.49)", async () => {
    const { browser } = await signedIn();
    const page = (await browser.get("/")).text;
    // demo-shop's key names no tier, so it counts as 5; demo-taverna is on 10.
    expect(tile(page, "Ark Team, 5 per seat")).toBe(1);
    expect(tile(page, "Ark Team, 10 per seat")).toBe(1);
    expect(tile(page, "Ark Team, 20 per seat")).toBe(0);
    expect(tile(page, "Phone usage waiting for Stripe")).toBe(3);
  });

  test("shows each service up, down or not connected", async () => {
    const { t, browser } = await signedIn();
    t.sources.relayDown = true;
    await t.refresh();
    const page = (await browser.get("/")).text;
    expect(page).toContain(
      '<span class="tag ok">Up</span> Check-in service (blackark.uk)',
    );
    expect(page).toContain('<span class="tag bad">Down</span> Phone relay');
    expect(page).toContain('<span class="tag ok">Up</span> GitHub');
    expect(page).toContain(
      '<span class="tag muted">Not connected</span> Stripe',
    );
  });

  test("pages never ask the sources; only the Cron Trigger does", async () => {
    const { t, browser } = await signedIn();
    const before = t.sources.checkinCalls;
    await browser.get("/");
    await browser.get("/customers");
    await browser.get("/customers/demo-shop");
    expect(t.sources.checkinCalls).toBe(before);
    await t.refresh();
    expect(t.sources.checkinCalls).toBe(before + 1);
  });

  test("when the check-in service fails, shows the last data with a warning", async () => {
    const { t, browser } = await signedIn();
    await browser.get("/");
    t.sources.checkinsDown = true;
    await t.refresh();
    t.clock.now += 61_000;
    const page = (await browser.get("/")).text;
    expect(page).toContain(
      "Could not refresh. Showing data from 18/11/2026 12:00.",
    );
    expect(tile(page, "Installs")).toBe(6);
    expect(page).toContain(
      '<span class="tag bad">Down</span> Check-in service (blackark.uk)',
    );
  });

  test("with no data at all, says so", async () => {
    const t = await testBoard();
    current = t;
    await t.sql.run("DELETE FROM snapshots WHERE source = 'checkins'");
    t.sources.checkinsDown = true;
    await t.refresh();
    await t.addAccount("maria", "support");
    const browser = t.browser();
    await browser.signIn("maria", t.code("maria"));
    const page = (await browser.get("/")).text;
    expect(page).toContain("The check-in service could not be reached.");
    expect(page).toContain("No check-in data yet.");
  });
});

describe("Customers", () => {
  test("one row per customer id: installs, version, plan, days left, phone balance, last seen", async () => {
    const { browser } = await signedIn();
    const page = (await browser.get("/customers")).text;
    expect(row(page, "demo-clinic")).toEqual([
      "demo-clinic several installs",
      "2 1 silent",
      "0.1.47",
      "Trial",
      "5",
      "–",
      "18/11/2026 09:00",
    ]);
    expect(row(page, "demo-shop")).toEqual([
      "demo-shop",
      "1",
      "0.1.48",
      "Paid · team + phone",
      "–",
      "EUR 23.40",
      "18/11/2026 10:00",
    ]);
    expect(row(page, "demo-taverna")).toEqual([
      "demo-taverna",
      "1",
      "0.1.48",
      "Paid · team + phone",
      "–",
      "EUR 5.00 Low",
      "18/11/2026 07:00",
    ]);
    expect(row(page, "demo-garage")).toEqual([
      "demo-garage",
      "1 1 silent",
      "0.1.40",
      "Trial ended",
      "–",
      "–",
      "08/11/2026 12:00",
    ]);
  });

  test("filters by what the overview tiles count", async () => {
    const { browser } = await signedIn();
    const ids = async (filter: string) =>
      [
        ...(await browser.get(`/customers?plan=${filter}`)).text.matchAll(
          /href="\/customers\/([^"]+)"/g,
        ),
      ].map((m) => m[1]);
    expect(await ids("trial")).toEqual(["demo-bakery", "demo-clinic"]);
    expect(await ids("paid")).toEqual(["demo-shop", "demo-taverna"]);
    expect(await ids("ending")).toEqual(["demo-clinic"]);
    expect(await ids("silent")).toEqual(["demo-clinic", "demo-garage"]);
    expect(await ids("phone-low")).toEqual(["demo-taverna"]);
  });

  test("a customer's page shows its installs and a timeline, newest first", async () => {
    const { t, browser } = await signedIn();
    const page = (await browser.get("/customers/demo-taverna")).text;
    const items = [
      ...page.matchAll(/<li><time[^>]*>([^<]+)<\/time> ([\s\S]*?)<\/li>/g),
    ].map((m) => `${m[1]} ${(m[2] ?? "").replace(/<[^>]+>/g, "")}`);
    expect(items).toEqual([
      "20/11/2026 12:00 Trial ends on install eeee6666",
      "18/11/2026 08:00 Phone call, incoming: 3 min, EUR 0.23",
      "18/11/2026 07:59 Phone call, put through to a mobile: 2 min, EUR 0.20 written off EUR 0.08",
      "18/11/2026 07:00 Last check-in from install eeee6666: v0.1.48, trial, 2 days left, verified",
      "13/11/2026 12:00 Licence: team, 2 seats + phone, active, period ends 13/12/2026 12:00",
      "21/10/2026 13:00 First check-in from install eeee6666 (v0.1.48)",
    ]);
    expect((await readAudit(t.sql, 1, 0))[0]).toMatchObject({
      actor: "maria",
      action: "view",
      target: "customer:demo-taverna",
    });
  });

  test("an install's counts (v0.1.49) show on the customer's page; an older install shows dashes", async () => {
    const { browser } = await signedIn();
    const bakery = (await browser.get("/customers/demo-bakery")).text;
    expect(row(bakery, "aaaa1111")).toEqual([
      "aaaa1111",
      "0.1.48",
      "trial",
      "20",
      "3",
      "4",
      "3",
      "27",
      "no",
      "windows",
      "verified",
      "08/11/2026 12:00",
      "18/11/2026 11:00",
      "10",
    ]);
    const shop = (await browser.get("/customers/demo-shop")).text;
    expect(row(shop, "cccc4444").slice(5, 10)).toEqual([
      "–",
      "–",
      "–",
      "–",
      "–",
    ]);
  });

  test("a customer's page shows the tier, seats, the agent limit and this month's phone minutes per part (v0.1.49)", async () => {
    const { browser } = await signedIn();
    const facts = (page: string) =>
      Object.fromEntries(
        [...page.matchAll(/<dt>([^<]+)<\/dt><dd>([\s\S]*?)<\/dd>/g)].map(
          (m) => [m[1], (m[2] ?? "").replace(/<[^>]+>/g, "").trim()],
        ),
      );
    const taverna = facts((await browser.get("/customers/demo-taverna")).text);
    expect(taverna).toMatchObject({
      "Agents per seat": "10",
      Seats: "2",
      "Max agents": "20",
      "Agents in use": "not reported",
      "Phone minutes this month": "incoming 3 · landline 0 · mobile 2",
    });
    const shop = facts((await browser.get("/customers/demo-shop")).text);
    expect(shop).toMatchObject({
      "Agents per seat": "5 (key without a tier)",
      Seats: "1",
      "Max agents": "5",
      "Phone minutes this month": "incoming 0 · landline 0 · mobile 0",
    });
  });

  test("an unknown customer has an empty page; a malformed id is not found", async () => {
    const { browser } = await signedIn();
    const unknown = await browser.get("/customers/demo-nobody");
    expect(unknown.status).toBe(200);
    expect(unknown.text).toContain("No check-in data for this customer.");
    expect((await browser.get("/customers/%3Cscript%3E")).status).toBe(404);
  });
});

describe("Services", () => {
  test("lists each source with its state and detail", async () => {
    const { t, browser } = await signedIn();
    t.sources.githubConnected = false;
    await t.refresh();
    const page = (await browser.get("/services")).text;
    expect(row(page, "Check-in service")).toEqual([
      "Check-in service (blackark.uk)",
      "Up",
      "ok",
      "0 ms",
    ]);
    expect(row(page, "Phone relay")).toEqual([
      "Phone relay",
      "Up",
      "ok",
      "12 ms",
    ]);
    expect(row(page, "GitHub")).toEqual([
      "GitHub",
      "Not connected",
      "not connected",
      "–",
    ]);
    expect(row(page, "Stripe")).toEqual([
      "Stripe",
      "Not connected",
      "not connected",
      "–",
    ]);
  });
});

describe("Issues and fixes", () => {
  test("grouped by label, then by state; titles are escaped", async () => {
    const { browser } = await signedIn();
    const page = (await browser.get("/issues")).text;
    const headings = [
      ...page.matchAll(/<h2>([^<]+) <small>\((\d+)\)<\/small><\/h2>/g),
    ].map((m) => `${m[1]} ${m[2]}`);
    expect(headings).toEqual(["board 1", "fix 1", "phone 1", "No label 1"]);
    expect(page).toContain("<h3>Merged</h3>");
    expect(page).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(page).not.toContain("<script>");
  });

  test("before a token is given, says GitHub is not connected", async () => {
    const { t, browser } = await signedIn();
    t.sources.githubConnected = false;
    await t.refresh();
    expect((await browser.get("/issues")).text).toContain(
      "GitHub is not connected yet.",
    );
  });
});

describe("Audit log", () => {
  test("an admin sees every sign-in and action, newest first, and that the chain holds", async () => {
    const { t, browser } = await signedIn("admin");
    await t.browser().signIn("maria", "000000");
    await browser.get("/customers/demo-shop");
    const page = (await browser.get("/audit")).text;
    const actions = [
      ...page.matchAll(/<td><code>([^<]+)<\/code><\/td><td>([^<]*)<\/td>/g),
    ].map((m) => `${m[1]} ${m[2]}`);
    expect(actions).toEqual([
      "view audit",
      "view customer:demo-shop",
      "sign-in maria",
      "sign-in maria",
    ]);
    expect(page).toContain('<tr class="refused">');
    expect(page).toContain(
      "The chain of entries is checked every night; it has not been checked yet.",
    );
    await nightly(
      t.sql,
      null,
      () => t.clock.now,
      () => {},
    );
    expect((await browser.get("/audit")).text).toContain(
      "The chain of entries was intact at 18/11/2026 12:00.",
    );
  });

  test("pages through older entries", async () => {
    const { t, browser } = await signedIn("owner");
    for (let i = 0; i < 150; i++)
      await appendAudit(
        t.sql,
        { actor: "maria", action: "view", target: `p${i}`, outcome: "ok" },
        t.clock.now,
      );
    const first = (await browser.get("/audit")).text;
    expect(first).toContain("Page 1 of 2");
    expect(first).toContain('href="/audit?page=2"');
    const second = (await browser.get("/audit?page=2")).text;
    expect(second).toContain("Page 2 of 2");
  });
});

describe("Greek", () => {
  test("the language switch keeps the page, and the page is in Greek", async () => {
    const { browser } = await signedIn();
    const switched = await browser.get("/lang?to=el&back=%2Fcustomers");
    expect(switched.status).toBe(303);
    expect(switched.location).toBe("/customers");
    const page = (await browser.get("/customers")).text;
    expect(page).toContain('<html lang="el">');
    expect(page).toContain("Πελάτες");
    expect(page).toContain("Υπόλοιπο τηλεφωνίας");
    expect(row(page, "demo-shop")).toContain("23,40 €");
    const overview = (await browser.get("/")).text;
    expect(overview).toContain("Εγκαταστάσεις σιωπηλές 2 ημέρες");
  });

  test("the switch never sends you to another site", async () => {
    const { browser } = await signedIn();
    for (const back of [
      "https://evil.example/",
      "//evil.example/",
      "/\\evil.example",
    ]) {
      expect(
        (await browser.get(`/lang?to=el&back=${encodeURIComponent(back)}`))
          .location,
      ).toBe("/");
    }
  });
});

describe("every page", () => {
  test("is sent with a strict content security policy and no caching", async () => {
    const { browser } = await signedIn("owner");
    for (const path of [
      "/",
      "/customers",
      "/customers/demo-shop",
      "/services",
      "/issues",
      "/audit",
      "/accounts",
    ]) {
      const page = await browser.get(path);
      expect(page.status).toBe(200);
      expect(page.response.headers.get("content-security-policy")).toContain(
        "default-src 'none'",
      );
      expect(page.response.headers.get("content-security-policy")).toContain(
        "frame-ancestors 'none'",
      );
      expect(page.response.headers.get("cache-control")).toBe("no-store");
      expect(page.text).not.toMatch(/<script/i);
    }
  });

  test("every form carries the session's CSRF token", async () => {
    const { browser } = await signedIn("owner");
    for (const path of ["/", "/accounts"]) {
      const page = (await browser.get(path)).text;
      const forms = [
        ...page.matchAll(/<form method="post"[\s\S]*?<\/form>/g),
      ].map((m) => m[0]);
      expect(forms.length).toBeGreaterThan(0);
      for (const form of forms)
        expect(form).toMatch(/name="csrf" value="[A-Za-z0-9_-]{43}"/);
    }
  });
});
