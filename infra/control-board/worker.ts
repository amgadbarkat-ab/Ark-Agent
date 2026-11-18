/**
 * The board as a Cloudflare Worker (free plan): `fetch` serves the pages, `scheduled` runs the Cron
 * Triggers (wrangler.toml). Storage is D1 (`DB`); the nightly audit copy goes to R2 (`AUDIT_BUCKET`)
 * or to blackark.uk, as `AUDIT_COPY` says.
 *
 * Settings are plain vars in wrangler.toml; secrets are Worker secrets, set by COO with
 * `wrangler secret put NAME` (a hidden prompt), never in the repository or a chat.
 */
import { connect } from "cloudflare:sockets";
import { cloudflareAccess } from "./access";
import { createBoard, type Extension, type FirstFactor } from "./board";
import { holidaysFrom } from "./business-hours";
import { casesExtension } from "./cases";
import {
  type AuditCopy,
  blackarkCopy,
  nightly,
  r2Copy,
  refreshSources,
} from "./cron";
import { appIntake, pollMailbox, SUPPORT_ADDRESS } from "./intake";
import { imapMailbox, socketImap } from "./mail";
import {
  checkinExport,
  githubIssues,
  type HealthSource,
  relayHealth,
  type Sources,
} from "./sources";
import { d1Sql } from "./sql";
import { stripeNotConnected, stripeReadOnly } from "./stripe";
import type {
  D1Database,
  ExecutionContext,
  R2Bucket,
  ScheduledController,
} from "./workers";

export type Env = {
  DB: D1Database;
  AUDIT_BUCKET?: R2Bucket;
  // Vars (wrangler.toml).
  BOARD_PUBLIC_ORIGIN: string;
  FIRST_FACTOR?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  CHECKIN_EXPORT_URL?: string;
  RELAY_HEALTH_URL?: string;
  GITHUB_REPO?: string;
  SUPPORT_ADDRESS?: string;
  MAIL_IMAP_HOST?: string;
  MAIL_IMAP_PORT?: string;
  MAIL_USER?: string;
  BOARD_HOLIDAYS?: string;
  AUDIT_COPY?: string;
  AUDIT_COPY_URL?: string;
  // Secrets (`wrangler secret put`).
  CHECKIN_EXPORT_SECRET?: string;
  INTAKE_SECRET?: string;
  STRIPE_READ_KEY?: string;
  GITHUB_TOKEN?: string;
  MAIL_PASSWORD?: string;
  AUDIT_COPY_SECRET?: string;
};

const notConnected: HealthSource = {
  check: async () => ({ up: null, detail: "not connected" }),
};

function firstFactor(env: Env): FirstFactor {
  return env.FIRST_FACTOR === "access" ? "access" : "passkey";
}

function access(env: Env) {
  return env.CF_ACCESS_TEAM_DOMAIN && env.CF_ACCESS_AUD
    ? cloudflareAccess({
        teamDomain: env.CF_ACCESS_TEAM_DOMAIN,
        aud: env.CF_ACCESS_AUD,
      })
    : undefined;
}

export function sourcesFrom(env: Env): Sources {
  const secret = env.CHECKIN_EXPORT_SECRET ?? "";
  return {
    checkins:
      secret.length >= 32
        ? checkinExport({
            url:
              env.CHECKIN_EXPORT_URL ?? "https://blackark.uk/checkin/export/",
            secret,
          })
        : {
            load: async () => {
              throw new Error("not connected");
            },
          },
    relay: env.RELAY_HEALTH_URL
      ? relayHealth({ url: env.RELAY_HEALTH_URL })
      : notConnected,
    issues: githubIssues({
      repo: env.GITHUB_REPO ?? "amgadbarkat-ab/Ark-Agent",
      token: env.GITHUB_TOKEN || undefined,
    }),
    billing: env.STRIPE_READ_KEY
      ? stripeReadOnly({ apiKey: env.STRIPE_READ_KEY })
      : stripeNotConnected,
  };
}

function auditCopy(env: Env): AuditCopy | null {
  if (env.AUDIT_COPY === "r2" && env.AUDIT_BUCKET)
    return r2Copy(env.AUDIT_BUCKET);
  if (
    env.AUDIT_COPY === "blackark" &&
    env.AUDIT_COPY_URL &&
    (env.AUDIT_COPY_SECRET ?? "").length >= 32
  ) {
    return blackarkCopy({
      url: env.AUDIT_COPY_URL,
      secret: env.AUDIT_COPY_SECRET as string,
    });
  }
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const sql = d1Sql(env.DB);
    const calendar = { holidays: holidaysFrom(env.BOARD_HOLIDAYS) };
    const githubRepo = env.GITHUB_REPO ?? "amgadbarkat-ab/Ark-Agent";
    const extensions: Extension[] = [
      casesExtension(sql, { githubRepo, calendar }),
    ];
    if ((env.INTAKE_SECRET ?? "").length >= 32) {
      extensions.push(
        appIntake(sql, { secret: env.INTAKE_SECRET as string, calendar }),
      );
    }
    const board = createBoard({
      sql,
      publicOrigin: env.BOARD_PUBLIC_ORIGIN,
      firstFactor: firstFactor(env),
      access: access(env),
      extensions,
    });
    return board.fetch(
      request,
      request.headers.get("cf-connecting-ip") ?? "unknown",
    );
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    context: ExecutionContext,
  ): Promise<void> {
    const sql = d1Sql(env.DB);
    const now = Date.now;
    const log = (line: string) => console.log(line);
    if (controller.cron === "*/10 * * * *") {
      context.waitUntil(refreshSources(sql, sourcesFrom(env), now));
    } else if (controller.cron === "*/5 * * * *") {
      if (!env.MAIL_IMAP_HOST || !env.MAIL_USER || !env.MAIL_PASSWORD) return;
      const supportAddress = env.SUPPORT_ADDRESS ?? SUPPORT_ADDRESS;
      const mailbox = imapMailbox(
        socketImap(connect, {
          host: env.MAIL_IMAP_HOST,
          port: Number(env.MAIL_IMAP_PORT ?? 993),
          user: env.MAIL_USER,
          password: env.MAIL_PASSWORD,
        }),
        { supportAddress },
      );
      context.waitUntil(
        pollMailbox(sql, mailbox, now(), {
          supportAddress,
          calendar: { holidays: holidaysFrom(env.BOARD_HOLIDAYS) },
        })
          .catch((error: unknown) =>
            log(
              `control-board: the support mailbox could not be read: ${(error as Error)?.name}`,
            ),
          )
          .finally(() => mailbox.close()),
      );
    } else {
      context.waitUntil(nightly(sql, auditCopy(env), now, log));
    }
  },
};
