import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { X509Certificate } from "node:crypto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createDatabase } from "../src/db/client";
import { officeNetwork } from "../src/db/schema";
import {
  fingerprintOf,
  makeOfficeCertificate,
} from "../src/office/certificate";
import { encodeJoinCode, parseJoinCode } from "../src/office/join-code";
import type { startRemoteHost } from "../src/office/remote-host";
import { officeCertificateRoutes, officeRoutes } from "../src/office/routes";
import {
  asOwnOrigin,
  createOfficeService,
  OFFICE_ROW,
  officeAddresses,
} from "../src/office/service";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The office network (Amgad, 24 Nov 2026, option A): the administrator's computer answers staff on
 * the office network over HTTPS with its own certificate, and a staff computer trusts that exact
 * certificate by the fingerprint in its join code, and nothing else.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const KEY = "Bm9xZm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmE=";
const servers: { stop: (force?: boolean) => void }[] = [];

const clear = async () => {
  await database.delete(officeNetwork).where(eq(officeNetwork.id, OFFICE_ROW));
};
beforeEach(clear);
afterEach(() => {
  for (const one of servers.splice(0)) one.stop(true);
});
afterAll(async () => {
  await clear();
  await database.$client.close();
});

function office(
  port = 0,
  hasAdministrator = async () => true,
  relay?: Parameters<typeof createOfficeService>[0]["relay"],
) {
  let opened = 0;
  const where: boolean[] = [];
  const service = createOfficeService({
    database,
    encryptionKey: KEY,
    port,
    hasAdministrator,
    addresses: () => ["192.168.1.20"],
    ...(relay ? { relay } : {}),
    listen: (tls, at) => {
      opened += 1;
      where.push(at.everywhere);
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port,
        tls,
        fetch: () => new Response("the company's ArkAgent"),
      });
      servers.push(server);
      return server;
    },
  });
  return { service, opened: () => opened, where };
}

test("the certificate is a real one, names the addresses, and its fingerprint is what the code says", () => {
  const made = makeOfficeCertificate({
    addresses: ["192.168.1.20", "not-an-address"],
    hostnames: ["maria-pc"],
  });
  const parsed = new X509Certificate(made.certificate);
  expect(parsed.subject).toBe("CN=ArkAgent office server");
  expect(parsed.subjectAltName).toBe("DNS:maria-pc, IP Address:192.168.1.20");
  // Self-signed: its own key signs it.
  expect(parsed.verify(parsed.publicKey)).toBe(true);
  expect(fingerprintOf(made.certificate)).toBe(made.fingerprint);
  expect(new Date(parsed.validTo).getTime()).toBeGreaterThan(
    Date.now() + 9 * 365 * 86_400_000,
  );
});

test("a join code reads back as it was written, and anything else is not one", () => {
  const code = {
    addresses: ["192.168.1.20", "10.0.0.5"],
    port: 52443,
    fingerprint: "a".repeat(64),
  };
  expect(parseJoinCode(encodeJoinCode(code))).toEqual(code);
  expect(parseJoinCode(` ${encodeJoinCode(code)}\n`)).toEqual(code);
  expect(parseJoinCode("hello")).toBeNull();
  expect(parseJoinCode("ARK-bm90IGpzb24")).toBeNull();
  expect(
    parseJoinCode(encodeJoinCode({ ...code, fingerprint: "short" })),
  ).toBeNull();
  expect(parseJoinCode(encodeJoinCode({ ...code, port: 0 }))).toBeNull();
});

