/**
 * The Workers relay's directory (#149): one Durable Object, SQLite-backed (the only kind on the Free
 * plan), holding the device routes, the pairing codes and pairings, and which installs are connected.
 * The logic is `../directory.ts`, the same as the Bun relay's; this is its store and its door.
 *
 * Reached only from this Worker's own code (`index.ts` and the install objects), never from outside:
 * a Durable Object has no public address.
 */
import type { DeskMessage, RelayMessage } from "../../../shared/ark-link";
import { Buckets, type DeviceRoute, limitsWith } from "../desk-link";
import { Directory, type DirectoryStore, type Pairing } from "../directory";
import type { DurableObjectState, Env, SqlStorage } from "./types";

export function sqlDirectoryStore(sql: SqlStorage): DirectoryStore {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS routes (hash TEXT PRIMARY KEY, id TEXT NOT NULL, install TEXT NOT NULL)",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS codes (code TEXT PRIMARY KEY, install TEXT NOT NULL, desk TEXT NOT NULL, expires INTEGER NOT NULL)",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS pairings (id TEXT PRIMARY KEY, install TEXT NOT NULL, name TEXT NOT NULL, expires INTEGER NOT NULL, state TEXT NOT NULL, token TEXT)",
  );
  type RouteRow = { hash: string; id: string; install: string };
  type PairingRow = {
    id: string;
    install: string;
    name: string;
    expires: number;
    state: Pairing["state"];
    token: string | null;
  };
  const route = (row: RouteRow): DeviceRoute => ({
    id: row.id,
    installId: row.install,
    tokenSha256: row.hash,
  });
  const pairing = (row: PairingRow): Pairing => ({
    installId: row.install,
    deviceName: row.name,
    expiresAt: row.expires,
    state: row.state,
    ...(row.token ? { token: row.token } : {}),
  });
  return {
    route: (hash) => {
      const [row] = sql
        .exec<RouteRow>("SELECT * FROM routes WHERE hash = ?", hash)
        .toArray();
      return row ? route(row) : undefined;
    },
    routesOf: (installId) =>
      sql
        .exec<RouteRow>("SELECT * FROM routes WHERE install = ?", installId)
        .toArray()
        .map(route),
    setRoute: (r) => {
      sql.exec(
        "INSERT OR REPLACE INTO routes (hash, id, install) VALUES (?, ?, ?)",
        r.tokenSha256,
        r.id,
        r.installId,
      );
    },
    deleteRoute: (hash) => {
      sql.exec("DELETE FROM routes WHERE hash = ?", hash);
    },
    allRoutes: () =>
      sql.exec<RouteRow>("SELECT * FROM routes").toArray().map(route),
    code: (code) => {
      const [row] = sql
        .exec<{ install: string; desk: string; expires: number }>(
          "SELECT install, desk, expires FROM codes WHERE code = ?",
          code,
        )
        .toArray();
      return row
        ? { installId: row.install, deskId: row.desk, expiresAt: row.expires }
        : undefined;
    },
    setCode: (code, w) => {
      sql.exec(
        "INSERT OR REPLACE INTO codes (code, install, desk, expires) VALUES (?, ?, ?, ?)",
        code,
        w.installId,
        w.deskId,
        w.expiresAt,
      );
    },
    deleteCode: (code) => {
      sql.exec("DELETE FROM codes WHERE code = ?", code);
    },
    codesOf: (installId) =>
      sql
        .exec<{ code: string }>(
          "SELECT code FROM codes WHERE install = ?",
          installId,
        )
        .toArray()
        .map((row) => row.code),
    pairing: (id) => {
      const [row] = sql
        .exec<PairingRow>("SELECT * FROM pairings WHERE id = ?", id)
        .toArray();
      return row ? pairing(row) : undefined;
    },
    setPairing: (id, p) => {
      sql.exec(
        "INSERT OR REPLACE INTO pairings (id, install, name, expires, state, token) VALUES (?, ?, ?, ?, ?, ?)",
        id,
        p.installId,
        p.deviceName,
        p.expiresAt,
        p.state,
        p.token ?? null,
      );
    },
    deletePairing: (id) => {
      sql.exec("DELETE FROM pairings WHERE id = ?", id);
    },
    expired: (now) => ({
      codes: sql
        .exec<{ code: string }>(
          "SELECT code FROM codes WHERE expires <= ?",
          now,
        )
        .toArray()
        .map((row) => row.code),
      pairings: sql
        .exec<PairingRow>("SELECT * FROM pairings WHERE expires <= ?", now)
        .toArray()
        .map((row) => [row.id, pairing(row)] as [string, Pairing]),
    }),
  };
}

const post = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });

