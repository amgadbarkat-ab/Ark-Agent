import type { BrowserContext } from "playwright";
import { isPrivateDestination } from "./own-browser";

/**
 * Refuse every request a browser makes to a private address, whatever asked for it.
 *
 * The server refuses a private address when an employee asks to open one, but that check sees only
 * the address it was handed. A link click, a redirect from a public page, a form posting to the
 * router and an image pointed at a printer all leave the browser without asking the server, which is
 * how a prompt-injected page would send an employee onto the office network (device control, finding
 * 1). So the rule is applied here as well, to every request of the whole context: a window a page
 * opens is covered from its first request rather than from the moment it is noticed.
 *
 * Used for the person's own browser always, and for the sandbox browser when the deployment says
 * browsing the private range is closed (`COMPUTER_BLOCK_PRIVATE_NETWORK`, which the desktop sets).
 */
export async function refusePrivateRequests(
  context: BrowserContext,
  /** Names the log line, so a refusal says which browser it happened in. */
  type: string,
): Promise<void> {
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (isPrivateDestination(url)) {
      // The host only: a path can carry a token.
      console.info(JSON.stringify({ type, host: new URL(url).host }));
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
}

/**
 * The browser's own proxy settings, sending every private destination nowhere.
 *
 * `refusePrivateRequests` cannot catch a redirect: Playwright hands a route only the first address
 * of a redirect chain, and the hops after it go straight out (measured on 29 October 2026: a public
 * address answering 302 to `http://192.168.1.1/admin` reached the router address with the route in
 * place). A proxy auto-config script is asked by the browser's network stack for every request,
 * every redirect hop included, so it is where the rule has to live as well. It also resolves names,
 * which the route cannot: a public-looking name that resolves to the office network is caught here.
 *
 * A private destination is sent to a proxy that cannot exist (`0.0.0.0:9`), so it fails at once with
 * ERR_PROXY_CONNECTION_FAILED and nothing leaves. Everything else goes direct. `<-loopback>` makes
 * the browser ask the script about this computer's own addresses too, which it otherwise skips.
 *
 * Not combined with a per-Bot egress proxy: the two settings replace each other, and a deployment
 * that routes a Bot through its own proxy enforces its network rules there (see egress.ts).
 */
export function refusePrivateNetworkArgs(): string[] {
  const script = `function FindProxyForURL(url, host) {
  var name = host.toLowerCase();
  if (name === "localhost" || shExpMatch(name, "*.localhost") || shExpMatch(name, "*.local") ||
      shExpMatch(name, "*.internal") || name === "metadata.goog") return "PROXY 0.0.0.0:9";
  if (name.indexOf(":") >= 0) {
    if (name === "::" || name === "::1" || shExpMatch(name, "fc*") || shExpMatch(name, "fd*") ||
        shExpMatch(name, "fe8*") || shExpMatch(name, "fe9*") || shExpMatch(name, "fea*") ||
        shExpMatch(name, "feb*") || shExpMatch(name, "::ffff:*")) return "PROXY 0.0.0.0:9";
    return "DIRECT";
  }
  var ip = /^[0-9]+[.][0-9]+[.][0-9]+[.][0-9]+$/.test(name) ? name : dnsResolve(name);
  if (!ip) return "DIRECT";
  var ranges = [
    ["0.0.0.0", "255.0.0.0"], ["10.0.0.0", "255.0.0.0"], ["127.0.0.0", "255.0.0.0"],
    ["169.254.0.0", "255.255.0.0"], ["172.16.0.0", "255.240.0.0"], ["192.168.0.0", "255.255.0.0"],
    ["100.64.0.0", "255.192.0.0"], ["192.0.0.0", "255.255.255.0"], ["198.18.0.0", "255.254.0.0"],
    ["224.0.0.0", "224.0.0.0"]
  ];
  for (var i = 0; i < ranges.length; i++) {
    if (isInNet(ip, ranges[i][0], ranges[i][1])) return "PROXY 0.0.0.0:9";
  }
  return "DIRECT";
}`;
  return [
    `--proxy-pac-url=data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(script).toString("base64")}`,
    "--proxy-bypass-list=<-loopback>",
  ];
}

/** Whether the deployment has closed the private range to its employees' browsers. */
export function privateNetworkBlocked(
  env: Record<string, string | undefined>,
): boolean {
  const raw = env.COMPUTER_BLOCK_PRIVATE_NETWORK?.trim();
  if (!raw || raw === "false") return false;
  if (raw === "true") return true;
  throw new Error(
    `COMPUTER_BLOCK_PRIVATE_NETWORK must be true or false, not ${JSON.stringify(raw)}.`,
  );
}
