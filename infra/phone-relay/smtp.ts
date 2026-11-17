/**
 * One plain-text email through BlackArk's own mailbox (#109, v0.1.47): the relay's internal alert
 * when blackark.uk stops answering. Implicit TLS (port 465, as one.com's send.one.com), AUTH LOGIN,
 * one message, QUIT. No dependency: the relay installs nothing beyond Bun.
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

const ADDRESS = /^[^\s<>@,]+@[^\s<>@,]+\.[^\s<>@,]+$/;

function base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
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

export async function sendMail(
  config: SmtpConfig,
  subject: string,
  body: string,
): Promise<void> {
  if (!ADDRESS.test(config.from) || config.to.some((to) => !ADDRESS.test(to)))
    throw new Error("An alert address is not an email address.");
  let buffer = "";
  let waiter: (() => void) | null = null;
  let closed = false;
  const socket = await Bun.connect({
    hostname: config.host,
    port: config.port,
    tls: config.tls ?? true,
    socket: {
      data(_socket, chunk) {
        buffer += new TextDecoder().decode(chunk);
        waiter?.();
      },
      close() {
        closed = true;
        waiter?.();
      },
      error() {
        closed = true;
        waiter?.();
      },
    },
  });
  const deadline = Date.now() + (config.timeoutMs ?? 20_000);

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
      if (closed) throw new Error("The mail server closed the connection.");
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("The mail server did not answer in time.");
      await new Promise<void>((resolve) => {
        waiter = resolve;
        setTimeout(resolve, left);
      });
      waiter = null;
    }
  }
  const say = async (line: string, ...ok: number[]) => {
    socket.write(`${line}\r\n`);
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
    socket.write(messageText(config, subject, body));
    await reply(250);
    socket.write("QUIT\r\n");
  } finally {
    socket.end();
  }
}
