import { afterEach, describe, expect, test } from "bun:test";
import { appendAudit, readAudit } from "./audit";
import { testBoard } from "./test-helpers";

const PASSWORD = "correct horse battery";
let current: ReturnType<typeof testBoard> | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

async function signedIn(
  role: "owner" | "admin" | "support" | "read-only" = "support",
) {
  const t = testBoard();
  current = t;
  await t.addAccount("maria", role);
  const browser = t.browser();
  await browser.signIn("maria", PASSWORD, t.code("maria"));
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

  test("shows each service up, down or not connected", async () => {
    const { t, browser } = await signedIn();
    t.sources.relayDown = true;
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

  test("asks the check-in service at most once a minute", async () => {
    const { t, browser } = await signedIn();
    await browser.get("/");
    await browser.get("/customers");
    await browser.get("/customers/demo-shop");
    expect(t.sources.checkinCalls).toBe(1);
    t.clock.now += 61_000;
    await browser.get("/");
    expect(t.sources.checkinCalls).toBe(2);
  });

  test("when the check-in service fails, shows the last data with a warning", async () => {
    const { t, browser } = await signedIn();
    await browser.get("/");
    t.sources.checkinsDown = true;
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
    const t = testBoard();
    current = t;
    t.sources.checkinsDown = true;
    await t.addAccount("maria", "support");
    const browser = t.browser();
    await browser.signIn("maria", PASSWORD, t.code("maria"));
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
    expect(readAudit(t.db, 1, 0)[0]).toMatchObject({
      actor: "maria",
      action: "view",
      target: "customer:demo-taverna",
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
    expect((await browser.get("/issues")).text).toContain(
      "GitHub is not connected yet.",
    );
  });
});

describe("Audit log", () => {
  test("an admin sees every sign-in and action, newest first, and that the chain holds", async () => {
    const { t, browser } = await signedIn("admin");
    await t.browser().signIn("maria", "wrong password!!", "000000");
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
    expect(page).toContain("The chain of entries is intact.");
  });

  test("pages through older entries", async () => {
    const { t, browser } = await signedIn("owner");
    for (let i = 0; i < 150; i++)
      appendAudit(
        t.db,
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
