import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { startBunRelay } from "./bun-runtime";
import { CLOSE, checkLicence, sha256Hex } from "./relay";

const licenceKeys = generateKeyPairSync("ed25519");
const trialKeys = generateKeyPairSync("ed25519");
const otherKeys = generateKeyPairSync("ed25519");
const raw = (key: typeof licenceKeys.publicKey) =>
  Buffer.from(
    key.export({ format: "der", type: "spki" }).subarray(12),
  ).toString("base64");
const keys = {
  license: [raw(licenceKeys.publicKey)],
  trial: [raw(trialKeys.publicKey)],
};

function code(
  body: Record<string, unknown>,
  privateKey = licenceKeys.privateKey,
): string {
  const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
  const signature = sign(null, Buffer.from(payload), privateKey).toString(
    "base64url",
  );
  return `ARK1-${payload}.${signature}`;
}
const inAYear = new Date(Date.now() + 365 * 86_400_000).toISOString();
const licence = code({
  v: 1,
  action: "license",
  customer: "demo-shop",
  nonce: "n1",
  issuedAt: new Date().toISOString(),
  plan: "ark-team",
  seats: 1,
  validUntil: inAYear,
});

const office = "office-id-for-tests-0123456789";
const hostKey = "host-key-for-tests-0123456789abcdef";
const accessKey = "access-key-for-tests-0123456789abc";

let relay: ReturnType<typeof startBunRelay>;
const sockets: WebSocket[] = [];
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close();
  relay?.stop();
});

type Opened = {
  socket: WebSocket;
  texts: string[];
  bytes: Uint8Array[];
  closed: Promise<{ code: number; reason: string }>;
};

function open(
  route: string,
  headers: Record<string, string>,
  query = "",
): Opened {
  const socket = new WebSocket(
    `${relay.url}/v1/${route}?office=${office}${query}`,
    { headers } as never,
  );
  socket.binaryType = "arraybuffer";
  sockets.push(socket);
  const texts: string[] = [];
  const bytes: Uint8Array[] = [];
  socket.onmessage = (event) => {
    if (typeof event.data === "string") texts.push(event.data);
    else bytes.push(new Uint8Array(event.data as ArrayBuffer));
  };
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.onclose = (event) =>
      resolve({ code: event.code, reason: event.reason });
  });
  return { socket, texts, bytes, closed };
}

const until = async (check: () => boolean, ms = 3000) => {
  for (let i = 0; i < ms / 5 && !check(); i++) await Bun.sleep(5);
  if (!check()) throw new Error("timed out waiting");
};

async function host(key = hostKey, typed = licence, access = accessKey) {
  const opened = open("host", {
    authorization: `Bearer ${key}`,
    "x-ark-licence": typed,
    "x-ark-access": await sha256Hex(access),
  });
  return opened;
}
const staff = (key = accessKey) =>
  open("connect", { authorization: `Bearer ${key}` });

/** A staff connection carried to the host: returns both ends once the relay says ready. */
async function carried(hosting: Opened) {
  const before = hosting.texts.length;
  const person = staff();
  await until(() => hosting.texts.length > before);
  const { open: stream } = JSON.parse(hosting.texts.at(-1) as string);
  const taken = open(
    "stream",
    { authorization: `Bearer ${hostKey}` },
    `&stream=${stream}`,
  );
  await until(() => person.texts.includes("ready"));
  return { person, taken };
}

describe("the staff relay carries bytes between a staff computer and the company's", () => {
  test("a licensed host's stream and a staff stream are paired, and bytes pass both ways unchanged", async () => {
    relay = startBunRelay({ keys });
    const hosting = await host();
    await until(() => hosting.socket.readyState === WebSocket.OPEN);
    const { person, taken } = await carried(hosting);
    await until(() => taken.socket.readyState === WebSocket.OPEN);
    const hello = Uint8Array.from([0x16, 0x03, 0x01, 0, 255, 1, 2, 3]);
    person.socket.send(hello);
    await until(() => taken.bytes.length === 1);
    expect([...(taken.bytes[0] as Uint8Array)]).toEqual([...hello]);
    const big = crypto.getRandomValues(new Uint8Array(60_000));
    taken.socket.send(big);
    await until(() => person.bytes.length === 1);
    expect(
      Buffer.from(person.bytes[0] as Uint8Array).equals(Buffer.from(big)),
    ).toBe(true);

    // Closing one end closes the other.
    person.socket.close(1000, "done");
    expect((await taken.closed).code).toBe(1000);
  });

  test("it still carries them after the office's object has slept", async () => {
    relay = startBunRelay({ keys });
    const hosting = await host();
    await until(() => hosting.socket.readyState === WebSocket.OPEN);
    const { person, taken } = await carried(hosting);
    await until(() => taken.socket.readyState === WebSocket.OPEN);
    relay.hibernate();
    person.socket.send(Uint8Array.from([7, 7, 7]));
    await until(() => taken.bytes.length === 1);
    relay.hibernate();
    const again = await carried(hosting);
    expect(again.person.texts).toContain("ready");
  });

  test("the host's keep-alive is answered without waking the office", async () => {
    relay = startBunRelay({ keys });
    const hosting = await host();
    await until(() => hosting.socket.readyState === WebSocket.OPEN);
    hosting.socket.send("ping");
    await until(() => hosting.texts.includes("pong"));
    expect(relay.woke(office)).toBe(0);
  });
});

