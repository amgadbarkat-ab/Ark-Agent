/**
 * Ark Hub configuration.
 *
 * The hub refuses to start rather than run half-configured, the same stance the API server takes:
 * a missing secret here would mean conversations anyone can join.
 */
export interface HubConfig {
  port: number;
  databaseUrl: string;
  /** Presented as a bearer token by the API server and by its runner socket. */
  apiKey: string;
  /** Signs the short-lived tokens browsers use to join a conversation. */
  joinSecret: string;
  /** Lifetime of a join token, in seconds. */
  joinTokenTtlSeconds: number;
  /** Lock lifetime when the caller does not ask for one, in seconds. */
  defaultLockTtlSeconds: number;
  /**
   * How live events travel between sockets. `postgres` (the default) lets several hub processes share
   * them, so a runner on one and a browser on another still see each other; it costs one database
   * connection. `memory` keeps them inside one process and is only right for exactly one.
   */
  bus: "postgres" | "memory";
}

export class HubConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HubConfigError";
  }
}

const MIN_SECRET_LENGTH = 32;

function required(env: Record<string, string | undefined>, name: string) {
  const value = env[name]?.trim();
  if (!value) throw new HubConfigError(`${name} is required.`);
  return value;
}

function secret(env: Record<string, string | undefined>, name: string) {
  const value = required(env, name);
  if (value.length < MIN_SECRET_LENGTH) {
    throw new HubConfigError(
      `${name} must be at least ${MIN_SECRET_LENGTH} characters. Generate one with: openssl rand -base64 32`,
    );
  }
  return value;
}

function positiveInteger(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
) {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new HubConfigError(`${name} must be a positive integer.`);
  }
  return value;
}

function busMode(value: string | undefined): "postgres" | "memory" {
  const mode = (value ?? "postgres").trim().toLowerCase();
  if (mode !== "postgres" && mode !== "memory") {
    throw new HubConfigError("HUB_BUS must be postgres or memory.");
  }
  return mode;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): HubConfig {
  return {
    port: positiveInteger(env, "HUB_PORT", 7100),
    databaseUrl: env.HUB_DATABASE_URL?.trim() || required(env, "DATABASE_URL"),
    apiKey: secret(env, "HUB_API_KEY"),
    joinSecret: secret(env, "HUB_JOIN_SECRET"),
    joinTokenTtlSeconds: positiveInteger(
      env,
      "HUB_JOIN_TOKEN_TTL_SECONDS",
      86_400,
    ),
    defaultLockTtlSeconds: positiveInteger(
      env,
      "HUB_DEFAULT_LOCK_TTL_SECONDS",
      60,
    ),
    bus: busMode(env.HUB_BUS),
  };
}
