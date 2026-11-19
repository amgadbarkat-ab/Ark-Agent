/**
 * The phone relay on Cloudflare Workers + Durable Objects, beside the Bun one (`../relay.ts`). Same
 * contract with Twilio and with the install, the same rules (`../core.ts`); what differs is where
 * state lives:
 *
 *   Twilio ── POST /twilio/voice|status|dialed (signed) ──▶ Worker ──▶ Directory (lines; SQLite)
 *                                                             └────▶ Line object, one per line
 *   Twilio ── wss /twilio/media/<line> ──▶ Worker ──▶ that Line object (media socket, Hibernation)
 *   install ── wss /line (Bearer line token) ──▶ Worker ──▶ that Line object (install socket)
 *   cli.ts ── POST /admin/* (Bearer ADMIN_TOKEN) ──▶ Worker ──▶ Directory (+ the line's object)
 *
 * The Worker checks Twilio's signature (HMAC-SHA1 by WebCrypto over the exact public URL and the
 * sorted fields) and the Account SID, finds the line by the called number or the token's SHA-256,
 * and hands the request to that line's object with the line in a header only this code sets.
 */
import {
  ACCOUNT_SID,
  CALL_SID,
  hmacSha1Base64,
  LINE_NAME,
  type Line,
  SORRY,
  sameText,
  sha256HexWeb,
  signatureBase,
  twiml,
} from "../core";
import { call } from "./directory-object";
import { LINE_HEADER } from "./line-object";
import type { Env, Platform } from "./types";

const MAX_FORM = 16 * 1024;

export function createWorker(platform: Platform) {
  const directory = (env: Env) =>
    env.DIRECTORY.get(env.DIRECTORY.idFromName("directory"));
  const lineObject = (env: Env, name: string) =>
    env.LINE.get(env.LINE.idFromName(name));

  /** A request to the line's object, carrying the line; nothing from outside but `body`. */
  const toLine = (
    env: Env,
    line: Line,
    path: string,
    body?: unknown,
    upgrade = false,
  ) =>
    lineObject(env, line.name).fetch(
      new Request(`https://line${path}`, {
        method: upgrade ? "GET" : "POST",
        headers: {
          [LINE_HEADER]: JSON.stringify(line),
          ...(upgrade ? { upgrade: "websocket" } : {}),
        },
        ...(upgrade ? {} : { body: JSON.stringify(body ?? {}) }),
      }),
    );

  async function byNumber(env: Env, number: string): Promise<Line | null> {
    return (
      await call<{ line: Line | null }>(directory(env), "/by-number", {
        number,
      })
    ).line;
  }

  /** The form of a webhook Twilio signed for this account, or null. */
  async function signedForm(
    request: Request,
    env: Env,
    path: string,
  ): Promise<Record<string, string> | null> {
    const signature = request.headers.get("x-twilio-signature") ?? "";
    const text = await request.text();
    if (!signature || text.length > MAX_FORM) return null;
    const params: Record<string, string> = {};
    for (const [key, value] of new URLSearchParams(text)) params[key] = value;
    const url = `${env.PUBLIC_BASE_URL.replace(/\/+$/, "")}${path}`;
    const expected = await hmacSha1Base64(
      env.TWILIO_AUTH_TOKEN,
      signatureBase(url, params),
    );
    if (!sameText(signature, expected)) return null;
    if (params.AccountSid !== env.TWILIO_ACCOUNT_SID) return null;
    return params;
  }

  async function desk(request: Request, env: Env): Promise<Response> {
    const header = request.headers.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const line = token
      ? (
          await call<{ line: Line | null }>(directory(env), "/by-token", {
            hash: await sha256HexWeb(token),
          })
        ).line
      : null;
    if (!line)
      return new Response("This line token is not known here.", {
        status: 401,
      });
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return new Response("Expected a WebSocket.", { status: 426 });
    return toLine(env, line, "/desk", undefined, true);
  }

  async function admin(
    request: Request,
    env: Env,
    command: string,
  ): Promise<Response> {
    const header = request.headers.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const expected = env.ADMIN_TOKEN?.trim();
    if (
      !expected ||
      !token ||
      !sameText(await sha256HexWeb(token), await sha256HexWeb(expected))
    )
      return new Response("Not found.", { status: 404 });
    const body = await request.json().catch(() => ({}));
    const answer = await directory(env).fetch(
      new Request(`https://directory/${command}`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
    const result = (await answer.clone().json()) as {
      replaced?: string[];
      line?: Line;
    };
    // The line objects hear what changed: a removed or replaced line's install is let go, and a
    // billed line's object knows its customer before the next call.
    if (answer.ok && command === "add")
      for (const name of result.replaced ?? [])
        await lineObject(env, name).fetch(
          new Request("https://line/forget", { method: "POST" }),
        );
    if (answer.ok && command === "remove" && result.line)
      await lineObject(env, result.line.name).fetch(
        new Request("https://line/forget", { method: "POST" }),
      );
    if (answer.ok && command === "bill" && result.line)
      await toLine(env, result.line, "/update");
    return answer;
  }

  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === "/health") return new Response("ok");
      if (!ACCOUNT_SID.test(env.TWILIO_ACCOUNT_SID ?? ""))
        return new Response("TWILIO_ACCOUNT_SID is not set.", { status: 503 });
      if (path === "/line") return desk(request, env);
      if (path.startsWith("/twilio/media/")) {
        const name = path.slice("/twilio/media/".length);
        if (
          !LINE_NAME.test(name) ||
          request.headers.get("upgrade")?.toLowerCase() !== "websocket"
        )
          return new Response("Expected a WebSocket.", { status: 426 });
        // The object checks the one-time key in the stream's first message.
        return lineObject(env, name).fetch(
          new Request("https://line/media", {
            headers: { upgrade: "websocket" },
          }),
        );
      }
      if (request.method !== "POST")
        return new Response("Not found", { status: 404 });
      const command = /^\/admin\/(add|bill|remove|lines|alerts)$/.exec(path);
      if (command) return admin(request, env, command[1] as string);

      if (
        path === "/twilio/voice" ||
        path === "/twilio/status" ||
        path === "/twilio/dialed"
      ) {
        const form = await signedForm(request, env, path);
        if (!form) return new Response("Forbidden", { status: 403 });
        const line = await byNumber(env, form.To ?? "");
        const known = line && CALL_SID.test(form.CallSid ?? "");
        if (path === "/twilio/voice") {
          if (!known) return twiml(SORRY);
          return toLine(env, line, "/voice", form);
        }
        if (path === "/twilio/status") {
          if (!known) return new Response(null, { status: 204 });
          return toLine(env, line, "/status", form);
        }
        if (!known) return twiml("<Hangup/>");
        return toLine(env, line, "/dialed", form);
      }
      platform.log(`refused ${request.method} ${path.slice(0, 40)}`);
      return new Response("Not found", { status: 404 });
    },
  };
}
