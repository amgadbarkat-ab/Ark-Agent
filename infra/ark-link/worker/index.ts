/**
 * Ark Link relay on Cloudflare Workers + Durable Objects (#149), beside the Bun one (`../relay.ts`).
 * Same contract, same behaviour, same shared logic; what differs is where state lives:
 *
 *   phone ── https/wss ──▶ Worker ──▶ Directory object (routes, pairing codes; SQLite)
 *                             └──────▶ Install object, one per desktop (its socket, with Hibernation)
 *   desktop ── wss /_link/desk ──▶ Worker ──▶ that Install object
 *
 * The Worker checks the install token against `LINK_INSTALLS` (hashes only), finds a phone's desktop by
 * its device token's hash (asking the directory, and remembering the answer for a short while), and
 * hands the request to that desktop's object, which streams it through. NOT DEPLOYED: Amgad's yes.
 */
import { normalizeFingerprint } from "../../../server/src/mobile/links";
import {
  deviceTokenFrom,
  isInstallToken,
  tokenHash,
} from "../../../shared/ark-link";
import {
  Buckets,
  type DeviceRoute,
  json,
  limitsWith,
  notPaired,
  sameHex,
} from "../desk-link";
import type { ClaimAnswer, StatusAnswer } from "../directory";
import {
  claimResponse,
  ownRoute,
  readClaim,
  readPairingId,
  statusResponse,
} from "../edge";
import { call, DirectoryObject } from "./directory-object";
import { INTERNAL, InstallObject } from "./install-object";
import {
  type DurableObjectState,
  type Env,
  type Platform,
  workersPlatform,
} from "./types";

/** How long a Worker isolate trusts a route it looked up. The desktop checks every token anyway. */
const ROUTE_CACHE_MS = 30_000;

type Installs = { id: string; tokenSha256: string }[];

function installsFrom(env: Env): Installs {
  try {
    const parsed = JSON.parse(env.LINK_INSTALLS || "[]") as Installs;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function appsFrom(env: Env) {
  const android = env.ARK_ANDROID_APP_ID?.trim();
  const fingerprints = (env.ARK_ANDROID_CERT_SHA256 ?? "")
    .split(",")
    .map((value) => normalizeFingerprint(value))
    .filter((value): value is string => Boolean(value));
  const ios = env.ARK_IOS_APP_ID?.trim();
  return {
    ...(android && fingerprints.length
      ? { android: { appId: android, certFingerprints: fingerprints } }
      : {}),
    ...(ios ? { ios: { appId: ios } } : {}),
  };
}

export function createWorker() {
  const routes = new Map<string, { route: DeviceRoute | null; at: number }>();
  const unknown = new Buckets(
    limitsWith().unknownPerMinute,
    limitsWith().unknownPerMinute,
    Date.now,
  );

  async function routeFor(env: Env, hash: string): Promise<DeviceRoute | null> {
    const cached = routes.get(hash);
    if (cached && Date.now() - cached.at < ROUTE_CACHE_MS) return cached.route;
    const { route } = await call<{ route: DeviceRoute | null }>(
      directory(env),
      "/lookup",
      { hash },
    );
    routes.set(hash, { route, at: Date.now() });
    if (routes.size > 10_000) routes.clear();
    return route;
  }

  const directory = (env: Env) =>
    env.DIRECTORY.get(env.DIRECTORY.idFromName("directory"));
  const install = (env: Env, id: string) =>
    env.INSTALL.get(env.INSTALL.idFromName(id));

  async function desk(request: Request, env: Env): Promise<Response> {
    const token = (request.headers.get("authorization") ?? "")
      .replace(/^Bearer\s+/i, "")
      .trim();
    if (!isInstallToken(token))
      return new Response("Unauthorized.", { status: 401 });
    const hash = await tokenHash(token);
    const found = installsFrom(env).find((entry) =>
      sameHex(entry.tokenSha256, hash),
    );
    if (!found) return new Response("Unauthorized.", { status: 401 });
    const headers = new Headers(request.headers);
    headers.set(INTERNAL.install, found.id);
    headers.set(
      INTERNAL.version,
      request.headers.get("ark-link-version") ?? "0",
    );
    return install(env, found.id).fetch(new Request(request, { headers }));
  }

  async function phone(request: Request, env: Env): Promise<Response> {
    const secure = env.LINK_ORIGIN.startsWith("https:");
    const address = request.headers.get("cf-connecting-ip") ?? "unknown";
    const token = deviceTokenFrom(request.headers);
    if (!token) {
      if (!unknown.take(address))
        return json({ error: "Too many requests." }, 429);
      return notPaired(request, false, secure);
    }
    const route = await routeFor(env, await tokenHash(token));
    if (!route) {
      if (!unknown.take(address))
        return json({ error: "Too many requests." }, 429);
      return notPaired(request, true, secure);
    }
    const headers = new Headers(request.headers);
    for (const name of Object.values(INTERNAL)) headers.delete(name);
    headers.set(INTERNAL.route, JSON.stringify(route));
    headers.set(INTERNAL.token, token);
    return install(env, route.installId).fetch(
      new Request(request, { headers }),
    );
  }

  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const linkOrigin = env.LINK_ORIGIN.replace(/\/+$/, "");
      const own = ownRoute(request, { linkOrigin, apps: appsFrom(env) });
      if (own instanceof Response) return own;
      if (own === "desk") return desk(request, env);
      const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
      if (own === "claim") {
        const read = await readClaim(request);
        if (read instanceof Response) return read;
        return claimResponse(
          await call<ClaimAnswer>(directory(env), "/claim", { ...read, ip }),
        );
      }
      if (own === "status") {
        const pairingId = await readPairingId(request);
        return statusResponse(
          await call<StatusAnswer>(directory(env), "/status", {
            pairingId,
            ip,
          }),
          linkOrigin.startsWith("https:"),
        );
      }
      // Anything else a phone sends names its own headers; the internal ones are this Worker's.
      return phone(request, env);
    },
  };
}

const worker = createWorker();
export default { fetch: worker.fetch };

/** The Durable Object classes, as `wrangler.toml` names them. */
export class LinkInstall extends InstallObject {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env, workersPlatform as Platform);
  }
}

export class LinkDirectory extends DirectoryObject {}
