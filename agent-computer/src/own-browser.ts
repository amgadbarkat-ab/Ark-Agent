/**
 * The person's own browser, as a computer (device control, phase 1; desk #27).
 *
 * Everything else in this package drives a Chromium this process launched inside a container. In
 * this mode it drives the Chrome or Edge installed on the customer's own computer instead: the desktop
 * app finds that browser, picks a dedicated ArkAgent profile folder for it, and starts this process
 * with both. The HTTP API is the same one, which is the point: the server reaches this exactly as it
 * reaches a container, so every action still goes through the one gateway (the element resolved from
 * the server's own snapshot, the policy, the audit row, the approval) and there is no second, quieter
 * way in.
 *
 * LAUNCHED OVER A PIPE, NOT REACHED ON A PORT. The browser is started by this process with the
 * DevTools connection on a pipe between the two, so there is no debugging port on the computer at
 * all: nothing else the person runs can find it and drive their browser, and it ends with this
 * process. (Attaching to a port with `connectOverCDP` was tried first: under Bun, Playwright's
 * WebSocket client never completes the handshake, measured on 29 October 2026, and a port any local
 * program can reach is the weaker design anyway.)
 *
 * What is different follows from whose computer this is:
 *  - A DEDICATED PROFILE, never the person's own. Their everyday profile holds their saved passwords
 *    and every session they are signed in to; the ArkAgent profile holds only what they sign in to on
 *    purpose, for the employees. A folder that is one of the browsers' own profile folders is refused.
 *  - No files and no shell. In a container `/exec` runs in a box that is thrown away; here it would
 *    run on the person's own machine with their account. Phase 1 is the browser only, so those
 *    endpoints refuse rather than exist.
 *  - No reset. Reset deletes a profile, and this profile is the one the person signs in to.
 *  - No private addresses, ever, whatever the deployment says (finding 1). The person's browser sits
 *    on their office network, and a page that talks an employee into opening the router is the
 *    attack the trap pages are made of.
 *
 * No Playwright import here, so the tests reach the rules without a browser driver.
 */

import { isAbsolute, join, normalize, sep } from "node:path";

export type OwnBrowserSettings = {
  /** The installed Chrome or Edge, as the desktop found it. */
  executable: string;
  /** The dedicated ArkAgent profile folder. */
  profileDir: string;
  /** Only for tests and CI, which have no screen. On a person's computer the window is the point. */
  headless: boolean;
};

/** The person's browser, or null when this process runs in a container as usual. */
export function ownBrowserFromEnv(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): OwnBrowserSettings | null {
  const executable = env.COMPUTER_OWN_BROWSER_EXECUTABLE?.trim();
  if (!executable) return null;
  const profileDir = env.COMPUTER_OWN_BROWSER_PROFILE?.trim() ?? "";
  if (!profileDir || !isAbsolute(profileDir)) {
    throw new Error(
      "COMPUTER_OWN_BROWSER_PROFILE must name the dedicated ArkAgent profile folder, as an absolute path.",
    );
  }
  if (isPersonsOwnProfile(profileDir, env, platform)) {
    throw new Error(
      "COMPUTER_OWN_BROWSER_PROFILE is one of the browser's own profile folders. A digital employee only ever works in the dedicated ArkAgent profile, never the person's own, which holds their saved passwords and sign-ins.",
    );
  }
  return {
    executable,
    profileDir: normalize(profileDir),
    headless: env.COMPUTER_OWN_BROWSER_HEADLESS?.trim() === "true",
  };
}

/**
 * Where Chrome, Edge and Chromium keep the person's own profiles, on each platform.
 *
 * Their "User Data" folders: every profile a person has is inside one, so a folder at or under any
 * of these is a profile of theirs.
 */
export function personsProfileFolders(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): string[] {
  const home = env.HOME ?? env.USERPROFILE ?? "";
  if (platform === "win32") {
    const local =
      env.LOCALAPPDATA ?? (home ? join(home, "AppData", "Local") : "");
    if (!local) return [];
    return [
      join(local, "Google", "Chrome", "User Data"),
      join(local, "Google", "Chrome Beta", "User Data"),
      join(local, "Microsoft", "Edge", "User Data"),
      join(local, "Microsoft", "Edge Beta", "User Data"),
      join(local, "Chromium", "User Data"),
    ];
  }
  if (!home) return [];
  if (platform === "darwin") {
    const support = join(home, "Library", "Application Support");
    return [
      join(support, "Google", "Chrome"),
      join(support, "Google", "Chrome Beta"),
      join(support, "Microsoft Edge"),
      join(support, "Microsoft Edge Beta"),
      join(support, "Chromium"),
    ];
  }
  const config = env.XDG_CONFIG_HOME || join(home, ".config");
  return [
    join(config, "google-chrome"),
    join(config, "google-chrome-beta"),
    join(config, "microsoft-edge"),
    join(config, "microsoft-edge-beta"),
    join(config, "chromium"),
  ];
}

