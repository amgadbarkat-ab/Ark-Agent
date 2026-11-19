/**
 * The Workers phone relay's directory: one Durable Object, SQLite-backed (the only kind on the Free
 * plan). It holds every line (name, Twilio number, the line token's SHA-256, fallback number, billed
 * customer), and the blackark.uk outage state, so that BlackArk's internal alert goes once per
 * outage for the whole relay, not once per line. Alerts are recorded here, sent or not.
 *
 * Reached only from this Worker's own code (`index.ts` and the line objects), never from outside: a
 * Durable Object has no public address.
 */
import {
  ALERT_GAP_MS,
  CUSTOMER_ID,
  E164,
  LINE_NAME,
  type Line,
  outageAlert,
} from "../core";
import { type SmtpConfig, sendMailOver } from "../smtp";
import type { DurableObjectState, Env, Platform, SqlStorage } from "./types";

type LineRow = {
  name: string;
  number: string;
  token_sha256: string;
  fallback: string | null;
  customer: string | null;
};

function toLine(row: LineRow): Line {
  return {
    name: row.name,
    number: row.number,
    tokenSha256: row.token_sha256,
    ...(row.fallback ? { fallback: row.fallback } : {}),
    ...(row.customer ? { customerId: row.customer } : {}),
  };
}

export function validLine(value: unknown): value is Line {
  const line = value as Line;
  return Boolean(
    line &&
      typeof line.name === "string" &&
      LINE_NAME.test(line.name) &&
      typeof line.number === "string" &&
      E164.test(line.number) &&
      typeof line.tokenSha256 === "string" &&
      /^[0-9a-f]{64}$/.test(line.tokenSha256) &&
      (line.fallback === undefined ||
        (typeof line.fallback === "string" && E164.test(line.fallback))),
  );
}

