/**
 * One plain-text email through BlackArk's own mailbox (#109, v0.1.47): the relay's internal alert
 * when blackark.uk stops answering. Implicit TLS (port 465, as one.com's send.one.com), AUTH LOGIN,
 * one message, QUIT. No dependency: the relay installs nothing beyond its runtime.
 *
 * The conversation (`sendMailOver`) runs over any byte stream: `Bun.connect` in the Bun relay
 * (`sendMail`), Cloudflare's `connect()` with `secureTransport: "on"` in the Workers relay.
 *
 * Only BlackArk's own addresses are written to, and nothing about a customer's callers is in it.
 */
export type SmtpConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
  to: string[];
  /** Implicit TLS. Only tests turn it off. */
  tls?: boolean;
  timeoutMs?: number;
};

/** A connection as web streams, the shape Cloudflare's `connect()` gives. */
export type MailTransport = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): Promise<void> | void;
};

const ADDRESS = /^[^\s<>@,]+@[^\s<>@,]+\.[^\s<>@,]+$/;

function base64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text))
    binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** The message as it goes after DATA: headers, a base64 body, and the end-of-data line. */
export function messageText(
  config: Pick<SmtpConfig, "from" | "to" | "host">,
  subject: string,
  body: string,
  now = new Date(),
): string {
  const lines = [
    `From: ${config.from}`,
    `To: ${config.to.join(", ")}`,
    `Subject: =?UTF-8?B?${base64(subject)}?=`,
    `Date: ${now.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${now.getTime()}.${Math.random().toString(36).slice(2)}@${config.host}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    ...(base64(body).match(/.{1,76}/g) ?? []),
  ];
  return `${lines.join("\r\n")}\r\n.\r\n`;
}

export function checkAddresses(config: Pick<SmtpConfig, "from" | "to">) {
  if (!ADDRESS.test(config.from) || config.to.some((to) => !ADDRESS.test(to)))
    throw new Error("An alert address is not an email address.");
}

/** The SMTP conversation over an open connection. Closes it at the end, sent or not. */
export async function sendMailOver(
  transport: MailTransport,
  config: SmtpConfig,
  subject: string,
  body: string,
): Promise<void> {
  checkAddresses(config);
  const reader = transport.readable.getReader();
  const writer = transport.writable.getWriter();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const deadline = Date.now() + (config.timeoutMs ?? 20_000);
  let buffer = "";

  /** One reply: lines "250-…" until "250 …". Throws unless its code is one of `ok`. */
  async function reply(...ok: number[]): Promise<void> {
    for (;;) {
      const match = /(?:^|\r\n)(\d{3}) [^\r\n]*\r\n$/.exec(buffer);
      if (match) {
        const code = Number(match[1]);
        const text = buffer.trim();
        buffer = "";
        if (!ok.includes(code))
          throw new Error(`The mail server said: ${text.slice(0, 200)}`);
        return;
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("The mail server did not answer in time.");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const read = await Promise.race([
        reader.read(),
        new Promise<"late">((resolve) => {
          timer = setTimeout(() => resolve("late"), left);
        }),
      ]);
      clearTimeout(timer);
      if (read === "late")
        throw new Error("The mail server did not answer in time.");
      if (read.done || !read.value)
        throw new Error("The mail server closed the connection.");
      buffer += decoder.decode(read.value, { stream: true });
    }
  }
  const write = (text: string) => writer.write(encoder.encode(text));
  const say = async (line: string, ...ok: number[]) => {
    await write(`${line}\r\n`);
    await reply(...ok);
  };

  try {
    await reply(220);
    await say("EHLO phone-relay", 250);
    await say("AUTH LOGIN", 334);
    await say(base64(config.user), 334);
    await say(base64(config.password), 235);
    await say(`MAIL FROM:<${config.from}>`, 250);
    for (const to of config.to) await say(`RCPT TO:<${to}>`, 250, 251);
    await say("DATA", 354);
    await write(messageText(config, subject, body));
    await reply(250);
    await write("QUIT\r\n");
  } finally {
    reader.releaseLock();
    writer.releaseLock();
    await Promise.resolve(transport.close()).catch(() => undefined);
  }
}

/** `Bun.connect` as web streams. */
async function bunTransport(config: SmtpConfig): Promise<MailTransport> {
  let push: ReadableStreamDefaultController<Uint8Array> | null = null;
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      push = controller;
    },
  });
  const finish = () => {
    try {
      push?.close();
    } catch {}
  };
  const socket = await Bun.connect({
    hostname: config.host,
    port: config.port,
    tls: config.tls ?? true,
    socket: {
      data(_socket, chunk) {
        push?.enqueue(new Uint8Array(chunk));
      },
      close: finish,
      error: finish,
    },
  });
  return {
    readable,
    writable: new WritableStream<Uint8Array>({
      write(chunk) {
        socket.write(chunk);
      },
    }),
    close: () => {
      socket.end();
    },
  };
}

/** The Bun relay's alert: connects (TLS unless a test says not), then the conversation. */
export async function sendMail(
  config: SmtpConfig,
  subject: string,
  body: string,
): Promise<void> {
  checkAddresses(config);
  await sendMailOver(await bunTransport(config), config, subject, body);
}