export function isPersonsOwnProfile(
  profileDir: string,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): boolean {
  // Windows and macOS compare folder names without regard to case, and so must this.
  const fold = (path: string) => {
    const normal = normalize(path).replace(/[\\/]+$/, "");
    return platform === "linux" ? normal : normal.toLowerCase();
  };
  const candidate = fold(profileDir);
  return personsProfileFolders(env, platform).some((folder) => {
    const own = fold(folder);
    return (
      candidate === own ||
      candidate.startsWith(`${own}${platform === "win32" ? "\\" : sep}`)
    );
  });
}

/**
 * The arguments Playwright adds by default that are wrong for somebody's real browser.
 *
 * Playwright starts a browser for testing, and some of its defaults trade the person's safety for a
 * test's convenience: a plain-text password store instead of the system keychain, the phishing check
 * switched off, and popups unblocked. `--enable-automation` goes for the reason the container drops
 * it (profiles.ts): it sets `navigator.webdriver`, and sites such as Google then refuse the person's
 * own sign-in. Every other default stays, including extensions off: this profile is for the
 * employees, and an extension in it would read every page they open.
 */
export const OWN_BROWSER_IGNORED_DEFAULT_ARGS = [
  "--enable-automation",
  "--password-store=basic",
  "--use-mock-keychain",
  "--disable-client-side-phishing-detection",
  "--disable-popup-blocking",
];

/** What the employee is told when it reaches for something this target does not have. */
export const OWN_BROWSER_HAS_NO_FILES =
  "This digital employee is using the person's own browser, which has no files or command line. Phase 1 of device control is the browser only.";

export const OWN_BROWSER_HAS_NO_RESET =
  "This is the person's own browser. ArkAgent never deletes its profile; the person can sign out of sites in the browser itself.";

export const PRIVATE_ADDRESS_REFUSED =
  "That address is on the person's own network, so a digital employee is not allowed to open it from their browser.";

/** Paths this target refuses, because they belong to a container and not to a person's computer. */
export function ownBrowserRefuses(pathname: string): string | null {
  if (
    pathname === "/exec" ||
    pathname === "/files/read" ||
    pathname === "/files/write" ||
    pathname === "/files/list"
  ) {
    return OWN_BROWSER_HAS_NO_FILES;
  }
  if (pathname === "/computers/reset") return OWN_BROWSER_HAS_NO_RESET;
  return null;
}

/**
 * Is this request headed somewhere on the person's own network or computer?
 *
 * The same ranges the server's navigation check refuses (server/src/computer/target.ts); a copy
 * because this package is built and shipped on its own and cannot import the server. It is applied to
 * every request an employee's tab makes, not only to the address it was asked to open: a link click,
 * a redirect, a form posting to the router and an image pointed at a printer all leave the browser
 * the same way, and the person's browser is on their office network.
 *
 * By the name as written, without resolving it, like the server's rule. A public name that resolves
 * to a private address, and every hop of a redirect, are caught by the browser's proxy script instead
 * (private-network.ts), which the route cannot do.
 */
export function isPrivateDestination(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return false;
  return isPrivateHostname(url.hostname);
}

export function isPrivateHostname(hostname: string): boolean {
  let name = hostname.toLowerCase().replace(/\.+$/, "");
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  if (
    name === "metadata.google.internal" ||
    name === "metadata.goog" ||
    name.endsWith(".local") ||
    name.endsWith(".internal")
  ) {
    return true;
  }
  if (name.startsWith("[") && name.endsWith("]")) {
    name = name.slice(1, -1);
    const groups = expandIpv6(name);
    if (!groups) return false;
    const embedded = embeddedIpv4(groups);
    if (embedded) return isPrivateIpv4(embedded);
    return isPrivateIpv6(groups);
  }
  return isPrivateIpv4(name);
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return false;
  }
  const [a, b, c] = parts.map(Number) as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  // Multicast and reserved: no public site lives there, and a printer's discovery address does.
  return a >= 224;
}

function isPrivateIpv6(groups: number[]): boolean {
  if (groups.every((group) => group === 0)) return true;
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) {
    return true;
  }
  const first = groups[0] ?? 0;
  return (
    (first >= 0xfe80 && first <= 0xfebf) || (first >= 0xfc00 && first <= 0xfdff)
  );
}

/** The IPv4 address an IPv4-mapped, compatible or NAT64 IPv6 address carries, if it carries one. */
function embeddedIpv4(groups: number[]): string | null {
  const [a, b, c, d, e, f, high = 0, low = 0] = groups;
  const zeros = a === 0 && b === 0 && c === 0 && d === 0 && e === 0;
  const nat64 =
    a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0;
  if (!(zeros && (f === 0xffff || f === 0)) && !nat64) return null;
  if (zeros && f === 0 && high >> 8 === 0) return null;
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

function expandIpv6(hostname: string): number[] | null {
  // `new URL` writes an embedded IPv4 in hex already, so only hex groups arrive here.
  const halves = hostname.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) =>
    part === ""
      ? []
      : part.split(":").map((group) => Number.parseInt(group, 16));
  const head = parse(halves[0] ?? "");
  const tail = halves.length === 2 ? parse(halves[1] ?? "") : [];
  if ([...head, ...tail].some((group) => Number.isNaN(group))) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  return [...head, ...Array(missing).fill(0), ...tail];
}