/** A call from this Worker's code to an object, as JSON both ways. */
export async function call<T>(
  stub: { fetch(request: Request): Promise<Response> },
  path: string,
  body: unknown = {},
  headers: Record<string, string> = {},
): Promise<T> {
  const response = await stub.fetch(
    new Request(`https://object${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
  return (await response.json()) as T;
}

/** The mailbox BlackArk's alert is sent from, when every part of it is set. */
export function smtpFrom(env: Env): SmtpConfig | null {
  const to = (env.ALERT_TO ?? "")
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean);
  const user = env.ALERT_SMTP_USER?.trim() ?? "";
  const password = env.ALERT_SMTP_PASSWORD ?? "";
  if (!user || !password || to.length === 0) return null;
  return {
    host: env.ALERT_SMTP_HOST?.trim() || "send.one.com",
    port: Number(env.ALERT_SMTP_PORT || 465),
    user,
    password,
    from: env.ALERT_FROM?.trim() || user,
    to,
  };
}

export class DirectoryObject {
  private sql: SqlStorage;

  constructor(
    state: DurableObjectState,
    private env: Env,
    private platform: Platform,
  ) {
    this.sql = state.storage.sql;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS lines (name TEXT PRIMARY KEY, number TEXT NOT NULL UNIQUE, token_sha256 TEXT NOT NULL UNIQUE, fallback TEXT, customer TEXT)",
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS alerts (at INTEGER NOT NULL, subject TEXT NOT NULL, outcome TEXT NOT NULL)",
    );
  }

  private meta(key: string): string | undefined {
    return this.sql
      .exec<{ v: string }>("SELECT v FROM meta WHERE k = ?", key)
      .toArray()[0]?.v;
  }
  private setMeta(key: string, value: string | null) {
    if (value === null) this.sql.exec("DELETE FROM meta WHERE k = ?", key);
    else
      this.sql.exec(
        "INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)",
        key,
        value,
      );
  }

  private lines(where = "", ...bindings: unknown[]): Line[] {
    return this.sql
      .exec<LineRow>(`SELECT * FROM lines ${where} ORDER BY name`, ...bindings)
      .toArray()
      .map(toLine);
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    switch (path) {
      case "/by-number":
        return Response.json({
          line: this.lines("WHERE number = ?", String(body.number))[0] ?? null,
        });
      case "/by-token":
        return Response.json({
          line:
            this.lines("WHERE token_sha256 = ?", String(body.hash))[0] ?? null,
        });
      case "/lines":
        return Response.json({ lines: this.lines() });
      case "/add":
        return this.add(body.line);
      case "/bill":
        return this.bill(String(body.name), body.customerId);
      case "/remove": {
        const [line] = this.lines("WHERE name = ?", String(body.name));
        if (!line)
          return Response.json(
            { error: `There is no line called ${String(body.name)}.` },
            { status: 404 },
          );
        this.sql.exec("DELETE FROM lines WHERE name = ?", line.name);
        return Response.json({ ok: true, line });
      }
      case "/alerts":
        return Response.json({
          alerts: this.sql
            .exec<{ at: number; subject: string; outcome: string }>(
              "SELECT * FROM alerts ORDER BY at DESC LIMIT 20",
            )
            .toArray()
            .map((row) => ({ ...row, at: new Date(row.at).toISOString() })),
        });
      case "/billing-failed":
        await this.billingFailed();
        return Response.json({ ok: true });
      case "/billing-answered":
        if (this.meta("down")) {
          this.setMeta("down", null);
          this.platform.log("billing: blackark.uk answers again");
        }
        return Response.json({ ok: true });
      default:
        return new Response("Not found.", { status: 404 });
    }
  }

  /** Adds a line, or replaces the one with that name or number. Says which lines it replaced. */
  private add(value: unknown): Response {
    if (!validLine(value))
      return Response.json(
        {
          error:
            "A line is a name (2-40 lower-case letters, digits, hyphens), a +E.164 number, a token SHA-256 and an optional +E.164 fallback.",
        },
        { status: 400 },
      );
    const replaced = this.lines(
      "WHERE name = ? OR number = ? OR token_sha256 = ?",
      value.name,
      value.number,
      value.tokenSha256,
    ).map((line) => line.name);
    this.sql.exec(
      "DELETE FROM lines WHERE name = ? OR number = ? OR token_sha256 = ?",
      value.name,
      value.number,
      value.tokenSha256,
    );
    this.sql.exec(
      "INSERT INTO lines (name, number, token_sha256, fallback, customer) VALUES (?, ?, ?, ?, NULL)",
      value.name,
      value.number,
      value.tokenSha256,
      value.fallback ?? null,
    );
    return Response.json({ ok: true, replaced });
  }

  /**
   * Pays a line from a customer's prepaid balance, or stops ("none"). One billed line per customer:
   * each line's object keeps its own set-asides, and two objects could together spend past zero.
   */
  private bill(name: string, customer: unknown): Response {
    const [line] = this.lines("WHERE name = ?", name);
    if (!line)
      return Response.json(
        { error: `There is no line called ${name}.` },
        { status: 404 },
      );
    if (
      typeof customer !== "string" ||
      !(customer === "none" || CUSTOMER_ID.test(customer))
    )
      return Response.json(
        {
          error:
            "Give the ArkAgent customer id (lower-case letters, digits, hyphens), or none.",
        },
        { status: 400 },
      );
    if (customer !== "none") {
      const [other] = this.lines(
        "WHERE customer = ? AND name != ?",
        customer,
        name,
      );
      if (other)
        return Response.json(
          {
            error: `Line ${other.name} is already billed to ${customer}. On the Workers relay a customer pays for one line (so the balance cannot be spent twice); see README.md.`,
          },
          { status: 409 },
        );
    }
    this.sql.exec(
      "UPDATE lines SET customer = ? WHERE name = ?",
      customer === "none" ? null : customer,
      name,
    );
    return Response.json({
      ok: true,
      line: this.lines("WHERE name = ?", name)[0],
    });
  }

  /** blackark.uk failed to answer: the first time in an outage, BlackArk is told, at most hourly. */
  private async billingFailed() {
    if (this.meta("down")) return;
    this.setMeta("down", "1");
    this.platform.log("billing: blackark.uk is not answering");
    const now = Date.now();
    if (now - Number(this.meta("lastAlertAt") ?? 0) < ALERT_GAP_MS) return;
    this.setMeta("lastAlertAt", String(now));
    const alert = outageAlert(this.env.BILLING_URL, new Date(now));
    const outcome = await this.send(alert.subject, alert.body);
    this.sql.exec(
      "INSERT INTO alerts (at, subject, outcome) VALUES (?, ?, ?)",
      now,
      alert.subject,
      outcome,
    );
    this.platform.log(`billing: alert ${outcome}`);
  }

  /** The alert over SMTP (TLS from the first byte, port 465), or why it was not sent. */
  private async send(subject: string, body: string): Promise<string> {
    const smtp = smtpFrom(this.env);
    if (!smtp || !this.platform.connect)
      return "recorded only (no mailbox set up)";
    try {
      const socket = this.platform.connect(
        { hostname: smtp.host, port: smtp.port },
        { secureTransport: "on" },
      );
      await socket.opened;
      await sendMailOver(socket, smtp, subject, body);
      return "sent";
    } catch (error) {
      return `NOT SENT (${error instanceof Error ? error.message : String(error)})`;
    }
  }
}
