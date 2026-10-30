// Can Playwright drive an installed browser from this runtime at all? Run with both `node` and `bun`
// on Windows (own-browser.yml): Playwright talks to the browser over a pipe on extra file descriptors,
// which is the part a runtime can lack. Prints one line and exits 0 either way; the log is the result.
import { chromium } from "playwright";

const executablePath = process.env.OWN_BROWSER_STAND_IN;
const runtime =
  typeof Bun === "undefined" ? `node ${process.version}` : `bun ${Bun.version}`;
const started = Date.now();
try {
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    timeout: 30_000,
  });
  const page = await browser.newPage();
  await page.goto("https://example.com/", { timeout: 30_000 });
  console.log(
    `${runtime}: launched and loaded "${await page.title()}" in ${Date.now() - started} ms`,
  );
  await browser.close();
} catch (error) {
  console.log(
    `${runtime}: FAILED after ${Date.now() - started} ms: ${String(error).split("\n")[0]}`,
  );
}
process.exit(0);