/** Calls into the directory and the install objects, as plain POSTs between this Worker's own objects. */
export async function call<T>(
  stub: { fetch(request: Request): Promise<Response> },
  path: string,
  body: unknown,
): Promise<T> {
  const response = await stub.fetch(
    new Request(`https://do.internal${path}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
  return (await response.json()) as T;
}

export class DirectoryObject {
  private directory: Directory;
  private connected = new Set<string>();
  private claims: Buckets;
  private polls: Buckets;

  constructor(
    private state: DurableObjectState,
    private env: Env,
    private now: () => number = Date.now,
  ) {
    const sql = state.storage.sql;
    this.directory = new Directory(sqlDirectoryStore(sql), now);
    sql.exec("CREATE TABLE IF NOT EXISTS connected (install TEXT PRIMARY KEY)");
    for (const row of sql
      .exec<{ install: string }>("SELECT install FROM connected")
      .toArray())
      this.connected.add(row.install);
    const limits = limitsWith();
    this.claims = new Buckets(
      limits.claimsPerMinute,
      limits.claimsPerMinute,
      now,
    );
    this.polls = new Buckets(limits.pollsPerMinute, limits.pollsPerMinute, now);
  }

  private install(installId: string) {
    return this.env.INSTALL.get(this.env.INSTALL.idFromName(installId));
  }

  private async tell(installId: string, message: RelayMessage) {
    if (!this.connected.has(installId)) return;
    await call(this.install(installId), "/_internal/send", { message });
  }

  private async keepSweeping() {
    if ((await this.state.storage.getAlarm()) === null)
      await this.state.storage.setAlarm(this.now() + 60_000);
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      never
    >;
    switch (path) {
      case "/lookup":
        return post({ route: this.directory.lookup(body.hash) ?? null });
      case "/desk": {
        const installId = body.installId as string;
        if (body.connected) {
          this.connected.add(installId);
          this.state.storage.sql.exec(
            "INSERT OR REPLACE INTO connected (install) VALUES (?)",
            installId,
          );
        } else {
          this.connected.delete(installId);
          this.state.storage.sql.exec(
            "DELETE FROM connected WHERE install = ?",
            installId,
          );
          this.directory.forgetCodesOf(installId);
        }
        return post({ ok: true });
      }
      case "/start": {
        const started = this.directory.startPairing(
          body.installId,
          body.deskId,
        );
        await this.keepSweeping();
        return post(started);
      }
      case "/claim": {
        if (!this.claims.take(body.ip ?? "unknown"))
          return post({ ok: false, reason: "limited", status: 429 });
        const installId = this.directory.peek(body.code);
        if (!installId)
          return post({ ok: false, reason: "unknown", status: 404 });
        if (!this.connected.has(installId))
          return post({ ok: false, reason: "offline", status: 503 });
        const answer = this.directory.claim(body.code, body.deviceName);
        if (answer.ok) {
          await this.tell(installId, {
            t: "pair.claimed",
            pairingId: answer.pairingId,
            deviceName: body.deviceName,
            expiresAt: new Date(answer.expiresAt).toISOString(),
          });
          await this.keepSweeping();
        }
        return post(answer);
      }
      case "/status": {
        if (!this.polls.take(body.ip ?? "unknown"))
          return post({
            status: "refused",
            reason: "limited",
            httpStatus: 429,
          });
        const answer = this.directory.status(body.pairingId);
        if (answer.status === "refused" && answer.ended)
          await this.tell(answer.ended.installId, {
            t: "pair.ended",
            pairingId: answer.ended.pairingId,
            reason: answer.ended.reason,
          });
        return post(answer);
      }
      case "/confirm":
        return post({
          ok: await this.directory.confirm(
            body.installId,
            body.message as Extract<DeskMessage, { t: "pair.confirm" }>,
          ),
        });
      case "/refuse":
        this.directory.refuse(body.installId, body.pairingId);
        return post({ ok: true });
      case "/sync":
        return post({
          kept: [...this.directory.syncDevices(body.installId, body.devices)],
        });
      default:
        return new Response("Not found.", { status: 404 });
    }
  }

  /** Expired codes and pairings, once a minute while there are any. */
  async alarm() {
    for (const ended of this.directory.sweep())
      await this.tell(ended.installId, {
        t: "pair.ended",
        pairingId: ended.pairingId,
        reason: ended.reason,
      });
    const left = this.state.storage.sql
      .exec<{ n: number }>(
        "SELECT (SELECT COUNT(*) FROM codes) + (SELECT COUNT(*) FROM pairings) AS n",
      )
      .toArray()[0]?.n;
    if (left) await this.state.storage.setAlarm(this.now() + 60_000);
  }
}
