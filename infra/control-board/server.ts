/**
 * The board's process: reads its settings from the environment (.env, mode 600, written by
 * deploy.sh), opens its SQLite file and serves HTTP on PORT behind Caddy, which holds the
 * certificate. Nothing is fetched until someone signed in opens a page.
 */
import { join } from "node:path";
import { createBoard } from "./board";
import {
  checkinExport,
  githubIssues,
  type HealthSource,
  relayHealth,
  stripeNotConnected,
} from "./sources";
import { openStore } from "./store";

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

const board = createBoard({
  db: openStore(join(dataDir, "board.sqlite")),
  publicOrigin: origin,
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
      repo: env.GITHUB_REPO ?? "amgadbarkat-ab/Ark-Agent",
      token: env.GITHUB_TOKEN || undefined,
    }),
    billing: stripeNotConnected,
  },
});

// Caddy is the only client. It puts the caller's address last in X-Forwarded-For; it is used for
// the sign-in limit only, in memory, and never stored.
const trustProxy = env.TRUST_PROXY === "1";
const server = Bun.serve({
  port: Number(env.PORT ?? 8080),
  maxRequestBodySize: 64 * 1024,
  fetch(request, server) {
    const forwarded = trustProxy
      ? request.headers.get("x-forwarded-for")?.split(",").pop()?.trim()
      : undefined;
    return board.fetch(
      request,
      forwarded || server.requestIP(request)?.address || "unknown",
    );
  },
});
console.log(`control-board: listening on ${server.port}`);
