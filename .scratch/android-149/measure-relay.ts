/**
 * Rough memory of the relay with N desktops connected and idle (#149 hosting notes). Not a test:
 *   bun .scratch/android-149/measure-relay.ts 300
 */
import { createLinkRelay } from "../../infra/ark-link/relay";
import { newInstallToken, tokenHash } from "../../shared/ark-link";

const count = Number(process.argv[2] ?? 300);
const tokens = Array.from({ length: count }, () => newInstallToken());
const installs = await Promise.all(
  tokens.map(async (token, i) => ({
    id: `shop-${i}`,
    tokenSha256: await tokenHash(token),
  })),
);
const mb = () => Math.round(process.memoryUsage().rss / 1024 / 1024);
const before = mb();
const relay = createLinkRelay({
  linkOrigin: "https://link.example",
  installs: () => installs,
  log: () => undefined,
});
const server = Bun.serve({ port: 0, fetch: relay.fetch, websocket: relay.websocket });
const sockets: WebSocket[] = [];
for (const token of tokens) {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/_link/desk`, {
    headers: { authorization: `Bearer ${token}`, "ark-link-version": "1" },
  } as never);
  sockets.push(socket);
}
while (relay.connected.length < count) await Bun.sleep(20);
Bun.gc(true);
console.log(
  `process RSS ${before} MB before, ${mb()} MB with ${count} desktops connected (both ends in one process)`,
);
for (const socket of sockets) socket.close();
relay.stop();
server.stop(true);
process.exit(0);
