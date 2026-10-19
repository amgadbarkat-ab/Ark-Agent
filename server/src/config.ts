/**
 * What the runtime can do. There is exactly one answer because a conversation service (Ark Hub) is
 * required for durable threads and memory. Configuration the product cannot function without belongs
 * at the boot boundary.
 */

import { singleUserEnabled } from "./auth/dev-actor";
import { normalizeDomain } from "./auth/email-domain";
import { organizationAuthority } from "./auth/organization";
import type { ActionPolicy } from "./computer/policy";
import { parseActionPolicy } from "./computer/policy-store";
import { type CspMode, parseCspMode } from "./csp";
import {
  type TranscriptionConfig,
  transcriptionConfig,
} from "./dictation/config";
import {
  isAndroidAppId,
  isAppUrlScheme,
  isIosAppId,
  type MobileLinksConfig,
  normalizeFingerprint,
} from "./mobile/links";
import type { StarterModelConfig } from "./models/starter";
import { parseRequestLogMode, type RequestLogMode } from "./observability";
import { type VoiceConfig, voiceConfig } from "./voice/config";

export type RuntimeCapabilities = {
  mode: "intelligence";
  durableHistory: true;
  intelligence: IntelligenceSettings;
};

/**
 * The conversation-service contract (the names are historical: the SDK the server is built on reads
 * them). Three values are required; see runtimeCapabilities.
 *
 * `licenseToken` is optional and unused with Ark Hub. `@copilotkit/runtime` declares it optional with a
 * `COPILOTKIT_LICENSE_TOKEN` fallback of its own, and a deployment that still holds one keeps passing
 * it; nothing here requires it.
 */
export type IntelligenceSettings = {
  apiUrl: string;
  gatewayWsUrl: string;
  apiKey: string;
  licenseToken?: string;
};

export type DockerComputerConfig = {
  provider: "docker";
  baseUrl: string;
  supervisorToken?: string;
  token?: string;
  allowPrivateHosts: boolean;
  policy?: ActionPolicy;
};

export type SharedComputerConfig = {
  provider: "shared";
  baseUrl: string;
  token?: string;
  allowPrivateHosts: boolean;
  policy?: ActionPolicy;
};

/**
 * A computer each, created by the cluster.
 *
 * The namespace is the whole scope: the service account this runs under may manage Sandboxes there
 * and nowhere else, which is a smaller blast radius than the Docker supervisor's, since that one
 * holds a socket that is root-equivalent on its host.
 */
export type SandboxComputerConfig = {
  provider: "sandbox";
  namespace: string;
  idleAfterMs: number;
  /** Where the chart mounted the shape of a computer. */
  templateFile: string;
  token?: string;
  allowPrivateHosts: boolean;
  policy?: ActionPolicy;
};

export type ComputerConfig =
  | DockerComputerConfig
  | SharedComputerConfig
  | SandboxComputerConfig;

/**
 * Who a deployment lets in, and through which front door.
 *
 * One identity provider is a product decision somebody else already made. A company running this
 * has Google or Entra or Okta and is not going to acquire another, so the shape here is a set of
 * optional providers rather than one required one, and the deployment turns on whichever it has.
 */
export type AuthProviderId = "google" | "microsoft" | "okta";

/** An OAuth client, as every provider here needs one. */
export type OAuthClient = { clientId: string; clientSecret: string };

export type AuthConfig = {
  baseUrl: string;
  secret: string;
  trustedOrigins: string[];
  initialAdminEmails: string[];
  /**
   * Email domains this deployment admits, on top of whatever the provider decided.
   *
   * Empty means no opinion, which is what every deployment running today already does. See
   * `auth/email-domain.ts` for why the provider's own answer is not this question.
   */
  allowedEmailDomains: string[];
  google?: OAuthClient;
  /**
   * `tenantId` decides who may sign in at all, so it is not a detail. `common` admits any Microsoft
   * account including personal ones, `organizations` any work or school account anywhere, and a GUID
   * admits one directory. A deployment that wants only its own company needs the GUID.
   */
  microsoft?: OAuthClient & { tenantId: string };
  /** Okta is an OIDC provider rather than a named one, so it is identified by its issuer. */
  okta?: OAuthClient & { issuer: string };
};

/**
 * The providers this deployment can actually sign somebody in with.
 *
 * Ordered, and deliberately not alphabetically: this is the order the buttons appear in, and it is
 * fixed here rather than left to object key order so the sign-in screen cannot change shape because
 * of how a configuration happened to be written.
 */
export function configuredAuthProviders(
  auth: AuthConfig | undefined,
): AuthProviderId[] {
  if (!auth) return [];
  const providers: AuthProviderId[] = [];
  if (auth.google) providers.push("google");
  if (auth.microsoft) providers.push("microsoft");
  if (auth.okta) providers.push("okta");
  return providers;
}

export type ManagedAgentConfig = {
  /** The bundled Bot, absent when this deployment's provider cannot run it. */
  endpoint?: URL;
  /** Secret sent only to endpoints this deployment runs. Never stored in an agent row. */
  token: string;
  /**
   * The harness picked during setup, when there is one.
   *
   * Also an endpoint this deployment runs: its container was started by this deployment, on a port
   * it chose, holding this token. It gets the same header for the same reason.
   */
  alsoRun?: URL;
};

/**
 * How far one Bot handing work to another may go.
 *
 * NUMBERS A DEPLOYMENT CHOOSES, not constants. A small team and a company running this across
 * departments want different answers, and neither should have to edit code to get one.
 *
 * The defaults let a team lead plan and hand on, and still stop. A hop costs a whole agent turn at the
 * other end, fan-out shapes cost several times a single run because each Bot spends its own full
 * budget, and on a cluster a hop to a Bot whose computer is asleep also pays a pod resume. Depth and
 * width multiply, so the third number counts every hop one request of a person's causes.
 */
export type HandoffCaps = {
  /** How many Bots deep a chain may go. `0` switches the whole capability off. */
  maxDepth: number;
  /** How many other Bots one run may address. */
  maxPerRun: number;
  /**
   * How many hops everything that starts from one request of a person's may make, however deep or
   * wide it goes: the ceiling that stays true when the other two multiply.
   */
  maxPerRequest: number;
};

/** Where the app is served from on a developer's own machine, in every spelling a browser might use. */
export const LOCAL_APP_ORIGINS = [
  "http://127.0.0.1:3010",
  "http://[::1]:3010",
  "http://localhost:3010",
] as const;

/**
 * How running in Ark's cloud is treated by this deployment (decision D5, docs/ark/17-cloud-runtime.md).
 *
 * `included`: it is metered, so that cost is visible, and nobody is charged or asked. This is what a
 * company running Ark for itself wants, and what a hosted service is until it has measured its cost.
 * `metered`: an add-on. An account must switch it on, having been shown the rates, and sets a
 * monthly limit; usage is charged in arrears through the payment provider. `off`: no cloud runs.
 *
 * Nothing changes for a deployment that does not say: `included` is what every deployment has
 * effectively always been.
 */
export type CloudConfig = {
  mode: "included" | "metered" | "off";
  /** Persistent storage each coworker's computer holds, in bytes. Zero means storage is not metered. */
  volumeBytes: number;
  /** The monthly limit offered, in cents, when an account switches cloud running on. */
  defaultCapCents: number;
};

/**
 * The server's key pair for sending notifications to phones and browsers (Web Push, with VAPID).
 *
 * Generated once with `bun server/scripts/generate-vapid-keys.ts` and kept like any other secret: the
 * private key proves to Google's, Mozilla's and Apple's push services that a notification really came
 * from this server. The public half is given to browsers so they can subscribe to it.
 */
export type WebPushConfig = {
  publicKey: string;
  privateKey: string;
  /** A `mailto:` or `https:` address the push services can reach the operator at. */
  subject: string;
  /** Push services beyond Google's, Mozilla's, Apple's and Microsoft's, for a deployment that needs one. */
  allowedHosts: string[];
};

