/**
 * For the tests: a board on a throwaway SQLite file (the stand-in for D1) with a fake clock and the
 * stand-in sources; a virtual passkey authenticator (WebCrypto P-256, as a phone or laptop would
 * hold); and a small "browser" that keeps cookies and fills in the CSRF token as a form would.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccessCheck } from "./access";
import { sha256 } from "./accounts";
import { createBoard, type Extension, type FirstFactor } from "./board";
import { refreshSources } from "./cron";
import type { Sql } from "./sql";
import { openLocalStore } from "./sql-sqlite";
import { standIns } from "./standins";
import type { Role } from "./store";
import { newTotpSecret, stepAt, totp } from "./totp";
import { toBase64Url } from "./webauthn";

export const ORIGIN = "https://board.example";
export const START = Date.parse("2026-11-18T10:00:00.000Z");

// ---- A tiny CBOR writer, for the authenticator's attestation -----------------------------------

type CborIn = number | string | Uint8Array | Map<CborIn, CborIn>;

function cborHead(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 256) return [(major << 5) | 24, n];
  return [(major << 5) | 25, n >> 8, n & 255];
}

export function encodeCbor(value: CborIn): Uint8Array {
  const out: number[] = [];
  const write = (item: CborIn) => {
    if (typeof item === "number")
      out.push(...(item >= 0 ? cborHead(0, item) : cborHead(1, -1 - item)));
    else if (typeof item === "string") {
      const bytes = new TextEncoder().encode(item);
      out.push(...cborHead(3, bytes.length), ...bytes);
    } else if (item instanceof Uint8Array)
      out.push(...cborHead(2, item.length), ...item);
    else {
      out.push(...cborHead(5, item.size));
      for (const [key, inner] of item) {
        write(key);
        write(inner);
      }
    }
  };
  write(value);
  return new Uint8Array(out);
}

function rawToDer(raw: Uint8Array): Uint8Array {
  const part = (bytes: Uint8Array) => {
    let at = 0;
    while (at < bytes.length - 1 && bytes[at] === 0) at++;
    let out = bytes.slice(at);
    if ((out[0] as number) & 0x80) out = new Uint8Array([0, ...out]);
    return [0x02, out.length, ...out];
  };
  const body = [...part(raw.slice(0, 32)), ...part(raw.slice(32))];
  return new Uint8Array([0x30, body.length, ...body]);
}

/** A passkey authenticator in memory: one ES256 credential, a signature counter. */
export class VirtualAuthenticator {
  credentialId = crypto.getRandomValues(new Uint8Array(16));
  signCount = 0;
  private keys: Promise<CryptoKeyPair> = crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  ) as Promise<CryptoKeyPair>;

  constructor(private origin = ORIGIN) {}

  get id(): string {
    return toBase64Url(this.credentialId);
  }

  async publicJwk(): Promise<JsonWebKey> {
    const jwk = await crypto.subtle.exportKey(
      "jwk",
      (await this.keys).publicKey,
    );
    return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
  }

  private async authData(rpId: string, attested: boolean): Promise<Uint8Array> {
    const rpIdHash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rpId)),
    );
    this.signCount += 1;
    const counter = [
      (this.signCount >>> 24) & 255,
      (this.signCount >>> 16) & 255,
      (this.signCount >>> 8) & 255,
      this.signCount & 255,
    ];
    const head = [...rpIdHash, attested ? 0x45 : 0x05, ...counter];
    if (!attested) return new Uint8Array(head);
    const jwk = await crypto.subtle.exportKey(
      "jwk",
      (await this.keys).publicKey,
    );
    const cose = encodeCbor(
      new Map<CborIn, CborIn>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, new Uint8Array(Buffer.from(jwk.x as string, "base64url"))],
        [-3, new Uint8Array(Buffer.from(jwk.y as string, "base64url"))],
      ]),
    );
    const id = this.credentialId;
    return new Uint8Array([
      ...head,
      ...new Uint8Array(16),
      id.length >> 8,
      id.length & 255,
      ...id,
      ...cose,
    ]);
  }

  private clientData(
    type: string,
    challenge: string,
    origin = this.origin,
  ): Uint8Array {
    return new TextEncoder().encode(
      JSON.stringify({ type, challenge, origin, crossOrigin: false }),
    );
  }

  /** What navigator.credentials.create would answer, as the form's hidden fields. */
  async register(
    publicKey: { challenge: string; rp: { id: string } },
    over: { origin?: string } = {},
  ) {
    const clientData = this.clientData(
      "webauthn.create",
      publicKey.challenge,
      over.origin,
    );
    const attestation = encodeCbor(
      new Map<CborIn, CborIn>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", await this.authData(publicKey.rp.id, true)],
      ]),
    );
    return {
      credentialId: this.id,
      clientDataJSON: toBase64Url(clientData),
      attestationObject: toBase64Url(attestation),
    };
  }

  /** What navigator.credentials.get would answer. */
  async signIn(
    publicKey: { challenge: string; rpId: string },
    over: { origin?: string; key?: CryptoKey } = {},
  ) {
    const clientData = this.clientData(
      "webauthn.get",
      publicKey.challenge,
      over.origin,
    );
    const authData = await this.authData(publicKey.rpId, false);
    const hash = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        clientData as Uint8Array<ArrayBuffer>,
      ),
    );
    const signed = new Uint8Array([...authData, ...hash]);
    const raw = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        over.key ?? (await this.keys).privateKey,
        signed,
      ),
    );
    return {
      credentialId: this.id,
      clientDataJSON: toBase64Url(clientData),
      authenticatorData: toBase64Url(authData),
      signature: toBase64Url(rawToDer(raw)),
    };
  }
}