test("only real network addresses are offered, the office's own ranges first, never loopback", () => {
  expect(
    officeAddresses({
      lo: [
        {
          address: "127.0.0.1",
          family: "IPv4",
          internal: true,
          netmask: "255.0.0.0",
          mac: "",
          cidr: null,
        },
      ],
      wifi: [
        {
          address: "203.0.113.7",
          family: "IPv4",
          internal: false,
          netmask: "255.255.255.0",
          mac: "",
          cidr: null,
        },
        {
          address: "192.168.1.20",
          family: "IPv4",
          internal: false,
          netmask: "255.255.255.0",
          mac: "",
          cidr: null,
        },
        {
          address: "fe80::1",
          family: "IPv6",
          internal: false,
          netmask: "ffff:ffff:ffff:ffff::",
          mac: "",
          cidr: null,
          scopeid: 1,
        },
      ],
    } as never),
  ).toEqual(["192.168.1.20", "203.0.113.7"]);
});

test("off until switched on; on, it answers over HTTPS that only its own certificate opens", async () => {
  const { service, opened } = office(0);
  expect(await service.status()).toMatchObject({
    enabled: false,
    listening: false,
    joinCode: null,
  });
  await service.start();
  expect(opened()).toBe(0);

  const on = await service.setEnabled(true);
  expect(on).toMatchObject({ enabled: true, listening: true, error: null });
  const code = parseJoinCode(on.joinCode ?? "");
  expect(code?.addresses).toEqual(["192.168.1.20"]);
  const pem = (await service.certificatePem()) ?? "";
  expect(fingerprintOf(pem)).toBe(code?.fingerprint ?? "");

  // The private key is kept sealed, never as it is.
  const [row] = await database.select().from(officeNetwork);
  expect(row?.sealedKey).not.toContain("PRIVATE KEY");

  const server = servers[0] as unknown as { port: number };
  const url = `https://127.0.0.1:${server.port}/`;
  const pinned = { ca: pem, checkServerIdentity: () => undefined };
  expect(await (await fetch(url, { tls: pinned } as never)).text()).toBe(
    "the company's ArkAgent",
  );
  // Anybody else's certificate, or none, is refused: nobody on the network can stand in for it.
  const stranger = makeOfficeCertificate({ addresses: [], hostnames: [] });
  const refused = await fetch(url, {
    tls: { ca: stranger.certificate, checkServerIdentity: () => undefined },
  } as never).then(
    () => "accepted",
    () => "refused",
  );
  expect(refused).toBe("refused");

  // Off again: the listener closes, and switching back on keeps the same certificate and code.
  expect(await service.setEnabled(false)).toMatchObject({
    enabled: false,
    listening: false,
    joinCode: null,
  });
  servers.splice(0);
  const again = await service.setEnabled(true);
  expect(parseJoinCode(again.joinCode ?? "")?.fingerprint).toBe(
    code?.fingerprint ?? "",
  );
  // And it comes back by itself after a restart, because the administrator left it on.
  service.stop();
  const restarted = office(0);
  await restarted.service.start();
  expect(restarted.opened()).toBe(1);
});

test("a port somebody else holds is said, not hidden", async () => {
  const holder = Bun.serve({ port: 0, fetch: () => new Response("") });
  servers.push(holder);
  const { service } = office(holder.port as number);
  const status = await service.setEnabled(true);
  expect(status.listening).toBe(false);
  expect(status.joinCode).toBeNull();
  expect(status.error).toContain("using the office network port");
  expect(status.port).toBe(holder.port as number);
});