export type DeploymentConfig = {
  /**
   * The address scheme the iOS app is opened by (`name://`), where the system browser sends a person
   * back after signing in. Absent means the hand-off page does not exist. See auth/native-browser.ts.
   */
  appUrlScheme?: string;
  /**
   * The names that tie this site to its Android and iOS apps, published as the files those systems
   * ask for. Absent means there is no store app and neither file is served. See server/src/mobile.
   */
  mobileLinks?: MobileLinksConfig;
  /** Audio configuration is independent of agent model providers. */
  transcription?: TranscriptionConfig;
  voice?: VoiceConfig;
  /** The port the API listens on. Named `PORT` or `SERVER_PORT`; see `serverPort`. */
  port: number;
  databaseUrl: string;
  cloud: CloudConfig;
  /**
   * How hard the Content-Security-Policy is held to: `report-only` (the default) tells
   * `/api/csp-report` what would have been blocked and blocks nothing, `enforce` blocks, `off` sends
   * only `frame-ancestors`. See server/src/csp.ts.
   */
  contentSecurityPolicy: CspMode;
  /**
   * Whether customers have to accept the terms of service before using the app: `required`, or `off`
   * (the default). Left off until the text in docs/legal/terms-of-service.md is final, because asking
   * people to accept a draft records agreement to nothing. Acceptances are recorded whenever they are
   * offered either way. Staff are never asked.
   */
  termsAcceptance: "off" | "required";
  /**
   * Notifications to phones and browsers. Absent means none are sent and the app does not offer them.
   * See {@link WebPushConfig}.
   */
  webPush?: WebPushConfig;
  /**
   * Which requests get a log line: `errors` (the default) writes one for a request that failed (5xx)
   * or took long, `all` for every one, `off` for none. Numbers about every request are kept either
   * way. See server/src/observability.ts.
   */
  requestLog: RequestLogMode;
  /**
   * How the process leaves when it is told to stop (shared/drain.ts): it keeps serving for
   * `settleMs` while the platform takes it out of rotation, stops listening, waits up to `graceMs` for
   * requests under way (a reply being streamed is one), then closes what is left. The two together have
   * to be less than the platform's own limit, which the chart derives from them.
   */
  shutdown: { settleMs: number; graceMs: number };
  /**
   * Whether each audit event is also written to the process log as it happens: `log`, or `off` (the
   * default). The log goes where the application cannot rewrite it, which is what makes the trail
   * checkable against its table. It is a second copy of what the table holds, so turning it on is a
   * decision about where that data lives and for how long (docs/ark/14-data-protection.md).
   */
  auditShipping: "off" | "log";
  /**
   * A port to serve `/metrics` on, separate from the one the ingress points at. Unset serves none.
   * Where the numbers can be read from is for whoever runs the service, not for customers.
   */
  metricsPort?: number;
  keyEncryptionKey: string;
  /**
   * Keys that used to be `keyEncryptionKey`, kept only so what they sealed can still be read until
   * `server/scripts/rotate-encryption-key.ts` has re-sealed it under the current one. Never written
   * with. Empty except while a rotation is under way (docs/ark/13-azure-hosting.md).
   */
  previousKeyEncryptionKeys: string[];
  /**
   * Authentication for the bundled Bot and/or the installed picked harness.
   *
   * The bundled endpoint is optional: plan credentials can run a picked harness without it.
   * Its presence, not this auth configuration, determines whether a bundled Bot is available.
   */
  managedAgent?: ManagedAgentConfig;
  /**
   * Private addresses an agent may be registered at, named one at a time.
   *
   * WHY THIS EXISTS. `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS` is a floor, not a permission: it opens this
   * deployment's whole network, to browsing and to agent endpoints alike, which is why a production
   * deployment refuses to start with it on. That left bring-your-own-agent — a headline capability —
   * unusable in the image people are told to deploy, because a company's own agent legitimately lives
   * at an internal address and the only way to reach it was to drop the floor.
   *
   * So the address is named instead. Nothing else is opened, browsing is not widened, and the
   * never-allowed list is still checked first, so the metadata address cannot be named back in.
   * Empty by default, which is the same posture as before for anybody who does not set it.
   */
  agentEndpointAllowedHosts: ReadonlySet<string>;
  /**
   * What this deployment calls itself, when more than one shares an Intelligence project.
   *
   * Absent, the tenant package's id stands in, which separates deployments running different
   * packages but not a copy of one running alongside the original. See channels/thread-identity.ts.
   */
  deploymentId: string | undefined;
  /**
   * The key this deployment talks to Composio with, the broker that holds people's accounts for a
   * few hundred apps so a Bot can act in Gmail or Slack without an OAuth client of this
   * deployment's own registered with each of them.
   *
   * Optional, and undefined is the ordinary state rather than a degraded one. A deployment that has
   * not bought Composio is not a deployment missing something: there is nothing to connect, nothing
   * to grant and no Composio tool for a Bot to call, what remains on screen is one row that goes
   * nowhere under More apps on the admin Plugins page naming this variable, and nothing else it does
   * is any worse for that.
   *
   * Nothing here validates the key. There is no shape to check it against and no call worth making
   * at boot to find out, so the first real request is what says whether it works — which is also
   * where a key that was revoked last week would have surfaced regardless.
   */
  composioApiKey: string | undefined;
  /**
   * The free starter model this deployment offers to people who have not added a model of their own.
   *
   * Absent is the ordinary state and changes nothing: a person with no connection gets what they got
   * before. Present, it answers for them (docs/ark/22-starter-model.md). It is set by whoever runs the
   * deployment, never by a person, which is why it is exempt from the guard on addresses people type.
   */
  starterModel?: StarterModelConfig;
  /**
   * Where this deployment is reached from outside, with no trailing slash.
   *
   * Needed because an OAuth redirect URI has to match what an administrator registered with the
   * vendor character for character, and it is shown on the Plugins page for them to copy. Built from
   * configuration rather than from the incoming request: a redirect URI assembled out of a Host
   * header is one an attacker has a say in.
   *
   * `OPENBOT_PUBLIC_URL` when set, otherwise `BETTER_AUTH_URL`, which is the same public address for
   * every deployment that has real sign-in. Undefined only where neither exists, which is a local
   * deployment running without authentication — and there is nothing to connect there anyway.
   */
  publicUrl: string | undefined;
  /**
   * Where the browser app is served from, with no trailing slash.
   *
   * Separate from {@link DeploymentConfig.publicUrl} because they are genuinely two addresses: the
   * app is a Vite process on its own port locally, and the API is another. An OAuth callback lands on
   * the API and has to send the person back to a page, so a relative redirect would put them on the
   * API's origin, where no page exists.
   *
   * `OPENBOT_APP_URL` when set, otherwise the first `TRUSTED_ORIGINS` entry, which is already defined
   * as where the app is served from. Falls back to the API's own public URL, which is right for a
   * deployment serving both from one origin.
   */
  appUrl: string | undefined;
  tenantPackageDirectory: string;
  runtime: RuntimeCapabilities;
  /**
   * How long a Bot's stream may say nothing before this deployment ends the turn, in milliseconds.
   *
   * Zero means no watchdog, and an unset variable means zero. A turn that is ended is a turn
   * somebody loses, so a deployment that has not said it wants that gets the behaviour it already
   * had. `.env.example` ships a value, so a new clone starts with the watch on and an upgraded
   * deployment does not acquire it without being asked.
   */
  agentStallTimeoutMs: number;
  /**
   * How many days of audit trail this deployment keeps, or undefined to keep everything.
   *
   * Undefined by default. Deleting somebody's audit trail because a default said so is the worse of
   * the two failures, and a deployment that has not thought about retention should keep everything
   * until it has.
   */
  auditRetentionDays: number | undefined;
  oauth: {
    google?: { clientId: string; clientSecret: string };
  };
  auth?: AuthConfig;
  /** Customer OpenBot authority for employee desktop sessions, separate from Intelligence. */
  organizationAuthUrl?: string;
  /**
   * Admit everybody as one fixed administrator instead of requiring sign-in.
   *
   * True only when no identity provider is configured. See auth/dev-actor.ts for what stops this
   * reaching somewhere other people can get to.
   */
  singleUser: boolean;
  /** Names OpenBot on the analytics the runtime already sends. Off with OPENBOT_ACCESSIBILITY_DISABLED. */
  accessibility: boolean;
  /**
   * Whether a Bot may answer with an interface it wrote itself.
   *
   * This is not the component catalogue. A component is something this deployment holds: it was
   * either compiled into the build or authored in the playground, an administrator granted it to a
   * Bot, and all a Bot decides is which of them to draw. Here there is nothing to grant, because
   * there is nothing yet — the Bot writes the markup, the styles and the script for this one answer,
   * and they are gone when the conversation moves on.
   *
   * A deployment switch rather than a per-Bot grant because the SDK offers no seam for one. The
   * interface is painted from activity events that only the runtime middleware emits, and the tool
   * the model calls is registered by the browser for every Bot the moment that middleware is on.
   * Narrowing the middleware to some Bots would leave the rest able to call the tool and draw
   * nothing at all, which is a worse answer than never offering it.
   *
   * On by default. A deployment that cannot allow generated interfaces can explicitly opt out with
   * OPENBOT_GENERATIVE_UI=false or OPENBOT_GENERATIVE_UI=0.
   *
   * What it runs is sandboxed by the SDK, in an iframe with no same-origin access to this app, so a
   * generated interface reaches this deployment's data only through what the host hands it. This
   * deployment hands it nothing. It can load libraries from a CDN, which is the part a deployment
   * that must not reach the public internet from a browser tab needs to weigh.
   */
  generativeUi: boolean;
  /**
   * Where the built app is, when this process serves it.
   *
   * Set in a container image that carries both. Unset in development, where Vite serves the app and
   * proxies the API here, so the server stays an API and nothing shadows a route.
   */
  appDistDir?: string;
  /**
   * The Bot computer. Absent means the feature is off and its routes are not mounted, rather than
   * mounted and failing: a capability that is not configured should be missing, not broken.
   */
  computer?: ComputerConfig;
  /** How far one Bot handing work to another may go. */
  handoff: HandoffCaps;
  /**
   * The secret a Bot presents when it calls a tool back through this server.
   *
   * A framework Bot runs its own tool loop, in its own process, which is what makes it a real
   * harness rather than a shape the browser drives. It still may not reach a vendor directly: it
   * calls here, and here is where the grant, the policy and the audit row are. This is what tells
   * that call apart from anybody else on the network.
   *
   * Absent means no Bot may call tools back, and a deployment that wanted them gets a refusal rather
   * than an open door.
   */
  agentToolToken?: string;
  /**
   * The secret the worker presents when it hands a routine run back to this server.
   *
   * Absent means the internal routines endpoint refuses everything, which is the correct state of a
   * deployment with no worker — a deployment that has not asked for scheduled turns should not have a
   * door for them standing open.
   */
  workerSharedSecret?: string;
};

