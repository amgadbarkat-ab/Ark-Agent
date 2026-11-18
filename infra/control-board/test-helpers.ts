/**
 * For the tests: a board on a throwaway SQLite file with a fake clock and the stand-in sources, and
 * a small "browser" that keeps cookies and fills in the CSRF token the way a form would.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateDirectly, type PasswordHasher } from "./accounts";
import { createBoard, type Extension } from "./board";
import { standIns } from "./standins";
import { openStore, type Role } from "./store";
import { newTotpSecret, stepAt, totp } from "./totp";

/** bcrypt at its lowest cost, so the tests do not spend seconds in argon2id. Never in production. */
export const fastHasher: PasswordHasher = {
  hash: (password) =>
    Bun.password.hash(password, { algorithm: "bcrypt", cost: 4 }),
  verify: (password, hash) => Bun.password.verify(password, hash),
};

export const ORIGIN = "https://board.example";
export const START = Date.parse("2026-11-18T10:00:00.000Z");

export function testBoard(
  extensions?: (
    db: ReturnType<typeof openStore>,
    clock: { now: number },
  ) => Extension[],
) {
  const dir = mkdtempSync(join(tmpdir(), "control-board-"));
  const db = openStore(join(dir, "board.sqlite"));
  const clock = { now: START };
  const now = () => clock.now;
  const sources = standIns(now);
  const logs: string[] = [];
  const board = createBoard({
    db,
    sources,
    now,
    hasher: fastHasher,
    publicOrigin: ORIGIN,
    log: (line) => logs.push(line),
    extensions: extensions?.(db, clock),
  });
  const secrets = new Map<string, string>();
  async function addAccount(
    username: string,
    role: Role,
    password = "correct horse battery",
  ) {
    const secret = newTotpSecret();
    await activateDirectly(
      db,
      username,
      role,
      password,
      secret,
      -1,
      clock.now,
      fastHasher,
    );
    secrets.set(username, secret);
    return secret;
  }
  /** The next code the person's app would show, one step on from the last one used. */
  function code(username: string, offsetSteps = 0) {
    const secret = secrets.get(username);
    if (!secret) throw new Error(`no account ${username}`);
    return totp(secret, clock.now + offsetSteps * 30_000);
  }
  return {
    db,
    clock,
    sources,
    board,
    logs,
    addAccount,
    code,
    secrets,
    stepNow: () => stepAt(clock.now),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
    browser: () => new Browser(board),
  };
}

type BoardLike = { fetch(request: Request, ip?: string): Promise<Response> };

export class Browser {
  cookies = new Map<string, string>();
  ip = "203.0.113.7";
  constructor(private board: BoardLike) {}

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

  /** Posts a form; `csrf` is taken from the page given, as a browser submitting that page would. */
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

  /** Signs in through the login form. */
  async signIn(username: string, password: string, code: string) {
    const page = await this.get("/login");
    return this.post("/login", {
      csrf: Browser.csrfFrom(page.text),
      username,
      password,
      code,
    });
  }
}
