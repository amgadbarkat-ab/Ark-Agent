/**
 * A stand-in for the person's own Chrome, and the process that drives it, for the live tests.
 *
 * The desktop app does this on a real computer (desktop/src-tauri/src/own_browser.rs): it finds the
 * installed Chrome or Edge, picks the dedicated ArkAgent profile folder, and starts `agent-computer`
 * with both. Here the "installed browser" is Playwright's Chromium behind a small wrapper script, so
 * the product code runs unchanged and the two things this sandbox needs are added outside it: no
 * Chromium sandbox (this container has no user namespaces; a person's computer does) and, for the trap
 * pages, a public-looking name for a page served on this machine, since every private address is
 * refused.
 *
 * No Playwright import: the server's tests use this too, and the server does not depend on it.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Where a Chromium to stand in for the person's browser is, or null if there is none here. */
export function standInBrowser(): string | null {
  const named = process.env.OWN_BROWSER_STAND_IN?.trim();
  if (named) return existsSync(named) ? named : null;
  const root =
    process.env.PLAYWRIGHT_BROWSERS_PATH?.trim() || "/opt/pw-browsers";
  if (!existsSync(root)) return null;
  for (const entry of readdirSync(root).sort().reverse()) {
    if (!/^chromium-\d+$/.test(entry)) continue;
    const candidate = join(root, entry, "chrome-linux64", "chrome");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const found = (probe.address() as { port: number }).port;
      probe.close(() => resolve(found));
    });
  });
}

async function until<T>(
  what: string,
  check: () => Promise<T | undefined>,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await check().catch(() => undefined);
    if (found !== undefined) return found;
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

export type OwnBrowserComputer = {
  baseUrl: string;
  token: string;
  /** The dedicated profile folder the browser was started with. */
  profileDir: string;
  process: ChildProcess;
  /** Resolves with the exit code when the process ends. */
  exited: Promise<number | null>;
  stop(): Promise<void>;
};

/**
 * Start `agent-computer` in own-browser mode, as the desktop does, and wait until it answers.
 *
 * `hostResolverRules` maps a public-looking name to this machine for the browser only. That name then
 * resolves to a private address, which the browser's proxy script refuses (private-network.ts), so
 * the stand-in also turns the script off with `--no-proxy-server`, which Chromium takes over
 * `--proxy-pac-url`. The per-request route still applies, and the script is tested on its own
 * in private-network.test.ts.
 */
export async function startOwnBrowserComputer(
  options: {
    hostResolverRules?: string;
    token?: string;
    /**
     * Start the browser itself rather than through the shell wrapper, as the desktop does: for a real
     * Chrome or Edge on Windows or macOS (own-browser-platform.test.ts), where the browser has its own
     * sandbox and a `.cmd` wrapper could not pass on the pipe the browser is driven over.
     */
    direct?: boolean;
  } = {},
): Promise<OwnBrowserComputer> {
  const chromium = standInBrowser();
  if (!chromium) {
    throw new Error("No Chromium to stand in for the person's browser.");
  }
  const scratch = await mkdtemp(join(tmpdir(), "arkagent-own-browser-"));
  const profileDir = join(scratch, "ArkAgent browser profile");
  const wrapper = join(scratch, "chrome");
  await writeFile(
    wrapper,
    [
      "#!/bin/sh",
      `exec "${chromium}" --no-sandbox ${
        options.hostResolverRules
          ? `"--host-resolver-rules=${options.hostResolverRules}" --no-proxy-server`
          : ""
      } "$@"`,
      "",
    ].join("\n"),
  );
  await chmod(wrapper, 0o755);

  const token = options.token ?? "own-browser-test-token";
  const port = await freePort();
  const entry = join(import.meta.dir, "..", "src", "index.ts");
  const child = spawn(process.execPath, [entry], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: scratch,
      // Windows will not start a browser without these; harmless elsewhere.
      ...(options.direct
        ? {
            SystemRoot: process.env.SystemRoot ?? "",
            LOCALAPPDATA: process.env.LOCALAPPDATA ?? "",
            TEMP: process.env.TEMP ?? "",
            TMP: process.env.TMP ?? "",
          }
        : {}),
      PORT: String(port),
      COMPUTER_TOKEN: token,
      COMPUTER_OWN_BROWSER_EXECUTABLE: options.direct ? chromium : wrapper,
      COMPUTER_OWN_BROWSER_PROFILE: profileDir,
      // No screen in CI. On a person's computer the window is the point.
      COMPUTER_OWN_BROWSER_HEADLESS: "true",
    },
    stdio: process.env.OWN_BROWSER_DEBUG ? "inherit" : "ignore",
  });
  const exited = new Promise<number | null>((resolve) =>
    child.on("exit", (code) => resolve(code)),
  );
  const baseUrl = `http://127.0.0.1:${port}`;
  await until("the own-browser computer", async () => {
    const response = await fetch(`${baseUrl}/health`);
    return response.ok ? true : undefined;
  });
  return {
    baseUrl,
    token,
    profileDir,
    process: child,
    exited,
    async stop() {
      child.kill("SIGTERM");
      await Promise.race([exited, Bun.sleep(5_000)]);
      child.kill("SIGKILL");
      await rm(scratch, { recursive: true, force: true });
    },
  };
}