type Environment = Record<string, string | undefined>;

/**
 * The caps, read from the environment, refusing anything that is not a whole number at least zero.
 *
 * Refused rather than coerced. A cap is a safety number, and a deployment that typed `two` and got
 * the default would believe it had set one: the failure has to be at start-up where somebody is
 * looking, not at the first loop.
 */
function handoffCaps(environment: Environment): HandoffCaps {
  const read = (name: string, fallback: number): number => {
    const raw = optional(environment, name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${name} must be a whole number of zero or more`);
    }
    return value;
  };
  return {
    // A lead can plan a few steps and a colleague can pass one on, and nothing goes round for ever:
    // the third number is what stops depth and width multiplying into a bill nobody chose.
    maxDepth: read("BOT_HANDOFF_MAX_DEPTH", 5),
    maxPerRun: read("BOT_HANDOFF_MAX_PER_RUN", 3),
    maxPerRequest: read("BOT_HANDOFF_MAX_PER_REQUEST", 20),
  };
}

/**
 * The starter model, from `ARK_STARTER_MODEL_*`, or nothing when no address is set.
 *
 * A token with no address, or the other settings with no address, is a mistake worth stopping on: the
 * deployment would start and quietly not offer a model its operator thinks it offers.
 */
function starterModelConfig(
  environment: Environment,
): StarterModelConfig | undefined {
  const url = optionalHttpUrl(environment, "ARK_STARTER_MODEL_URL");
  if (!url) {
    const strays = [
      "ARK_STARTER_MODEL_TOKEN",
      "ARK_STARTER_MODEL_NAME",
      "ARK_STARTER_MODEL_CONCURRENCY",
      "ARK_STARTER_MODEL_MAX_WAIT_SECONDS",
    ].filter((name) => optional(environment, name) !== undefined);
    if (strays.length > 0) {
      throw new Error(
        `${strays.join(", ")} set without ARK_STARTER_MODEL_URL: set the address, or remove them.`,
      );
    }
    return undefined;
  }
  if (url.username || url.password) {
    throw new Error(
      "ARK_STARTER_MODEL_URL must not carry a username or password: use ARK_STARTER_MODEL_TOKEN.",
    );
  }
  if (url.protocol === "http:" && isProduction(environment)) {
    throw new Error(
      "ARK_STARTER_MODEL_URL must be https in production: the token and every prompt go over it.",
    );
  }
  const whole = (name: string, fallback: number, min: number, max: number) => {
    const raw = optional(environment, name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`${name} must be a whole number from ${min} to ${max}.`);
    }
    return value;
  };
  return {
    baseUrl: url.toString().replace(/\/+$/, ""),
    token: optional(environment, "ARK_STARTER_MODEL_TOKEN"),
    model: optional(environment, "ARK_STARTER_MODEL_NAME") ?? "gemma-4-e4b",
    // One answer at a time is right for the two-core machine the free tier gives; raise it for a bigger one.
    concurrency: whole("ARK_STARTER_MODEL_CONCURRENCY", 1, 1, 16),
    maxWaitMs: whole("ARK_STARTER_MODEL_MAX_WAIT_SECONDS", 120, 5, 900) * 1000,
  };
}

function required(environment: Environment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be configured`);
  }
  return value;
}

function optional(environment: Environment, name: string): string | undefined {
  return environment[name]?.trim() || undefined;
}

/**
 * Whether this deployment says it is in production, which is what the two hard refusals turn on.
 *
 * ONE PLACE, BECAUSE THE TWO GATES DID NOT AGREE. Both refuse a local-only setting on a deployed
 * server — the example encryption key, and private-host browsing — and both compare `NODE_ENV`
 * against `"production"`. The private-hosts gate read it through `optional`, so the comparison
 * trimmed; the key gate compared `environment.NODE_ENV` raw.
 *
 * Both sides of that comparison come out of the same file. `NODE_ENV=production ` with a trailing
 * space — invisible in an env file, and preserved verbatim by Docker's `env_file` and by every
 * hosting dashboard with a text box — therefore tripped one refusal and slipped past the other. The
 * one it slipped past is the one that decides whether the credential vault may be encrypted with a
 * key printed in this repository.
 *
 * A helper rather than a second `optional` call, so the next gate that needs this question cannot
 * pick the wrong way to ask it.
 */
function isProduction(environment: Environment): boolean {
  return optional(environment, "NODE_ENV") === "production";
}

/**
 * The key in `.env.example`, which every clone of this repository starts with.
 *
 * It is a valid key, which is the whole problem: it is the right length and the right encoding, so
 * nothing about it fails a check. A deployment that never changed it encrypts its credential vault
 * with a key printed in a public repository, and looks exactly like one that did.
 */
const PLACEHOLDER_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

