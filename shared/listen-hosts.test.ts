import { expect, test } from "bun:test";
import { listenHosts } from "./listen-hosts";

test("a comma-separated list, and nothing for every interface", () => {
  expect(listenHosts("127.0.0.1")).toEqual(["127.0.0.1"]);
  expect(listenHosts(" 127.0.0.1, ::1 ,")).toEqual(["127.0.0.1", "::1"]);
  expect(listenHosts("")).toEqual([]);
  expect(listenHosts(undefined)).toEqual([]);
});

test("a server told loopback answers there and nowhere else", async () => {
  const [host] = listenHosts("127.0.0.1");
  const server = Bun.serve({
    port: 0,
    hostname: host,
    fetch: () => new Response("ok"),
  });
  try {
    expect(server.hostname).toBe("127.0.0.1");
    expect(await (await fetch(`http://127.0.0.1:${server.port}/`)).text()).toBe(
      "ok",
    );
  } finally {
    server.stop(true);
  }
});
