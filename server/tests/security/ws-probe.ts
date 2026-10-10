/**
 * One WebSocket join, in a process of its own, printing what came back.
 *
 *   bun ws-probe.ts <url> <topic> [<protocols, comma separated>]
 *
 * A separate process because the test runner preloads a DOM for the app's tests, which replaces the
 * `WebSocket` a test file sees; a client that behaves like a browser's is the point of these tests.
 * Prints `ok:` or `error:<reason>` for a join the server answered, or `closed` / `refused` / `timeout`.
 */
const [url, topic, protocols = ""] = process.argv.slice(2);
const socket = new WebSocket(
  url as string,
  protocols ? protocols.split(",") : [],
);
let finished = false;
const finish = (outcome: string) => {
  if (finished) return;
  finished = true;
  console.log(outcome);
  try {
    socket.close();
  } catch {
    // Already closed.
  }
  process.exit(0);
};
socket.onopen = () =>
  socket.send(JSON.stringify(["1", "1", topic, "phx_join", {}]));
socket.onmessage = (message) => {
  const frame = JSON.parse(String(message.data));
  if (frame[3] === "phx_reply") {
    finish(`${frame[4]?.status}:${frame[4]?.response?.reason ?? ""}`);
  }
};
socket.onclose = () => finish("closed");
socket.onerror = () => finish("refused");
setTimeout(() => finish("timeout"), 5000);