function keyEncryptionKey(environment: Environment): string {
  const value = required(environment, "KEY_ENCRYPTION_KEY");
  const decoded = Buffer.from(value, "base64");

  if (decoded.byteLength !== 32 || decoded.toString("base64") !== value) {
    throw new Error("KEY_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }

  /**
   * Refused in production, warned everywhere else. The placeholder is convenient locally and public
   * in any deployment.
   */
  if (value === PLACEHOLDER_KEY) {
    if (isProduction(environment)) {
      throw new Error(
        "KEY_ENCRYPTION_KEY is still the example key from .env.example, which is public. Generate one with: openssl rand -base64 32",
      );
    }
    console.warn(
      "KEY_ENCRYPTION_KEY is the example key from .env.example, which is public. Fine locally. Generate a real one before deploying: openssl rand -base64 32",
    );
  }

  return value;
}

function cloudConfig(environment: Environment): CloudConfig {
  const mode = (optional(environment, "ARK_CLOUD_MODE") ?? "included")
    .trim()
    .toLowerCase();
  if (mode !== "included" && mode !== "metered" && mode !== "off") {
    throw new Error("ARK_CLOUD_MODE must be included, metered or off.");
  }
  const number = (name: string, fallback: number, max: number) => {
    const raw = optional(environment, name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > max) {
      throw new Error(`${name} must be a number between 0 and ${max}.`);
    }
    return value;
  };
  return {
    mode,
    volumeBytes: Math.round(
      number("ARK_CLOUD_VOLUME_GB", 0, 100_000) * 1024 ** 3,
    ),
    defaultCapCents: Math.round(
      number("ARK_CLOUD_DEFAULT_CAP_EUR", 20, 100_000) * 100,
    ),
  };
}

/**
 * The keys a rotation is moving away from: `KEY_ENCRYPTION_KEY_PREVIOUS`, one or more, separated by
 * commas or spaces (more than one when a rotation was started before the last one finished).
 *
 * Checked as strictly as the current key, and refused if it names the current one: that is the
 * mistake of someone who has not yet put the new key in, and starting then would seal new values
 * under a key they believe they are retiring.
 */
function previousKeyEncryptionKeys(environment: Environment): string[] {
  const raw = optional(environment, "KEY_ENCRYPTION_KEY_PREVIOUS");
  if (!raw) return [];
  const current = required(environment, "KEY_ENCRYPTION_KEY");
  const keys = raw.split(/[\s,]+/).filter((key) => key !== "");
  for (const key of keys) {
    const decoded = Buffer.from(key, "base64");
    if (decoded.byteLength !== 32 || decoded.toString("base64") !== key) {
      throw new Error(
        "KEY_ENCRYPTION_KEY_PREVIOUS must be one or more base64-encoded 32-byte keys, separated by commas",
      );
    }
    if (key === current) {
      throw new Error(
        "KEY_ENCRYPTION_KEY_PREVIOUS contains the current KEY_ENCRYPTION_KEY. Put the new key in KEY_ENCRYPTION_KEY and the old one here.",
      );
    }
  }
  return [...new Set(keys)];
}

/**
 * Whether this deployment may run with no sign-in at all.
 *
 * {@link singleUserEnabled} answers whether somebody ASKED for it, and the flag is how they say so.
 * That design is deliberate and stays: `single-user.test.ts` pins it, and the boot comment in
 * `.github/workflows/ci.yml` says the same thing in the same words. This asks the second question
 * the flag cannot answer, which is not "is this production" but "can anybody else reach it".
 *
 * NOT `NODE_ENV`. It looks like the signal and is not one here: `Dockerfile` sets
 * `NODE_ENV=production` for every container and `openbot.commonEnv` sets it for every chart
 * install, including the local trial the chart's own `validation.yaml` offers. Gating on it would
 * refuse a mode the chart advertises and would fail the image-boot job in CI, which runs exactly
 * this combination on purpose.
 *
 * The chart already asks the right question twice, and this is the same question moved to where a
 * deployment that never goes near Helm is also asked it:
 *
 *   config.singleUser + a LoadBalancer with no source ranges -> refused
 *   config.singleUser + config.publicUrl                     -> refused
 *
 * So: one administrator and no sign-in is a thing you run where only you can reach it. A public
 * URL, or a trusted origin that is not loopback, says somebody else can. `.env.example` ships the
 * flag on so a clone runs, and README's "Deploy it" hands that same `.env` to `docker run`; what
 * separates those two is an address, which is what this reads.
 */
function singleUserAllowed(
  environment: Environment,
  hasProvider: boolean,
): boolean {
  if (!singleUserEnabled(environment, hasProvider)) return false;

  const reachable = [
    optional(environment, "OPENBOT_PUBLIC_URL"),
    optional(environment, "OPENBOT_APP_URL"),
    ...commaSeparated(environment, "TRUSTED_ORIGINS"),
  ].filter((value): value is string => value !== undefined);

  const published = reachable.filter((value) => reachOf(value) === "public");
  if (published.length > 0) {
    throw new Error(
      `OPENBOT_SINGLE_USER admits every request as one administrator with no sign-in, so it cannot be combined with an address the public internet reaches: ${published.join(", ")}. Configure GOOGLE_OAUTH_*, MICROSOFT_OAUTH_* or OKTA_OAUTH_* with BETTER_AUTH_SECRET and BETTER_AUTH_URL, or serve it somewhere only you reach.`,
    );
  }

  /*
   * A private address is allowed and said out loud. index.ts already warns every boot that there is
   * no sign-in; what it cannot say, because it never reads an address, is that this one is carried
   * beyond the machine. Whoever is on that network is an administrator here.
   */
  const shared = reachable.filter((value) => reachOf(value) === "private");
  if (shared.length > 0) {
    console.warn(
      `OPENBOT_SINGLE_USER admits every request as one administrator with no sign-in, and this deployment answers on an address beyond this machine: ${shared.join(", ")}. Anybody on that network is that administrator. Configure a sign-in provider before anybody else is on it.`,
    );
  }

  return true;
}

/**
 * How far an address reaches, which is the question `OPENBOT_SINGLE_USER` actually turns on.
 *
 * Not two answers but three, because the middle one is most of the deployments this flag exists
 * for. "No sign-in, one administrator" is a thing people run on a home server at `192.168.1.10`,
 * over Tailscale at `100.something`, on a VPN, or at `openbot.local`. None of those is loopback and
 * none of them is a stranger's to reach, so refusing them would refuse the feature's own audience
 * while the operator's only recourse is to turn off the flag that describes what they are doing.
 *
 * A routable public address is the different thing, and it is the one that refuses.
 *
 * UNPARSEABLE COUNTS AS PUBLIC, and so does an unrecognised name. A value nobody could read is not
 * a value anybody checked, and the safe reading of "I cannot tell" is never "it is fine".
 */
type Reach = "loopback" | "private" | "public";

function reachOf(raw: string): Reach {
  let bare: string;
  try {
    bare = new URL(raw).hostname.toLowerCase();
  } catch {
    return "public";
  }
  bare = bare.replace(/^\[|\]$/g, "").replace(/\.+$/, "");

  if (
    bare === "localhost" ||
    bare === "::1" ||
    bare === "0:0:0:0:0:0:0:1" ||
    /^127\./.test(bare)
  ) {
    return "loopback";
  }

  if (bare.includes(":")) {
    // fc00::/7 is the unique local range and fe80::/10 the link-local one. Both are unroutable on
    // the public internet, which is the only property being asked about here.
    return /^f[cd]/.test(bare) || /^fe[89ab]/.test(bare) ? "private" : "public";
  }

  const octets = bare.split(".");
  if (octets.length === 4 && octets.every((part) => /^\d{1,3}$/.test(part))) {
    const [a, b] = octets.map(Number) as [number, number, number, number];
    const privateV4 =
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      // 169.254/16 is link-local, and 100.64/10 is the carrier-grade NAT range Tailscale hands out.
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127);
    return privateV4 ? "private" : "public";
  }

  // A name rather than an address. `.local` is mDNS, `.internal` and `.home.arpa` are reserved for
  // exactly this, and a single label with no dot at all is a LAN name that no public resolver
  // answers. Anything else is a name somebody could look up.
  const privateName =
    !bare.includes(".") ||
    bare.endsWith(".local") ||
    bare.endsWith(".internal") ||
    bare.endsWith(".lan") ||
    bare.endsWith(".home.arpa");
  return privateName ? "private" : "public";
}

function url(environment: Environment, name: string): string | undefined {
  const value = optional(environment, name);
  if (!value) {
    return undefined;
  }

  try {
    new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  return value;
}

function optionalHttpUrl(
  environment: Environment,
  name: string,
): URL | undefined {
  const value = optional(environment, name);
  if (!value) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTP(S) URL`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must be a valid HTTP(S) URL`);
  }

  return parsed;
}

/**
 * The Bot in the box, if this deployment has one.
 *
 * A URL with no token would send unauthenticated calls to a Bot that refuses them, so that half
 * alone refuses to start. A token with no URL is the leftover `scripts/start.sh` writes into
 * `.env`; it names nothing and is ignored, so a one-container image can boot from that file.
 */
function managedAgentConfig(
  environment: Environment,
): ManagedAgentConfig | undefined {
  const endpoint = optionalHttpUrl(environment, "MANAGED_AGENT_AG_UI_URL");
  // BYO writes a URL too, but does not run our image or hold our deployment token.
  const alsoRun = optional(environment, "PICKED_HARNESS_IMAGE")
    ? optionalHttpUrl(environment, "PICKED_HARNESS_URL")
    : undefined;
  const token = optional(environment, "MANAGED_AGENT_TOKEN");
  if (endpoint && !token) {
    throw new Error(
      "MANAGED_AGENT_TOKEN must be set when MANAGED_AGENT_AG_UI_URL is set",
    );
  }
  if (alsoRun && !token) {
    throw new Error(
      "MANAGED_AGENT_TOKEN must be set when an installed PICKED_HARNESS_URL is set",
    );
  }
  if ((!endpoint && !alsoRun) || !token) {
    return undefined;
  }
  /*
   * The harness somebody picked during setup is also an endpoint this deployment runs.
   *
   * It is a container this deployment started, on a port this deployment chose, holding the token
   * this deployment generated — the same relationship the Bot in the box has. It was not getting
   * the token because that was attached by matching one endpoint exactly, so the picked Bot was
   * registered, addressable, routed to, and answered every call with 401. Only visible by asking it
   * something in the window.
   */
  return {
    ...(endpoint ? { endpoint } : {}),
    token,
    ...(alsoRun ? { alsoRun } : {}),
  };
}

function oauthClient(
  environment: Environment,
  provider: "GOOGLE" | "MICROSOFT" | "OKTA",
): OAuthClient | undefined {
  const clientId = optional(environment, `${provider}_OAUTH_CLIENT_ID`);
  const clientSecret = optional(environment, `${provider}_OAUTH_CLIENT_SECRET`);

  // Both or neither. One alone is a half-configured sign-in that fails at the first attempt rather
  // than at start-up, which is the worst moment to discover it.
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    throw new Error(
      `${provider}_OAUTH_CLIENT_ID and ${provider}_OAUTH_CLIENT_SECRET must be set together`,
    );
  }

  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

