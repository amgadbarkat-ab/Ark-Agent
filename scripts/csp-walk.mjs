/**
 * Walk the app's screens in a real browser and list what the Content-Security-Policy objects to.
 *
 *   node scripts/csp-walk.mjs --url https://ark.example.com --cookie 'better-auth.session_token=...' [--admin-cookie '...']
 *
 * Run it against a deployment in `CSP_MODE=report-only` before turning on `enforce`
 * (docs/ark/15-security-review.md, O3). Prints one line per distinct violation and the screen it was
 * first seen on; nothing printed under "policy reports" means nothing the policy would block was found
 * on the screens walked. The screens that run a generated interface (Admin, Components and Playground)
 * report by design: they are why `enforce` needs `OPENBOT_GENERATIVE_UI=false`.
 *
 * Needs Playwright with a Chromium: `npm i -g playwright && npx playwright install chromium`, or set
 * PLAYWRIGHT_MODULE to its index.mjs. Sign in as a customer in a browser and copy the session cookie
 * from its developer tools; do not paste a real person's cookie anywhere else.
 */
const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const url = flag("--url");
const cookie = flag("--cookie");
const adminCookie = flag("--admin-cookie");
if (!url || !cookie) {
  console.error(
    "Usage: node scripts/csp-walk.mjs --url <address> --cookie '<name>=<value>' [--admin-cookie '<name>=<value>']",
  );
  process.exit(2);
}

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright"
);
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {}),
});

const customerScreens = [
  "/",
  "/agents",
  "/channel/new",
  "/settings",
  "/settings/plan",
  "/settings/models",
  "/settings/privacy",
  "/marketplace",
  "/privacy",
];
const adminScreens = [
  "/admin",
  "/admin/accounts",
  "/admin/cloud",
  "/admin/audit",
  "/admin/people",
  "/admin/marketplace",
  "/admin/credentials",
  "/admin/computers",
  "/admin/skills",
  "/admin/components",
  "/admin/playground",
  "/admin/plugins",
];
const POLICY = /Content.Security.Policy|\[Report Only\]|Refused to/i;

async function walk(who, header, screens) {
  const [name, ...rest] = header.split("=");
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  await context.addCookies([
    { name, value: decodeURIComponent(rest.join("=")), url },
  ]);
  const seen = new Map();
  for (const path of screens) {
    const page = await context.newPage();
    page.on("console", (message) => {
      const text = message.text().replace(/\s+/g, " ").slice(0, 260);
      if (POLICY.test(text) && !seen.has(text)) seen.set(text, path);
    });
    await page
      .goto(url + path, { waitUntil: "networkidle", timeout: 30000 })
      .catch(() => {});
    await page.waitForTimeout(800);
    const heading = await page
      .locator("h1,h2")
      .first()
      .innerText()
      .catch(() => "(no heading)");
    console.log(`${who} ${path} -> ${heading.slice(0, 40)}`);
    await page.close();
  }
  await context.close();
  return seen;
}

const reports = await walk("customer", cookie, customerScreens);
if (adminCookie) {
  for (const [text, path] of await walk("staff", adminCookie, adminScreens))
    reports.set(text, path);
}
console.log(`\npolicy reports: ${reports.size}`);
for (const [text, path] of reports) console.log(`[${path}] ${text}`);
await browser.close();