describe("who the staff relay lets in", () => {
  test("a host without a licence, with one BlackArk did not sign, or with one that ran out, is refused", async () => {
    relay = startBunRelay({ keys });
    const none = await host(hostKey, "");
    expect((await none.closed).code).toBe(CLOSE.licence);
    const forged = await host(
      hostKey,
      code(
        { v: 1, action: "license", customer: "demo-shop", validUntil: inAYear },
        otherKeys.privateKey,
      ),
    );
    expect((await forged.closed).code).toBe(CLOSE.licence);
    const expired = await host(
      hostKey,
      code({
        v: 1,
        action: "license",
        customer: "demo-shop",
        validUntil: new Date(Date.now() - 1000).toISOString(),
      }),
    );
    expect((await expired.closed).code).toBe(CLOSE.licence);
    // A trial code signed with the LICENCE key is not a trial code.
    const wrongKind = await host(
      hostKey,
      code({ v: 1, action: "trial", customer: "demo-shop", until: inAYear }),
    );
    expect((await wrongKind.closed).code).toBe(CLOSE.licence);
  });

  test("a trial activation code signed with the trial key is accepted", async () => {
    relay = startBunRelay({ keys });
    const hosting = await host(
      hostKey,
      code(
        { v: 1, action: "trial", customer: "demo-shop", until: inAYear },
        trialKeys.privateKey,
      ),
    );
    await until(() => hosting.socket.readyState === WebSocket.OPEN);
    hosting.socket.send("ping");
    await until(() => hosting.texts.includes("pong"));
  });

  test("once an office is held, another host key (even with its own licence) cannot take it", async () => {
    relay = startBunRelay({ keys });
    const first = await host();
    await until(() => first.socket.readyState === WebSocket.OPEN);
    const other = await host("another-host-key-0123456789abcdef");
    expect((await other.closed).code).toBe(CLOSE.refused);
    // Nor can it take up staff streams.
    const person = staff();
    await until(() => first.texts.length === 1);
    const { open: stream } = JSON.parse(first.texts[0] as string);
    const stolen = open(
      "stream",
      { authorization: "Bearer another-host-key-0123456789abcdef" },
      `&stream=${stream}`,
    );
    expect((await stolen.closed).code).toBe(CLOSE.refused);
    expect(person.texts).not.toContain("ready");
  });

  test("a staff computer needs the access key, and the company's ArkAgent connected", async () => {
    relay = startBunRelay({ keys });
    const early = staff();
    expect((await early.closed).code).toBe(CLOSE.refused);
    const hosting = await host();
    await until(() => hosting.socket.readyState === WebSocket.OPEN);
    const wrong = staff("not-the-access-key-0123456789abcdef");
    expect((await wrong.closed).code).toBe(CLOSE.refused);
    hosting.socket.close();
    await Bun.sleep(50);
    const away = staff();
    expect((await away.closed).code).toBe(CLOSE.noHost);
  });

  test("a new join code makes the old access key stop working", async () => {
    relay = startBunRelay({ keys });
    const first = await host();
    await until(() => first.socket.readyState === WebSocket.OPEN);
    const renewed = await host(
      hostKey,
      licence,
      "a-new-access-key-0123456789abcdef",
    );
    await until(() => renewed.socket.readyState === WebSocket.OPEN);
    expect((await first.closed).code).toBe(1000);
    const old = staff();
    expect((await old.closed).code).toBe(CLOSE.refused);
  });

  test("bytes sent before the pair is made, or text, close the connection", async () => {
    relay = startBunRelay({ keys });
    const hosting = await host();
    await until(() => hosting.socket.readyState === WebSocket.OPEN);
    const eager = staff();
    await until(() => eager.socket.readyState === WebSocket.OPEN);
    eager.socket.send(Uint8Array.from([1]));
    expect((await eager.closed).code).toBe(CLOSE.protocol);
    const { person, taken } = await carried(hosting);
    person.socket.send("GET / HTTP/1.1");
    expect((await person.closed).code).toBe(CLOSE.protocol);
    expect((await taken.closed).code).toBe(CLOSE.protocol);
  });

  test("a staff connection the company's computer never takes up is closed", async () => {
    relay = startBunRelay({ keys, pairingMs: 100 });
    const hosting = await host();
    await until(() => hosting.socket.readyState === WebSocket.OPEN);
    const waiting = staff();
    expect((await waiting.closed).code).toBe(CLOSE.timeout);
  });
});

test("checkLicence reads the same codes as the app, and nothing else", async () => {
  const now = Date.now();
  expect(await checkLicence(licence, now, keys)).toEqual({
    customer: "demo-shop",
    validUntil: Date.parse(inAYear),
  });
  expect(await checkLicence(`${licence}.extra`, now, keys)).toBeNull();
  expect(
    await checkLicence(licence.replace("ARK1-", "ARK2-"), now, keys),
  ).toBeNull();
  expect(await checkLicence(licence, Date.parse(inAYear) + 1, keys)).toBeNull();
  expect(
    await checkLicence(
      code({
        v: 1,
        action: "license",
        customer: "Bad Name",
        validUntil: inAYear,
      }),
      now,
      keys,
    ),
  ).toBeNull();
});