function commaSeparated(environment: Environment, name: string): string[] {
  return (optional(environment, name) ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * Microsoft's three multi-tenant audiences, which name no directory.
 *
 * Anything else is a directory this deployment's administrators control, named by GUID or by a
 * verified domain. `organizations` matters as much as `common` here and is the one a hand-written
 * check forgets: Microsoft's own description is that it admits any work or school account in any
 * directory, so a domain allowlist is no more enforceable under it than under `common`.
 *
 * Compared folded, because these arrive from an environment variable and `Common` is the same
 * audience as `common` to Microsoft.
 */
const MULTI_TENANT_AUDIENCES = new Set([
  "common",
  "organizations",
  "consumers",
]);

export function namesNoDirectory(tenantId: string | undefined): boolean {
  return (
    tenantId !== undefined &&
    MULTI_TENANT_AUDIENCES.has(tenantId.trim().toLowerCase())
  );
}

/**
 * Sign-in, if this deployment has an identity provider to sign people in with.
 *
 * Any one of the three turns authentication on. More than one is allowed and is the normal shape
 * for a company mid-migration, where some people are on Entra and some are still on Okta.
 *
 * Every combination that cannot work refuses at start-up rather than at somebody's first attempt to
 * sign in, which is the worst moment to discover it: a provider with half its credentials, a
 * provider with no session secret to mint against, or a session secret configured with no provider
 * to use it.
 */
function authConfig(
  environment: Environment,
  google: OAuthClient | undefined,
): AuthConfig | undefined {
  const microsoft = microsoftAuth(environment);
  const okta = oktaAuth(environment);

  const secret = optional(environment, "BETTER_AUTH_SECRET");
  const baseUrl = url(environment, "BETTER_AUTH_URL");

  if (!google && !microsoft && !okta) {
    if (secret || baseUrl) {
      throw new Error(
        "BETTER_AUTH_SECRET or BETTER_AUTH_URL is set but no identity provider is. Configure GOOGLE_OAUTH_*, MICROSOFT_OAUTH_* or OKTA_OAUTH_*, or unset both",
      );
    }
    return undefined;
  }
  if (!secret) {
    throw new Error("Sign-in requires BETTER_AUTH_SECRET");
  }
  if (secret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must be at least 32 characters");
  }
  if (!baseUrl) {
    throw new Error("Sign-in requires BETTER_AUTH_URL");
  }

  /*
   * Somebody has to be an administrator, and only this says who.
   *
   * The role is written from this list and there is no route anywhere that changes one, so a
   * deployment that configures sign-in without it admits everybody as a plain user, shows nobody
   * the admin screens, and offers no way to promote anyone. Refusing at start-up is the only cheap
   * moment to catch that; the expensive one is after the first person has signed in.
   */
  const initialAdminEmails = commaSeparated(
    environment,
    "INITIAL_ADMIN_EMAILS",
  );
  if (initialAdminEmails.length === 0) {
    throw new Error(
      "Sign-in requires INITIAL_ADMIN_EMAILS naming at least one administrator. Nothing else grants the role, and no screen can promote somebody once the deployment is running",
    );
  }

  /**
   * Who may sign in, as distinct from who is an administrator once they have.
   *
   * Normalised through the same function the matcher uses, so a rule cannot mean one thing when
   * written and another when matched.
   */
  const namedDomains = commaSeparated(
    environment,
    "SIGNIN_ALLOWED_EMAIL_DOMAINS",
  );
  const allowedEmailDomains = namedDomains
    .map(normalizeDomain)
    .filter((domain): domain is string => domain !== undefined);

  /*
   * A list that names nothing is not an empty list, and the difference is every sign-in.
   *
   * `commaSeparated` drops blank entries BEFORE this normalisation rather than after it, so `@`,
   * `.` and `@.` each survive it and then normalise to nothing. That leaves a non-empty list no
   * address can ever match, every visitor refused at the door, and nothing said at boot. The same
   * reasoning INITIAL_ADMIN_EMAILS gives three lines up applies: start-up is the cheap moment to
   * catch it, and somebody's sign-in is the expensive one.
   */
  if (namedDomains.length > 0 && allowedEmailDomains.length === 0) {
    throw new Error(
      "SIGNIN_ALLOWED_EMAIL_DOMAINS is set but names no domain, so every sign-in would be refused. Write it as example.com,example.co.uk",
    );
  }

  /*
   * A list this deployment cannot enforce is worse than no list.
   *
   * `common` is multi-tenant, and OpenBot never sets `requireEmailVerification` or reads
   * `users.emailVerified`, so the address a rule is applied to is one the signing-in tenant's own
   * administrator wrote. Anybody may create a tenant. So an allowlist under `common` refuses the
   * honest and admits the rest, while reading on the Boundaries page as though it were a control.
   *
   * Refused rather than warned BECAUSE the operator has said what they want: they named domains.
   * The warning below is for the deployment that has said nothing, where multi-tenant may well be
   * the intent.
   */
  if (allowedEmailDomains.length > 0 && namesNoDirectory(microsoft?.tenantId)) {
    throw new Error(
      `SIGNIN_ALLOWED_EMAIL_DOMAINS names domains, but MICROSOFT_OAUTH_TENANT_ID is \`${microsoft?.tenantId}\`, which names no directory and admits accounts from any of them: the address the list is checked against is one the signing-in tenant writes for itself, so the list cannot hold. Set your directory GUID.`,
    );
  }

  /*
   * Nothing at all deciding who may sign in, on a deployment that is deployed. A warning rather
   * than a refusal, because a genuinely multi-tenant deployment is a real thing; arriving there by
   * setting nothing is the case worth naming.
   */
  if (
    isProduction(environment) &&
    allowedEmailDomains.length === 0 &&
    namesNoDirectory(microsoft?.tenantId)
  ) {
    console.warn(
      "MICROSOFT_OAUTH_TENANT_ID is unset, so it is `common` and any Microsoft account may sign in, including personal ones, and SIGNIN_ALLOWED_EMAIL_DOMAINS names no domain either. Set your directory GUID, or name the domains you admit.",
    );
  }

  /*
   * An administrator has to arrive through something that can vouch for their address.
   *
   * The role is granted by address, and a multi-tenant Microsoft sign-in takes the address from a
   * claim the signing-in tenant's own administrator writes: anybody can make a directory and put
   * `ceo@yourcompany.com` in it. So such a sign-in is never given the administrator role, however the
   * list reads (see auth/provider-trust.ts). A deployment whose only providers are of that kind could
   * therefore never have an administrator at all, which is worth saying while it is being started and
   * not when somebody first finds the admin screens missing.
   */
  if (
    isProduction(environment) &&
    !google &&
    !okta &&
    (!microsoft || namesNoDirectory(microsoft.tenantId))
  ) {
    console.warn(
      "No identity provider here can vouch for an address: Microsoft is multi-tenant (MICROSOFT_OAUTH_TENANT_ID is `common`, `organizations` or `consumers`) and neither Google nor Okta is configured. Nobody named in INITIAL_ADMIN_EMAILS will be made an administrator by signing in this way. Set your directory GUID as MICROSOFT_OAUTH_TENANT_ID, or register your own directory as an identity provider.",
    );
  }

  return {
    baseUrl,
    secret,
    trustedOrigins: commaSeparated(environment, "TRUSTED_ORIGINS").length
      ? commaSeparated(environment, "TRUSTED_ORIGINS")
      : /*
         * All three spellings of the same place, because this is an allowlist of what a browser
         * sends and not an address anything dials. `localhost` alone refused a browser pointed at
         * `127.0.0.1:3010`, which is the address the rest of this deployment hands out.
         */
        [...LOCAL_APP_ORIGINS],
    initialAdminEmails,
    allowedEmailDomains,
    ...(google ? { google } : {}),
    ...(microsoft ? { microsoft } : {}),
    ...(okta ? { okta } : {}),
  };
}

/**
 * Entra ID, and which directory it admits.
 *
 * `common` by default, matching Microsoft's own default, and said out loud in `.env.example` because
 * it admits personal Microsoft accounts as well as work ones. A company that means "our staff"
 * wants its directory GUID here.
 */
function microsoftAuth(
  environment: Environment,
): (OAuthClient & { tenantId: string }) | undefined {
  const client = oauthClient(environment, "MICROSOFT");
  if (!client) return undefined;
  return {
    ...client,
    tenantId: optional(environment, "MICROSOFT_OAUTH_TENANT_ID") ?? "common",
  };
}

/**
 * Okta, which is an OIDC provider rather than a named one.
 *
 * The issuer is what makes it a particular Okta rather than Okta in general, so it is required
 * alongside the credentials rather than defaulted to anything.
 */
function oktaAuth(
  environment: Environment,
): (OAuthClient & { issuer: string }) | undefined {
  const client = oauthClient(environment, "OKTA");
  const issuer = url(environment, "OKTA_OAUTH_ISSUER");
  if (!client) {
    if (issuer) {
      throw new Error(
        "OKTA_OAUTH_ISSUER is set but OKTA_OAUTH_CLIENT_ID and OKTA_OAUTH_CLIENT_SECRET are not",
      );
    }
    return undefined;
  }
  if (!issuer) {
    throw new Error(
      "Okta sign-in requires OKTA_OAUTH_ISSUER, such as https://example.okta.com/oauth2/default",
    );
  }
  return { ...client, issuer };
}

/**
 * Resolve the Intelligence contract, or refuse to start.
 *
 * The three addressing values are required together. A partial set is the more dangerous shape than
 * none at all: it means somebody intended to configure Intelligence and got it wrong, so failing on
 * the partial set alone (as this did) let a completely unconfigured deployment through as if that
 * were a choice.
 *
 * COPILOTKIT_LICENSE_TOKEN IS NO LONGER ONE OF THEM. Managed Intelligence issues a single project
 * key and derives entitlement from it, and requiring a second credential here sent people hunting
 * for a token the platform had stopped handing out. It is still read and still forwarded when a
 * deployment sets one, which is what a self-hosted Intelligence with its own licence needs.
 */
function runtimeCapabilities(environment: Environment): RuntimeCapabilities {
  const settings = {
    apiUrl: url(environment, "INTELLIGENCE_API_URL"),
    gatewayWsUrl: url(environment, "INTELLIGENCE_GATEWAY_WS_URL"),
    apiKey: optional(environment, "INTELLIGENCE_API_KEY"),
    licenseToken: optional(environment, "COPILOTKIT_LICENSE_TOKEN"),
  };

  const missing = Object.entries({
    INTELLIGENCE_API_URL: settings.apiUrl,
    INTELLIGENCE_GATEWAY_WS_URL: settings.gatewayWsUrl,
    INTELLIGENCE_API_KEY: settings.apiKey,
  })
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      `A conversation service is required and is not configured. Missing: ${missing.join(", ")}. Ark runs its own (Ark Hub, in hub/): scripts/hub.sh starts it locally and sets these for you, and the chart's hub.enabled runs it in a cluster.`,
    );
  }

  return {
    mode: "intelligence",
    durableHistory: true,
    intelligence: settings as IntelligenceSettings,
  };
}

