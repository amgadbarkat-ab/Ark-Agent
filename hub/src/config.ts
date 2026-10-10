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
  /**
   * A port to serve `/metrics` on, separate from the one the API and sockets are on. Unset serves
   * none. The numbers are for whoever runs the service (see shared/metrics.ts).
   */
  metricsPort?: number;
  /**
   * How the process leaves when told to stop (shared/drain.ts): it keeps serving for `settleMs` while
   * the platform takes it out of rotation, stops listening, waits up to `graceMs` for requests under
   * way, then closes the sockets (browsers and runners reconnect to another hub and are caught up from
   * the log). Together they have to be less than the platform's own limit.
   */
  shutdown?: { settleMs: number; graceMs: number };
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
    ...metricsPort(env),
    shutdown: {
      settleMs: shutdownSeconds(env, "HUB_SHUTDOWN_SETTLE_SECONDS", 0) * 1000,
      graceMs: shutdownSeconds(env, "HUB_SHUTDOWN_GRACE_SECONDS", 8) * 1000,
    },
  };
}

function shutdownSeconds(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
) {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 600) {
    throw new HubConfigError(
      `${name} must be a whole number of seconds from 0 to 600.`,
    );
  }
  return value;
}

function metricsPort(env: Record<string, string | undefined>): {
  metricsPort?: number;
} {
  const raw = env.HUB_METRICS_PORT?.trim();
  if (!raw) return {};
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new HubConfigError(
      "HUB_METRICS_PORT must be a whole number between 1 and 65535.",
    );
  }
  if (value === positiveInteger(env, "HUB_PORT", 7100)) {
    throw new HubConfigError(
      "HUB_METRICS_PORT must not be the port the hub is served on.",
    );
  }
  return { metricsPort: value };
}