test("only the administrator sees the join code or switches it; the certificate itself is public", async () => {
  const { service } = office(0);
  const as = (role: "admin" | "user") =>
    new Hono()
      .route(
        "/api/team/office",
        officeRoutes(async (context, next) => {
          context.set("actor" as never, { id: "u", role } as never);
          await next();
        }, service),
      )
      .route("/api/office/certificate", officeCertificateRoutes(service));
  const put = (app: Hono, enabled: unknown) =>
    app.request("/api/team/office", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
  expect((await put(as("user"), true)).status).toBe(403);
  expect((await as("user").request("/api/team/office")).status).toBe(403);
  expect((await put(as("admin"), "yes")).status).toBe(400);
  expect((await as("admin").request("/api/office/certificate")).status).toBe(
    404,
  );
  const on = await put(as("admin"), true);
  expect(on.status).toBe(200);
  expect((await on.json()).joinCode).toStartWith("ARK-");
  const cert = await as("user").request("/api/office/certificate");
  expect(await cert.text()).toContain("BEGIN CERTIFICATE");
});

test("a page served on the office network calls as the app itself; another site does not", () => {
  const own = asOwnOrigin(
    new Request("https://192.168.1.20:52443/api/auth/sign-in/email", {
      method: "POST",
      headers: {
        host: "192.168.1.20:52443",
        origin: "https://192.168.1.20:52443",
        referer: "https://192.168.1.20:52443/sign",
      },
    }),
    "http://localhost:52110",
  );
  expect(own.headers.get("origin")).toBe("http://localhost:52110");
  expect(own.headers.get("referer")).toBe("http://localhost:52110/sign");
  const other = asOwnOrigin(
    new Request("https://192.168.1.20:52443/api/x", {
      method: "POST",
      headers: { host: "192.168.1.20:52443", origin: "https://evil.example" },
    }),
    "http://localhost:52110",
  );
  expect(other.headers.get("origin")).toBe("https://evil.example");
  const handshake = new Request("https://192.168.1.20:52443/api/socket", {
    headers: {
      host: "192.168.1.20:52443",
      origin: "https://192.168.1.20:52443",
      upgrade: "websocket",
    },
  });
  expect(asOwnOrigin(handshake, "http://localhost:52110")).toBe(handshake);
});

test("never opens on the network before the administrator exists, whatever was saved", async () => {
  const first = office(0);
  await first.service.setEnabled(true);
  first.service.stop();
  // A restart on an install with no administrator (upgraded, not set up yet): it stays shut.
  const upgraded = office(0, async () => false);
  await upgraded.service.start();
  expect(upgraded.opened()).toBe(0);
  expect((await upgraded.service.status()).listening).toBe(false);
});

test("a request is known to have come over the office network by the listener that took it, not by a header", async () => {
  const { service } = office(0);
  await service.setEnabled(true);
  const listener = servers[0];
  expect(service.servedBy(listener)).toBe(true);
  expect(service.servedBy({})).toBe(false);
  expect(service.servedBy(undefined)).toBe(false);
  await service.setEnabled(false);
  expect(service.servedBy(listener)).toBe(false);
});

describe("remote staff through BlackArk's staff relay (v0.1.56)", () => {
  function relayed() {
    const started: {
      office: string;
      hostKey: string;
      accessKey: string;
      port: number | null;
    }[] = [];
    let stopped = 0;
    const forgotten: { office: string; hostKey: string }[] = [];
    let welcome = true;
    const relay = {
      url: "wss://blackark-staff.blackark.workers.dev",
      licence: async () => "ARK1-licence.signature",
      forget: async (_url: string, office: string, hostKey: string) => {
        forgotten.push({ office, hostKey });
        return true;
      },
      start: ((options: Parameters<typeof startRemoteHost>[0]) => {
        started.push({
          office: options.office,
          hostKey: options.hostKey,
          accessKey: options.accessKey,
          port: options.listenerPort(),
        });
        if (welcome) options.onWelcome?.();
        return {
          status: () => ({ connected: true, error: null }),
          stop: () => {
            stopped += 1;
          },
        };
      }) as typeof startRemoteHost,
    };
    return {
      relay,
      started,
      forgotten,
      stopped: () => stopped,
      noWelcome: () => {
        welcome = false;
      },
    };
  }

  test("until the relay has welcomed this office, the join code does not name it", async () => {
    const { relay, noWelcome } = relayed();
    noWelcome();
    const { service } = office(0, async () => true, relay);
    const status = await service.setRemote(true);
    expect(status.remote.enabled).toBe(true);
    expect(status.joinCode).toBeNull();
  });

  test("on alone, the listener answers on this computer only, and the code carries only the relay", async () => {
    const { relay, started } = relayed();
    const { service, where } = office(0, async () => true, relay);
    await service.setRemote(true);
    await Bun.sleep(20);
    const status = await service.status();
    expect(where).toEqual([false]);
    expect(status.remote).toEqual({
      available: true,
      enabled: true,
      connected: true,
      error: null,
    });
    expect(started).toHaveLength(1);
    const code = parseJoinCode(status.joinCode ?? "");
    expect(code?.addresses).toEqual([]);
    expect(code?.relay).toEqual({
      url: "wss://blackark-staff.blackark.workers.dev",
      office: started[0]?.office,
      key: started[0]?.accessKey,
    });
    // The keys are sealed, never kept in the clear.
    const [kept] = await database.select().from(officeNetwork);
    expect(kept?.sealedRelay).not.toContain(started[0]?.hostKey as string);
    expect(kept?.sealedRelay).not.toContain(started[0]?.accessKey as string);
  });

  test("with the office network on too, it answers on every network and the code carries both", async () => {
    const { relay } = relayed();
    const { service, where } = office(0, async () => true, relay);
    await service.setRemote(true);
    await Bun.sleep(20);
    const status = await service.setEnabled(true);
    expect(where).toEqual([false, true]);
    const code = parseJoinCode(status.joinCode ?? "");
    expect(code?.addresses).toEqual(["192.168.1.20"]);
    expect(code?.relay).toBeDefined();
    // Office network off again: back to this computer only, the relay still on.
    const after = await service.setEnabled(false);
    expect(where).toEqual([false, true, false]);
    expect(parseJoinCode(after.joinCode ?? "")?.addresses).toEqual([]);
  });

  test("a new join code starts a new office with new keys, and the relay forgets the old one", async () => {
    const { relay, started, forgotten } = relayed();
    const { service } = office(0, async () => true, relay);
    await service.setRemote(true);
    await Bun.sleep(20);
    const first = parseJoinCode((await service.status()).joinCode ?? "");
    await service.newJoinCode();
    await Bun.sleep(20);
    const second = parseJoinCode((await service.status()).joinCode ?? "");
    expect(forgotten).toEqual([
      {
        office: started[0]?.office as string,
        hostKey: started[0]?.hostKey as string,
      },
    ]);
    expect(second?.relay?.office).not.toBe(first?.relay?.office as string);
    expect(second?.relay?.key).not.toBe(first?.relay?.key as string);
    expect(started[1]?.hostKey).not.toBe(started[0]?.hostKey as string);
  });

  test("switching remote staff off makes the relay forget the office, and keeps no keys here", async () => {
    const { relay, started, forgotten } = relayed();
    const { service } = office(0, async () => true, relay);
    await service.setRemote(true);
    await service.setRemote(false);
    expect(forgotten.map((one) => one.office)).toEqual([
      started[0]?.office as string,
    ]);
    const [kept] = await database.select().from(officeNetwork);
    expect(kept).toMatchObject({
      relayOffice: null,
      sealedRelay: null,
      relayRegistered: false,
    });
  });

  test("never before an administrator exists, and off stops the relay and the listener", async () => {
    const { relay, started, stopped } = relayed();
    let admin = false;
    const { service, opened } = office(0, async () => admin, relay);
    await service.setRemote(true);
    expect(opened()).toBe(0);
    expect(started).toHaveLength(0);
    admin = true;
    await service.start();
    expect(started).toHaveLength(1);
    const status = await service.setRemote(false);
    expect(stopped()).toBe(1);
    expect(status.listening).toBe(false);
    expect(status.joinCode).toBeNull();
  });

  test("a build without the relay cannot switch it on", async () => {
    const { service } = office(0);
    expect((await service.status()).remote.available).toBe(false);
    await expect(service.setRemote(true)).rejects.toThrow();
  });
});