/**
 * Whether a Bot may reach addresses inside this deployment's own network.
 *
 * Off unless asked for, and the asking is only allowed on a laptop. The switch exists so that a
 * local deployment can browse the services running beside it; what it turns off is not one rule but
 * the whole private-address floor, in navigation and in the endpoint a Bot may be registered
 * against, so with it on a signed-in person can point a Bot at a link-local address.
 *
 * Refused in production for the reason the example encryption key is: the way a deployment ends up
 * with it is not forgetting to set something, it is copying `.env.example`, which shipped it on. The
 * cloud metadata addresses are refused underneath this either way — see `computer/target.ts` — but
 * that floor is the last one, not the only one worth keeping.
 */
/**
 * The private addresses this deployment will let an agent be registered at.
 *
 * A comma-separated list of hosts, each optionally with a port: `agents.internal`,
 * `10.0.0.42:9000`. Matching is exact, so a name with a port pins that port and a name without one
 * covers any port on that host. No suffixes and no wildcards, because a pattern that widens by
 * accident is the usual way a host check fails, and naming three addresses is not onerous.
 *
 * A scheme or a path is a mistake worth catching here rather than at the first registration that
 * silently never matches, so both are refused with the offending entry named.
 */
function agentEndpointAllowedHosts(
  environment: NodeJS.ProcessEnv,
): ReadonlySet<string> {
  const named = commaSeparated(environment, "AGENT_ENDPOINT_ALLOWED_HOSTS");
  const hosts = new Set<string>();
  for (const entry of named) {
    const host = entry.trim().toLowerCase();
    if (!host) continue;
    if (host.includes("/") || host.includes("://")) {
      throw new Error(
        `AGENT_ENDPOINT_ALLOWED_HOSTS entry "${entry}" must be a host, optionally with a port, and not a URL.`,
      );
    }
    if (host.includes("*")) {
      throw new Error(
        `AGENT_ENDPOINT_ALLOWED_HOSTS entry "${entry}" must name one host. Patterns are not accepted: list each address instead.`,
      );
    }
    hosts.add(normalizeAllowedHost(entry, host));
  }
  return hosts;
}

/**
 * An IPv6 entry, spelled the way the endpoint check will see it.
 *
 * `namedAsAllowed` compares against `URL.hostname`, which the parser canonicalises: compressed,
 * lower-case, in brackets. An entry kept as written matched only when the operator happened to
 * write it that way, so `[0:0:0:0:0:0:0:1]:8443` was a line that silently never matched, which is
 * the failure the URL and wildcard refusals above exist to prevent. Stripping the brackets instead
 * folded two different names into one: `[::1]:8443`, an address and a port, and `[::1:8443]`, an
 * address, both became `::1:8443`, so naming either admitted the other.
 *
 * The address goes through the URL parser rather than a hand-written normaliser, so the spelling
 * here is the parser's own and cannot drift from it. The port is kept as written, since the parser
 * drops a scheme's default port and an operator who wrote `:80` meant that port. A bracketed entry
 * the parser refuses is not an address, and is refused the way a URL is: at boot, naming the entry.
 */
function normalizeAllowedHost(entry: string, host: string): string {
  if (!host.startsWith("[")) return host;
  const close = host.indexOf("]");
  const address = close === -1 ? host : host.slice(0, close + 1);
  const port = close === -1 ? "" : host.slice(close + 1);
  const refusal = () =>
    new Error(
      `AGENT_ENDPOINT_ALLOWED_HOSTS entry "${entry}" must be a host, optionally with a port, and not a URL.`,
    );
  if (port && !/^:\d{1,5}$/.test(port)) throw refusal();
  let hostname: string;
  try {
    hostname = new URL(`http://${address}`).hostname;
  } catch {
    throw refusal();
  }
  return `${hostname}${port}`;
}

function privateHostsAllowed(environment: Environment): boolean {
  if (optional(environment, "AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS") !== "true") {
    return false;
  }

  // Through `isProduction`, so the comparison trims. Read raw, `NODE_ENV="production "` out of an
  // env file would slip past a gate that the switch beside it, which does trim, would still trip.
  if (isProduction(environment)) {
    throw new Error(
      "AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS=true is for local development only: it lets a digital employee reach this deployment's own network. Remove it from this deployment's environment.",
    );
  }
  console.warn(
    "AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS=true lets a digital employee reach this machine's own services. Fine locally, and for local development only. Remove it before deploying.",
  );

  return true;
}

/**
 * A duration a person would write, as milliseconds.
 *
 * `30m` rather than `1800000`, because this one is read and edited by whoever is deciding how long a
 * computer may sit idle, and a wrong number of zeroes there is either a computer that never sleeps
 * or one that vanishes mid-task. Plain digits are still milliseconds, so anything already set keeps
 * its meaning.
 */
export function durationMs(value: string): number {
  const match = /^(\d+)\s*(ms|s|m|h)?$/i.exec(value.trim());
  if (!match) {
    throw new Error(
      `"${value}" is not a duration. Write it as 30s, 30m, 2h, or a plain number of milliseconds.`,
    );
  }
  const amount = Number(match[1]);
  switch (match[2]?.toLowerCase()) {
    case "h":
      return amount * 3_600_000;
    case "m":
      return amount * 60_000;
    case "s":
      return amount * 1_000;
    default:
      return amount;
  }
}

function computerConfig(environment: Environment): ComputerConfig | undefined {
  const supervisorAddress = optional(environment, "COMPUTER_SUPERVISOR_URL");
  const sharedAddress = optional(environment, "AGENT_COMPUTER_URL");
  const sandboxNamespace = optional(environment, "COMPUTER_SANDBOX_NAMESPACE");
  if (!supervisorAddress && !sharedAddress && !sandboxNamespace) {
    return undefined;
  }

  /*
   * The secret the computers require. Without it every call to a computer is refused, and that is the
   * intended failure: `agent-computer` drives a browser holding real logins and must not answer
   * unauthenticated callers that can reach its port.
   */
  const computerToken = optional(environment, "COMPUTER_TOKEN");

  const allowPrivateHosts = privateHostsAllowed(environment);
  const policy = actionPolicy(environment);

  /*
   * Checked before the other two, because a deployment that named a namespace means the cluster to
   * make the computers, and a stray `AGENT_COMPUTER_URL` left in an environment would otherwise
   * quietly put every Bot back on one shared browser.
   */
  if (sandboxNamespace) {
    return {
      provider: "sandbox",
      namespace: sandboxNamespace,
      idleAfterMs: durationMs(
        optional(environment, "COMPUTER_SANDBOX_IDLE_AFTER") ?? "30m",
      ),
      templateFile:
        optional(environment, "COMPUTER_SANDBOX_TEMPLATE_FILE") ??
        "/etc/openbot/sandbox-template.json",
      allowPrivateHosts,
      ...(computerToken ? { token: computerToken } : {}),
      ...(policy ? { policy } : {}),
    };
  }

  const supervisorUrl = url(environment, "COMPUTER_SUPERVISOR_URL");
  if (supervisorUrl) {
    const supervisorToken = optional(environment, "SUPERVISOR_TOKEN");
    return {
      provider: "docker",
      baseUrl: supervisorUrl,
      allowPrivateHosts,
      ...(supervisorToken ? { supervisorToken } : {}),
      ...(computerToken ? { token: computerToken } : {}),
      ...(policy ? { policy } : {}),
    };
  }

  const baseUrl = url(environment, "AGENT_COMPUTER_URL");
  if (!baseUrl) {
    return undefined;
  }

  return {
    provider: "shared",
    baseUrl,
    allowPrivateHosts,
    ...(computerToken ? { token: computerToken } : {}),
    ...(policy ? { policy } : {}),
  };
}

