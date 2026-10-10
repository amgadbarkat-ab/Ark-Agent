import { Hono } from "hono";
import { providerById } from "../../../shared/model-providers";
import type { ModelConnectionStore } from "./connections";
import { readModelGrant } from "./grant";

type GuardedFetch = (url: string, init?: RequestInit) => Promise<Response>;
type Dialect = "openai" | "anthropic";

/**
 * The only paths a bot may reach on a provider, by dialect.
 *
 * A list, not a pattern: the gateway forwards to an address a person chose, so it offers exactly the
 * calls a model run needs and nothing that could list, read or delete anything else the key can do.
 */
const ALLOWED: Record<
  Dialect,
  ReadonlyArray<{ method: string; path: string }>
> = {
  openai: [
    { method: "POST", path: "chat/completions" },
    { method: "POST", path: "responses" },
    { method: "GET", path: "models" },
  ],
  anthropic: [
    { method: "POST", path: "messages" },
    { method: "POST", path: "messages/count_tokens" },
    { method: "GET", path: "models" },
  ],
};

/** Large enough for a conversation with images in it; not for anything else. */
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;

/** The request headers a model call needs. Everything else, including cookies, is left behind. */
const FORWARD_REQUEST = ["content-type", "accept", "anthropic-beta"];
/** The answer headers worth passing back. No cookies, no encodings the runtime has already undone. */
const FORWARD_RESPONSE = [
  "content-type",
  "retry-after",
  "x-request-id",
  "request-id",
  "cache-control",
];

const ANTHROPIC_VERSION = "2023-06-01";

function problem(status: number, message: string) {
  return Response.json(
    { error: { message, type: "ark_gateway_error" } },
    { status },
  );
}

/** The grant, wherever the bot's SDK put it: a bearer token or Anthropic's own header. */
function grantFrom(request: Request): string | undefined {
  const bearer = request.headers.get("authorization");
  if (bearer?.toLowerCase().startsWith("bearer "))
    return bearer.slice(7).trim();
  return request.headers.get("x-api-key")?.trim() || undefined;
}

/**
 * Where the bots' model calls land.
 *
 * Not behind a person's session: the caller is a bot, and what it presents is a grant the server
 * minted for one person's connection. Everything about the connection is looked up here, on every
 * call, so the bot never holds an address or a key and removing a connection takes effect at once.
 */
export function modelGatewayRoutes(options: {
  store: ModelConnectionStore;
  encryptionKey: string;
  /** The guarded fetch: re-checks the address, and every redirect, at the moment of use. */
  fetchImpl: GuardedFetch;
}) {
  const { store, encryptionKey, fetchImpl } = options;
  const app = new Hono();

  async function forward(request: Request, dialect: Dialect, rest: string) {
    const route = ALLOWED[dialect].find(
      (entry) => entry.path === rest && entry.method === request.method,
    );
    if (!route) return problem(404, "That is not a model endpoint.");

    const grant = readModelGrant(grantFrom(request), encryptionKey);
    if (!grant) {
      return problem(
        401,
        "This model session has ended. Send your message again to start a new one.",
      );
    }

    let opened: Awaited<ReturnType<ModelConnectionStore["open"]>>;
    try {
      opened = await store.open(grant.actorId, grant.connectionId);
    } catch {
      return problem(
        502,
        "Your model connection could not be opened. Open Settings, then Models, and enter its key again.",
      );
    }
    if (!opened) {
      return problem(
        401,
        "That model connection no longer exists. Choose another in Settings, then Models.",
      );
    }
    const provider = providerById(opened.providerId);
    const speaks: Dialect | undefined =
      provider?.protocol === "anthropic"
        ? "anthropic"
        : provider?.protocol === "openai"
          ? "openai"
          : undefined;
    if (!provider || provider.unavailable || speaks !== dialect) {
      return problem(
        400,
        "That model connection does not speak this protocol.",
      );
    }

    const length = Number(request.headers.get("content-length") ?? 0);
    if (length > MAX_REQUEST_BYTES)
      return problem(413, "That request is too large.");
    const body =
      request.method === "GET" ? undefined : await request.arrayBuffer();
    if (body && body.byteLength > MAX_REQUEST_BYTES) {
      return problem(413, "That request is too large.");
    }

    const base = opened.baseUrl.replace(/\/+$/, "");
    const search = new URL(request.url).search;
    const target =
      dialect === "anthropic"
        ? `${base}/v1/${rest}${search}`
        : `${base}/${rest}${search}`;

    const headers = new Headers();
    for (const name of FORWARD_REQUEST) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    // The person's key goes on here, and only here. What the bot sent, the grant, goes no further.
    if (dialect === "anthropic") {
      headers.set(
        "anthropic-version",
        request.headers.get("anthropic-version") ?? ANTHROPIC_VERSION,
      );
      if (opened.apiKey) headers.set("x-api-key", opened.apiKey);
    } else if (opened.apiKey) {
      headers.set("authorization", `Bearer ${opened.apiKey}`);
    }

    let upstream: Response;
    try {
      upstream = await fetchImpl(target, {
        method: request.method,
        headers,
        ...(body ? { body } : {}),
        signal: request.signal,
      });
    } catch (error) {
      if (request.signal.aborted) return new Response(null, { status: 499 });
      const refused =
        error instanceof Error && error.name === "EndpointNotAllowedError";
      return problem(
        502,
        refused
          ? "This deployment will not contact that model address."
          : `Could not reach ${provider.name}. Check the connection in Settings, then Models.`,
      );
    }

    const out = new Headers();
    for (const name of FORWARD_RESPONSE) {
      const value = upstream.headers.get(name);
      if (value) out.set(name, value);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: out,
    });
  }

  app.all("/openai/v1/*", (context) =>
    forward(
      context.req.raw,
      "openai",
      new URL(context.req.url).pathname.replace(/^.*\/openai\/v1\//, ""),
    ),
  );
  app.all("/anthropic/v1/*", (context) =>
    forward(
      context.req.raw,
      "anthropic",
      new URL(context.req.url).pathname.replace(/^.*\/anthropic\/v1\//, ""),
    ),
  );
  return app;
}