// ---- The board under test ----------------------------------------------------------------------

export async function testBoard(
  extensions?: (sql: Sql, clock: { now: number }) => Extension[],
  options: { firstFactor?: FirstFactor; access?: AccessCheck } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "control-board-"));
  const sql = await openLocalStore(join(dir, "board.sqlite"));
  const clock = { now: START };
  const now = () => clock.now;
  const sources = standIns(now);
  const logs: string[] = [];
  const board = createBoard({
    sql,
    publicOrigin: ORIGIN,
    firstFactor: options.firstFactor ?? "passkey",
    access: options.access,
    now,
    log: (line) => logs.push(line),
    extensions: extensions?.(sql, clock),
  });
  const secrets = new Map<string, string>();
  const authenticators = new Map<string, VirtualAuthenticator>();
  /** The Cron Trigger's work: fetch every source into its snapshot. */
  const refresh = () => refreshSources(sql, sources, now);
  await refresh();

  /** An active account with a TOTP key and a passkey, as a finished setup link leaves it. */
  async function addAccount(
    username: string,
    role: Role,
    accessEmail: string | null = null,
  ) {
    const secret = newTotpSecret();
    const authenticator = new VirtualAuthenticator();
    const made = await sql.run(
      "INSERT INTO accounts (username, role, status, access_email, totp_secret, totp_last_step, created_at, created_by) VALUES (?, ?, 'active', ?, ?, -1, ?, 'test')",
      username,
      role,
      accessEmail,
      secret,
      new Date(clock.now).toISOString(),
    );
    await sql.run(
      "INSERT INTO passkeys (credential_id, account_id, public_key, algorithm, sign_count, created_at) VALUES (?, ?, ?, -7, 0, ?)",
      authenticator.id,
      made.lastRowId,
      JSON.stringify(await authenticator.publicJwk()),
      new Date(clock.now).toISOString(),
    );
    secrets.set(username, secret);
    authenticators.set(username, authenticator);
    return secret;
  }

  /** The code the person's app shows now. */
  function code(username: string, offsetSteps = 0) {
    const secret = secrets.get(username);
    if (!secret) throw new Error(`no account ${username}`);
    return totp(secret, clock.now + offsetSteps * 30_000);
  }

  return {
    sql,
    clock,
    sources,
    board,
    logs,
    refresh,
    addAccount,
    code,
    secrets,
    authenticators,
    stepNow: () => stepAt(clock.now),
    cleanup: () => {
      sql.close();
      rmSync(dir, { recursive: true, force: true });
    },
    browser: (): Browser => new Browser(board, authenticators),
    sha256,
  };
}

export type TestBoard = Awaited<ReturnType<typeof testBoard>>;

type BoardLike = { fetch(request: Request, ip?: string): Promise<Response> };

export class Browser {
  cookies = new Map<string, string>();
  ip = "203.0.113.7";
  /** Headers every request carries (Cloudflare Access's assertion, in Access tests). */
  extraHeaders: Record<string, string> = {};
  constructor(
    private board: BoardLike,
    private authenticators: Map<string, VirtualAuthenticator> = new Map(),
  ) {}

  private remember(response: Response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair = ""] = line.split(";");
      const index = pair.indexOf("=");
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (/Max-Age=0/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async request(
    path: string,
    init: Omit<RequestInit, "headers"> & {
      headers?: Record<string, string>;
    } = {},
  ) {
    const headers: Record<string, string> = {
      "sec-fetch-site": "same-origin",
      ...this.extraHeaders,
      ...(init.headers ?? {}),
    };
    if (this.cookies.size) {
      headers.cookie = [...this.cookies]
        .map(([name, value]) => `${name}=${value}`)
        .join("; ");
    }
    const response = await this.board.fetch(
      new Request(ORIGIN + path, { ...init, headers }),
      this.ip,
    );
    this.remember(response);
    return {
      response,
      status: response.status,
      text: await response.text(),
      location: response.headers.get("location"),
    };
  }

  get(path: string) {
    return this.request(path);
  }

  /** Posts a form, as a browser submitting that page would. */
  post(
    path: string,
    fields: Record<string, string>,
    headers: Record<string, string> = {},
  ) {
    return this.request(path, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: ORIGIN,
        ...headers,
      },
      body: new URLSearchParams(fields).toString(),
    });
  }

  static csrfFrom(page: string): string {
    return page.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
  }

  /** What webauthn.js does: ask for options, let the authenticator answer, send the form. */
  async passkeyForm(
    optionsPath: string,
    formPath: string,
    csrf: string,
    answer: (publicKey: never) => Promise<Record<string, string>>,
    fields: Record<string, string>,
  ) {
    const options = await this.post(optionsPath, { csrf });
    if (options.status !== 200) return options;
    const { challengeId, publicKey } = JSON.parse(options.text) as {
      challengeId: string;
      publicKey: never;
    };
    return this.post(formPath, {
      csrf,
      challengeId,
      ...(await answer(publicKey)),
      ...fields,
    });
  }

  /** Signs in: the named person's passkey, then their TOTP code. */
  async signIn(
    username: string,
    code: string,
    authenticator = this.authenticators.get(username),
  ) {
    const page = await this.get("/login");
    const csrf = Browser.csrfFrom(page.text);
    if (!authenticator) return this.post("/login", { csrf, code });
    return this.passkeyForm(
      "/login/options",
      "/login",
      csrf,
      (publicKey) => authenticator.signIn(publicKey),
      { code },
    );
  }

  /** Behind Access: the TOTP code only. */
  async signInWithCode(code: string) {
    const page = await this.get("/login");
    return this.post("/login", { csrf: Browser.csrfFrom(page.text), code });
  }
}