/**
 * The action policy, as JSON in one variable.
 *
 * Refuses to start on malformed JSON or a policy of the wrong shape, rather than falling back to the
 * default. An operator who wrote a rule and mistyped it would otherwise get a running deployment that
 * silently permits what they had just tried to forbid, and no indication that anything was wrong.
 * Configuration the product cannot honour belongs at the boot boundary; see the note at the top.
 */
function actionPolicy(environment: Environment): ActionPolicy | undefined {
  const raw = optional(environment, "AGENT_COMPUTER_POLICY");
  if (!raw) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("AGENT_COMPUTER_POLICY must be valid JSON");
  }

  const result = parseActionPolicy(parsed);
  if (!result.ok) {
    throw new Error(`AGENT_COMPUTER_POLICY is invalid: ${result.error}`);
  }
  return result.policy;
}

/**
 * How long silence on a Bot's stream is allowed to last.
 *
 * Refuses to start on anything that is not a whole number of milliseconds, rather than falling back
 * to the default. Same reasoning as the action policy above it: an operator who meant to write a
 * two-minute timeout and typed something else would otherwise get a running deployment with a
 * silently different boundary, and no indication that anything was wrong.
 *
 * Zero is a legitimate value and means off. It is not the same as a malformed one.
 */
function accessibilityEnabled(environment: Environment): boolean {
  const off = optional(environment, "OPENBOT_ACCESSIBILITY_DISABLED");
  return off !== "true" && off !== "1";
}

/**
 * Whether a Bot may draw an interface it wrote itself.
 *
 * Default-on, matching the product capability the browser can already render. Operators who cannot
 * allow generated interfaces can explicitly opt out. `false` is the documented spelling and `0` is
 * accepted alongside it as the conventional off value used by environment-driven switches.
 *
 * Anything else leaves the capability on. A typo should not silently become an opt-out, and the
 * capability must stay consistent between runtime and browser projection.
 *
 * The answer has to reach the browser as well as the runtime, which is why it ends up on
 * /api/capabilities rather than staying server-side. Enabling only the runtime half would leave the
 * browser never offering the tool; enabling only the browser half would have a Bot generate a whole
 * interface that nothing renders. See DeploymentConfig.generativeUi.
 */
function generativeUiEnabled(environment: Environment): boolean {
  const value = optional(environment, "OPENBOT_GENERATIVE_UI");
  return value !== "false" && value !== "0";
}

/**
 * How hard the Content-Security-Policy is held to, refused if it cannot be held without breaking the
 * product.
 *
 * Generated interfaces (and the components an administrator writes) run in a sandboxed frame built
 * from inline script, and a frame made that way inherits the page's policy. Enforcing a policy that
 * allows no inline script and no `eval` therefore stops every one of them drawing, silently. Watching
 * (`report-only`) is safe with them on, and is the default; enforcing needs them off, so the choice is
 * made on purpose instead of discovered by a customer. docs/ark/15-security-review.md (O3).
 */
function contentSecurityPolicyMode(environment: Environment): CspMode {
  const mode = parseCspMode(optional(environment, "CSP_MODE"));
  if (mode === "enforce" && generativeUiEnabled(environment)) {
    throw new Error(
      "CSP_MODE=enforce would stop generated interfaces and administrator-written components from drawing, because they run from inline script. Set OPENBOT_GENERATIVE_UI=false as well (and accept that those components then do not draw), or leave CSP_MODE at report-only.",
    );
  }
  return mode;
}

/**
 * Whether the terms of service have to be accepted. A word, not a flag, and anything else is refused:
 * "we thought we had turned it on" is the wrong way for a control like this to fail.
 */
function termsAcceptanceMode(environment: Environment): "off" | "required" {
  const value = optional(environment, "TERMS_ACCEPTANCE")?.trim().toLowerCase();
  if (value === undefined || value === "" || value === "off") return "off";
  if (value === "required") return "required";
  throw new Error(
    `TERMS_ACCEPTANCE must be "required" or "off" (it is "${value}").`,
  );
}

const base64urlBytes = (value: string): number[] | undefined => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    return [...Buffer.from(value, "base64url")];
  } catch {
    return undefined;
  }
};

/** `ARK_IOS_URL_SCHEME`: the scheme the iOS app is opened by, which is where sign-in returns to. */
function appUrlSchemeSetting(
  environment: Environment,
): { appUrlScheme: string } | Record<string, never> {
  const scheme = optional(environment, "ARK_IOS_URL_SCHEME");
  if (scheme === undefined) return {};
  if (!isAppUrlScheme(scheme)) {
    throw new Error(
      "ARK_IOS_URL_SCHEME is not an app's own address scheme: three to thirty-two lowercase letters, digits, dots, plus signs or hyphens, starting with a letter, and not one the system already uses (such as https).",
    );
  }
  return { appUrlScheme: scheme };
}

/**
 * `ARK_ANDROID_APP_ID` with `ARK_ANDROID_CERT_SHA256`, and `ARK_IOS_APP_ID`.
 *
 * The Android pair goes together: a package name with no fingerprint publishes a file Android will
 * refuse, and a fingerprint with no package names nothing. Each is checked against its own shape,
 * because the failure otherwise is a store app that opens in a browser tab and no sentence anywhere
 * saying that the file was wrong.
 */
function mobileLinksSetting(
  environment: Environment,
): { mobileLinks: MobileLinksConfig } | Record<string, never> {
  const androidId = optional(environment, "ARK_ANDROID_APP_ID");
  const fingerprints = commaSeparated(environment, "ARK_ANDROID_CERT_SHA256");
  const iosId = optional(environment, "ARK_IOS_APP_ID");
  const links: MobileLinksConfig = {};

  if (androidId !== undefined || fingerprints.length > 0) {
    if (androidId === undefined || fingerprints.length === 0) {
      throw new Error(
        "ARK_ANDROID_APP_ID and ARK_ANDROID_CERT_SHA256 go together: set both or neither.",
      );
    }
    if (!isAndroidAppId(androidId)) {
      throw new Error(
        "ARK_ANDROID_APP_ID is not an Android package name (letters, digits and underscores in dotted parts, such as com.example.ark).",
      );
    }
    const normalized = fingerprints.map(normalizeFingerprint);
    if (normalized.some((value) => value === undefined)) {
      throw new Error(
        "ARK_ANDROID_CERT_SHA256 holds a value that is not a SHA-256 fingerprint (32 bytes in hex, with or without colons). Several are separated by commas.",
      );
    }
    links.android = {
      appId: androidId,
      certFingerprints: [...new Set(normalized as string[])],
    };
  }
  if (iosId !== undefined) {
    if (!isIosAppId(iosId)) {
      throw new Error(
        "ARK_IOS_APP_ID is not an iOS app identifier: the ten-character team id, a dot, then the bundle identifier (such as ABCDE12345.com.example.ark).",
      );
    }
    links.ios = { appId: iosId };
  }
  return links.android || links.ios ? { mobileLinks: links } : {};
}

/**
 * `WEB_PUSH_VAPID_PUBLIC_KEY` and `WEB_PUSH_VAPID_PRIVATE_KEY`, both or neither.
 *
 * Refused when only one is set, or when either is not the shape a P-256 key has: a deployment that
 * thinks notifications are on and sends none is worse than one that refuses to start.
 */
function webPushSetting(
  environment: Environment,
  appUrl: string | undefined,
): { webPush: WebPushConfig } | Record<string, never> {
  const publicKey = optional(environment, "WEB_PUSH_VAPID_PUBLIC_KEY");
  const privateKey = optional(environment, "WEB_PUSH_VAPID_PRIVATE_KEY");
  if (publicKey === undefined && privateKey === undefined) return {};
  if (publicKey === undefined || privateKey === undefined) {
    throw new Error(
      "WEB_PUSH_VAPID_PUBLIC_KEY and WEB_PUSH_VAPID_PRIVATE_KEY go together: set both or neither.",
    );
  }
  const publicBytes = base64urlBytes(publicKey);
  if (publicBytes?.length !== 65 || publicBytes[0] !== 4) {
    throw new Error(
      "WEB_PUSH_VAPID_PUBLIC_KEY is not a push public key (65 bytes, base64url). Generate a pair with: bun server/scripts/generate-vapid-keys.ts",
    );
  }
  const privateBytes = base64urlBytes(privateKey);
  if (privateBytes?.length !== 32) {
    throw new Error(
      "WEB_PUSH_VAPID_PRIVATE_KEY is not a push private key (32 bytes, base64url). Generate a pair with: bun server/scripts/generate-vapid-keys.ts",
    );
  }
  const subject =
    optional(environment, "WEB_PUSH_SUBJECT") ??
    (appUrl?.startsWith("https://") ? appUrl : undefined);
  if (
    subject === undefined ||
    !(subject.startsWith("https://") || subject.startsWith("mailto:"))
  ) {
    throw new Error(
      "Web push needs WEB_PUSH_SUBJECT, a mailto: or https: address the push services can reach the operator at (it defaults to the app's https address).",
    );
  }
  return {
    webPush: {
      publicKey,
      privateKey,
      subject,
      allowedHosts: commaSeparated(environment, "WEB_PUSH_ALLOWED_HOSTS"),
    },
  };
}

