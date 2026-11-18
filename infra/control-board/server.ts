/**
 * The board's process: reads its settings from the environment (.env, mode 600, written by
 * deploy.sh), opens its SQLite file and serves HTTP on PORT, on the Docker network only. The
 * cloudflared container (Cloudflare Tunnel) is its only way in; there is no public port.
 * Nothing is fetched until someone signed in opens a page, except the support mailbox, read every
 * two minutes once it is set up.
 */
import { join } from "node:path";
import { cloudflareAccess } from "./access";
import { createBoard, type Extension } from "./board";
import { holidaysFrom } from "./business-hours";
import { casesExtension } from "./cases";
import { appIntake, pollMailbox, SUPPORT_ADDRESS } from "./intake";
import { imapflowConnect, imapMailbox, mailparserParse } from "./mail";
import {
  checkinExport,
  githubIssues,
  type HealthSource,
  relayHealth,
} from "./sources";
import { openStore } from "./store";
import { stripeNotConnected, stripeReadOnly } from "./stripe";

const env = process.env;
const dataDir = env.BOARD_DATA_DIR ?? "/data";
const origin = env.BOARD_PUBLIC_ORIGIN;
if (!origin?.startsWith("https://")) {
  console.error("BOARD_PUBLIC_ORIGIN must be the board's https:// address.");
  process.exit(1);
}
const exportSecret = env.CHECKIN_EXPORT_SECRET ?? "";
const notConnected: HealthSource = {
  check: async () => ({ up: null, detail: "not connected" }),
};

const db = openStore(join(dataDir, "board.sqlite"));
const calendar = { holidays: holidaysFrom(env.BOARD_HOLIDAYS) };
const githubRepo = env.GITHUB_REPO ?? "amgadbarkat-ab/Ark-Agent";
const extensions: Extension[] = [casesExtension(db, { githubRepo, calendar })];
// Help & support from the app, forwarded by blackark.uk: only with a secret, after Amgad's yes.
if ((env.INTAKE_SECRET ?? "").length >= 32) {
  extensions.push(
    appIntake(db, { secret: env.INTAKE_SECRET as string, calendar }),
  );
}

// Cloudflare Access's signed header: checked once both settings are there.
const access =
  env.CF_ACCESS_TEAM_DOMAIN && env.CF_ACCESS_AUD
    ? cloudflareAccess({
        teamDomain: env.CF_ACCESS_TEAM_DOMAIN,
        aud: env.CF_ACCESS_AUD,
      })
    : undefined;

const board = createBoard({
  db,
  extensions,
  publicOrigin: origin,
  access,
  sources: {
    checkins:
      exportSecret.length >= 32
        ? checkinExport({
            url:
              env.CHECKIN_EXPORT_URL ?? "https://blackark.uk/checkin/export/",
            secret: exportSecret,
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
      repo: githubRepo,
      token: env.GITHUB_TOKEN || undefined,
    }),
    billing: env.STRIPE_READ_KEY
      ? stripeReadOnly({ apiKey: env.STRIPE_READ_KEY })
      : stripeNotConnected,
  },
});

// The support mailbox: General@ over IMAP, taking only what was sent to support@.
if (env.MAIL_IMAP_HOST && env.MAIL_USER && env.MAIL_PASSWORD) {
  const supportAddress = env.SUPPORT_ADDRESS ?? SUPPORT_ADDRESS;
  const mailbox = imapMailbox(
    imapflowConnect({
      host: env.MAIL_IMAP_HOST,
      port: Number(env.MAIL_IMAP_PORT ?? 993),
      user: env.MAIL_USER,
      password: env.MAIL_PASSWORD,
    }),
    mailparserParse,
    { supportAddress },
  );
  let running = false;
  const poll = async () => {
    if (running) return;
    running = true;
    try {
      const touched = await pollMailbox(db, mailbox, Date.now(), {
        supportAddress,
        calendar,
      });
      if (touched.length)
        console.log(
          `control-board: support mail into cases ${touched.join(", ")}`,
        );
    } catch (error) {
      console.error(
        `control-board: the support mailbox could not be read: ${error instanceof Error ? error.name : "error"}`,
      );
      await mailbox.close();
    } finally {
      running = false;
    }
  };
  setInterval(poll, 2 * 60_000);
  void poll();
}

// cloudflared is the only client. Cloudflare puts the caller's address in Cf-Connecting-Ip; it is
// used for the sign-in limit only, in memory, and never stored.
const trustProxy = env.TRUST_PROXY === "1";
const server = Bun.serve({
  port: Number(env.PORT ?? 8080),
  hostname: env.BIND_HOST ?? "0.0.0.0",
  maxRequestBodySize: 128 * 1024,
  fetch(request, server) {
    const forwarded = trustProxy
      ? (
          request.headers.get("cf-connecting-ip") ??
          request.headers.get("x-forwarded-for")?.split(",").pop()
        )?.trim()
      : undefined;
    return board.fetch(
      request,
      forwarded || server.requestIP(request)?.address || "unknown",
    );
  },
});
console.log(`control-board: listening on ${server.port}`);
