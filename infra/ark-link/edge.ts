/**
 * The relay's own paths (#149), the same on Bun and on Workers: health, the store apps' files, the
 * pairing page and its script, and the JSON a phone gets when it claims a code or polls for its token.
 */
import {
  appleAppSiteAssociation,
  assetLinks,
  type MobileLinksConfig,
} from "../../server/src/mobile/links";
import {
  ARK_LINK_PATHS,
  cleanDeviceName,
  normalisePairingCode,
} from "../../shared/ark-link";
import { clearedCookie, deviceCookie, html, json, readBody } from "./desk-link";
import type { ClaimAnswer, StatusAnswer } from "./directory";
import { PAIR_PAGE, PAIR_SCRIPT } from "./pages";

export type EdgeConfig = {
  linkOrigin: string;
  apps?: MobileLinksConfig;
};

/** The relay's writes come from its own pages, or from an app that sends no Origin. */
export function sameSite(request: Request, linkOrigin: string): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  return origin === linkOrigin || origin === new URL(request.url).origin;
}

/**
 * The answer for one of the relay's own paths that needs no state, `"claim"` or `"status"` for the
 * two that do, `"desk"` for the desktop's socket, or null for a path that is the desktop's app.
 */
export function ownRoute(
  request: Request,
  config: EdgeConfig,
): Response | "claim" | "status" | "desk" | null {
  const path = new URL(request.url).pathname;
  const secure = config.linkOrigin.startsWith("https:");
  if (path === ARK_LINK_PATHS.health) return new Response("ok");
  if (path === ARK_LINK_PATHS.assetLinks) {
    if (config.apps?.android)
      return json(assetLinks(config.apps.android), 200, {
        "cache-control": "max-age=300",
      });
    return new Response("Not found.", { status: 404 });
  }
  if (path === ARK_LINK_PATHS.appleAppSiteAssociation) {
    if (config.apps?.ios)
      return json(appleAppSiteAssociation(config.apps.ios), 200, {
        "cache-control": "max-age=300",
      });
    return new Response("Not found.", { status: 404 });
  }
  if (path === ARK_LINK_PATHS.desk) return "desk";
  if (!path.startsWith("/_link/")) return null;
  if (path === ARK_LINK_PATHS.pairPage && request.method === "GET")
    return html(PAIR_PAGE);
  if (path === "/_link/pair.js" && request.method === "GET")
    return new Response(PAIR_SCRIPT, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
      },
    });
  if (request.method === "POST" && !sameSite(request, config.linkOrigin))
    return json({ error: "This request came from another website." }, 403);
  if (path === ARK_LINK_PATHS.pairClaim && request.method === "POST")
    return "claim";
  if (path === ARK_LINK_PATHS.pairStatus && request.method === "POST")
    return "status";
  if (path === ARK_LINK_PATHS.forget && request.method === "POST")
    return json({ ok: true }, 200, { "set-cookie": clearedCookie(secure) });
  return new Response("Not found.", { status: 404 });
}

/** The code and name a phone sent, or the refusal to answer with. */
export async function readClaim(
  request: Request,
): Promise<{ code: string; deviceName: string } | Response> {
  const body = (await readBody(request, 2048)) as Record<
    string,
    unknown
  > | null;
  const code =
    typeof body?.code === "string" ? normalisePairingCode(body.code) : null;
  const deviceName = cleanDeviceName(body?.deviceName);
  if (!code || !deviceName)
    return json({ status: "refused", reason: "unknown" }, 400);
  return { code, deviceName };
}

export async function readPairingId(request: Request): Promise<string> {
  const body = (await readBody(request, 1024)) as Record<
    string,
    unknown
  > | null;
  return typeof body?.pairingId === "string" ? body.pairingId : "";
}

export function claimResponse(answer: ClaimAnswer): Response {
  if (!answer.ok)
    return json({ status: "refused", reason: answer.reason }, answer.status);
  return json(
    {
      status: "pending",
      pairingId: answer.pairingId,
      expiresAt: new Date(answer.expiresAt).toISOString(),
    },
    200,
    {
      /*
       * Every customer's desktop is served on this one origin. A phone paired before with another
       * desktop still holds that desktop's sign-in cookies, its service worker and its storage here,
       * and would hand them to the next. Pairing starts the phone clean (the device cookie too; the
       * new one arrives with the confirmation).
       */
      "clear-site-data": '"cache", "cookies", "storage"',
    },
  );
}

export function statusResponse(
  answer: StatusAnswer,
  secure: boolean,
): Response {
  if (answer.status === "confirmed")
    return json(
      {
        status: "confirmed",
        deviceToken: answer.deviceToken,
        deviceName: answer.deviceName,
      },
      200,
      { "set-cookie": deviceCookie(answer.deviceToken, secure) },
    );
  if (answer.status === "refused")
    return json(
      { status: "refused", reason: answer.reason },
      answer.httpStatus,
    );
  return json({ status: "pending" });
}