/** `SHUTDOWN_SETTLE_SECONDS` and `SHUTDOWN_GRACE_SECONDS`: whole seconds, 0 to 600. */
function shutdownSetting(environment: Environment): {
  settleMs: number;
  graceMs: number;
} {
  const seconds = (name: string, fallback: number) => {
    const raw = optional(environment, name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > 600) {
      throw new Error(
        `${name} must be a whole number of seconds from 0 to 600`,
      );
    }
    return value;
  };
  return {
    settleMs: seconds("SHUTDOWN_SETTLE_SECONDS", 0) * 1000,
    graceMs: seconds("SHUTDOWN_GRACE_SECONDS", 8) * 1000,
  };
}

/** Whether the audit trail is copied to the log. A word, and anything else is refused. */
function auditShippingMode(environment: Environment): "off" | "log" {
  const value = optional(environment, "AUDIT_SHIPPING")?.trim().toLowerCase();
  if (value === undefined || value === "" || value === "off") return "off";
  if (value === "log") return "log";
  throw new Error(`AUDIT_SHIPPING must be "log" or "off" (it is "${value}").`);
}

/**
 * How long the audit trail is kept.
 *
 * Refused rather than coerced, like everything else here. "We accepted your retention policy but not
 * the one you wrote" is a bad answer about a control an auditor will ask to see, and a typo that
 * silently became 0 would delete the trail rather than keep it.
 */
function auditRetentionDays(environment: Environment): number | undefined {
  const raw = optional(environment, "AUDIT_RETENTION_DAYS");
  if (!raw) return undefined;

  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1) {
    throw new Error(
      "AUDIT_RETENTION_DAYS must be a whole number of days, at least 1. Leave it unset to keep the audit trail forever.",
    );
  }
  return days;
}

function agentStallTimeoutMs(environment: Environment): number {
  const raw = optional(environment, "AGENT_STALL_TIMEOUT_MS");
  if (!raw) {
    return 0;
  }

  const milliseconds = Number(raw);
  if (!Number.isInteger(milliseconds) || milliseconds < 0) {
    throw new Error(
      "AGENT_STALL_TIMEOUT_MS must be a whole number of milliseconds, or 0 to switch the watchdog off",
    );
  }
  return milliseconds;
}

/** Where the API listens when nothing says otherwise: what `.env.example` and the image ship. */
const DEFAULT_PORT = 3001;

/**
 * The port the API listens on, from either of its two names.
 *
 * `PORT` and `SERVER_PORT` name one number: either moves the server, and two that disagree are
 * refused at boot rather than half-applied. Read through `optional` like every other setting here,
 * and that is the point. An unset variable declared in a compose file, or left as `PORT=` in a
 * `.env`, arrives as an empty string rather than as absent, so `process.env.PORT ??
 * process.env.SERVER_PORT` never fell through to the second name, and `Number.parseInt("")` is
 * `NaN`. Given `NaN`, `Bun.serve` binds an ephemeral port: the server came up somewhere nobody had
 * asked for, `SERVER_PORT` ignored, and the script polling it reported a server that never
 * started — the failure #312 set out to remove, back through the other name.
 *
 * A value that is not a whole port number is refused for the reason the caps above are: `30o1`
 * used to start the server on port 30, and a typo has to fail where somebody is looking.
 */
/** `METRICS_PORT`, if set: a whole port number that is not the one the API is served on. */
function metricsPortSetting(environment: Environment): {
  metricsPort?: number;
} {
  const raw = optional(environment, "METRICS_PORT");
  if (raw === undefined) return {};
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error("METRICS_PORT must be a whole number between 1 and 65535");
  }
  if (value === serverPort(environment)) {
    throw new Error(
      "METRICS_PORT must not be the port the API is served on: the metrics are for whoever runs the service, and sharing the port would put them wherever the API is reachable.",
    );
  }
  return { metricsPort: value };
}

function serverPort(environment: Environment): number {
  const read = (name: string): number | undefined => {
    const raw = optional(environment, name);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      throw new Error(`${name} must be a whole number between 1 and 65535`);
    }
    return value;
  };
  const port = read("PORT");
  const serverPort = read("SERVER_PORT");
  if (port !== undefined && serverPort !== undefined && port !== serverPort) {
    throw new Error(
      `PORT (${port}) and SERVER_PORT (${serverPort}) disagree: set one or set both to the same value`,
    );
  }
  return port ?? serverPort ?? DEFAULT_PORT;
}

export function loadConfig(
  environment: Environment = process.env,
): DeploymentConfig {
  const google = oauthClient(environment, "GOOGLE");
  const auth = authConfig(environment, google);
  const organizationAuthValue = optional(
    environment,
    "OPENBOT_ORGANIZATION_AUTH_URL",
  );
  const organizationAuthUrl = organizationAuthValue
    ? organizationAuthority(organizationAuthValue)
    : undefined;
  const managedAgent = managedAgentConfig(environment);
  const starterModel = starterModelConfig(environment);
  const workerSharedSecret = optional(environment, "WORKER_SHARED_SECRET");
  const appUrl = (
    optional(environment, "OPENBOT_APP_URL") ??
    commaSeparated(environment, "TRUSTED_ORIGINS")[0] ??
    optional(environment, "OPENBOT_PUBLIC_URL") ??
    auth?.baseUrl
  )?.replace(/\/+$/, "");

  return {
    port: serverPort(environment),
    transcription: transcriptionConfig(environment),
    voice: voiceConfig(environment),
    databaseUrl: required(environment, "DATABASE_URL"),
    cloud: cloudConfig(environment),
    contentSecurityPolicy: contentSecurityPolicyMode(environment),
    termsAcceptance: termsAcceptanceMode(environment),
    ...webPushSetting(environment, appUrl),
    ...mobileLinksSetting(environment),
    ...appUrlSchemeSetting(environment),
    requestLog: parseRequestLogMode(optional(environment, "REQUEST_LOG")),
    auditShipping: auditShippingMode(environment),
    shutdown: shutdownSetting(environment),
    ...metricsPortSetting(environment),
    keyEncryptionKey: keyEncryptionKey(environment),
    previousKeyEncryptionKeys: previousKeyEncryptionKeys(environment),
    ...(managedAgent ? { managedAgent } : {}),
    agentEndpointAllowedHosts: agentEndpointAllowedHosts(environment),
    deploymentId: optional(environment, "DEPLOYMENT_ID"),
    composioApiKey: optional(environment, "COMPOSIO_API_KEY"),
    ...(starterModel ? { starterModel } : {}),
    publicUrl: (
      optional(environment, "OPENBOT_PUBLIC_URL") ?? auth?.baseUrl
    )?.replace(/\/+$/, ""),
    appUrl,
    tenantPackageDirectory:
      optional(environment, "TENANT_PACKAGE_DIR") ?? "../examples/fintech",
    runtime: runtimeCapabilities(environment),
    agentStallTimeoutMs: agentStallTimeoutMs(environment),
    auditRetentionDays: auditRetentionDays(environment),
    oauth: { google },
    auth,
    ...(organizationAuthUrl ? { organizationAuthUrl } : {}),
    /*
     * The authority short-circuits this, and that ordering is load-bearing: a white-label
     * deployment naming an external authority lets it win, and `singleUserAllowed` is never
     * reached and so cannot refuse a combination that already resolves.
     */
    singleUser:
      !organizationAuthUrl &&
      singleUserAllowed(environment, configuredAuthProviders(auth).length > 0),
    accessibility: accessibilityEnabled(environment),
    generativeUi: generativeUiEnabled(environment),
    ...(optional(environment, "APP_DIST_DIR")
      ? { appDistDir: optional(environment, "APP_DIST_DIR") as string }
      : {}),
    computer: computerConfig(environment),
    handoff: handoffCaps(environment),
    ...(optional(environment, "AGENT_TOOL_TOKEN")
      ? { agentToolToken: optional(environment, "AGENT_TOOL_TOKEN") as string }
      : {}),
    ...(workerSharedSecret ? { workerSharedSecret } : {}),
  };
}
