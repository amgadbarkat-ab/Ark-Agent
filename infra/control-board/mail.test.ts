import { afterEach, describe, expect, test } from "bun:test";
import { getCase, notes } from "./cases";
import {
  type ImapConnection,
  openImap,
  parseMail,
  type Transport,
} from "./imap";
import { pollMailbox } from "./intake";
import { imapMailbox } from "./mail";
import { type TestBoard, testBoard } from "./test-helpers";

let current: TestBoard | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

type Stored = {
  uid: number;
  seen: boolean;
  raw: string;
  to: string;
  cc: string;
};

/**
 * A stand-in for General@ on an IMAP server, over in-memory streams: it answers the commands the
 * client sends, matches SEARCH TO/CC as a substring (as IMAP does, so the board's exact check after
 * parsing is tested too), and records every command.
 */
function generalMailbox(
  messages: Array<{ to?: string; cc?: string; raw: string }>,
  password = "box-password",
) {
  const stored: Stored[] = messages.map((m, i) => ({
    uid: 100 + i,
    seen: false,
    raw: m.raw,
    to: m.to ?? "",
    cc: m.cc ?? "",
  }));
  const commands: string[] = [];
  const toServer = new TransformStream<Uint8Array, Uint8Array>();
  const toClient = new TransformStream<Uint8Array, Uint8Array>();
  const writer = toClient.writable.getWriter();
  const send = (text: string) => writer.write(new TextEncoder().encode(text));
  (async () => {
    await send("* OK IMAP4rev1 stand-in ready\r\n");
    const reader = toServer.readable.getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += new TextDecoder().decode(value);
      let end = buffer.indexOf("\r\n");
      while (end >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        end = buffer.indexOf("\r\n");
        const [tag, verb, ...rest] = line.split(" ");
        const args = rest.join(" ");
        commands.push(
          verb === "LOGIN" ? "LOGIN ***" : `${verb} ${args}`.trim(),
        );
        if (verb === "LOGIN") {
          await send(
            args.includes(`"${password}"`)
              ? `${tag} OK signed in\r\n`
              : `${tag} NO wrong password\r\n`,
          );
        } else if (verb === "SELECT") {
          await send(
            `* ${stored.length} EXISTS\r\n${tag} OK [READ-WRITE] selected\r\n`,
          );
        } else if (verb === "UID" && rest[0] === "SEARCH") {
          const address = (args.match(/TO "([^"]+)"/)?.[1] ?? "").toLowerCase();
          const found = stored
            .filter(
              (m) =>
                !m.seen &&
                (m.to.toLowerCase().includes(address) ||
                  m.cc.toLowerCase().includes(address)),
            )
            .map((m) => m.uid);
          await send(
            `* SEARCH ${found.join(" ")}\r\n${tag} OK search done\r\n`,
          );
        } else if (verb === "UID" && rest[0] === "FETCH") {
          const one = stored.find((m) => m.uid === Number(rest[1]));
          if (one) {
            const bytes = new TextEncoder().encode(one.raw);
            await send(
              `* 1 FETCH (UID ${one.uid} BODY[] {${bytes.length}}\r\n`,
            );
            await writer.write(bytes);
            await send(")\r\n");
          }
          await send(`${tag} OK fetch done\r\n`);
        } else if (verb === "UID" && rest[0] === "STORE") {
          const one = stored.find((m) => m.uid === Number(rest[1]));
          if (one && args.includes("\\Seen")) one.seen = true;
          await send(`${tag} OK stored\r\n`);
        } else if (verb === "LOGOUT") {
          await send(`* BYE\r\n${tag} OK bye\r\n`);
        } else {
          await send(`${tag} BAD unknown\r\n`);
        }
      }
    }
  })();
  const transport: Transport = {
    readable: toClient.readable,
    writable: toServer.writable,
    close: async () => {},
  };
  return { transport, stored, commands };
}

const mail = (over: {
  id: string;
  to?: string;
  cc?: string;
  subject?: string;
  text?: string;
  inReplyTo?: string;
}) => ({
  to: over.to ?? "General <general@blackark.uk>",
  cc: over.cc ?? "",
  raw: [
    "From: Someone <someone@shop.example>",
    `To: ${over.to ?? "General <general@blackark.uk>"}`,
    ...(over.cc ? [`Cc: ${over.cc}`] : []),
    `Subject: ${over.subject ?? "Hello"}`,
    `Message-ID: <${over.id}>`,
    ...(over.inReplyTo ? [`In-Reply-To: <${over.inReplyTo}>`] : []),
    "Content-Type: text/plain; charset=utf-8",
    "",
    over.text ?? "Text",
    "",
  ].join("\r\n"),
});

describe("General@ over IMAP (our client over a socket), filtered on support@", () => {
  test("takes only messages sent to support@ (To or Cc); everything else is never fetched or flagged", async () => {
    const t = await testBoard();
    current = t;
    const box = generalMailbox([
      mail({
        id: "a@x",
        to: "support@blackark.uk",
        subject: "Gmail stopped [customer:demo-shop]",
      }),
      mail({ id: "b@x", subject: "An invoice from a supplier" }),
      mail({ id: "c@x", cc: "Support@BlackArk.uk", subject: "Cc to support" }),
      mail({
        id: "d@x",
        to: "nosupport@blackark.uk",
        subject: "Looks like support, is not",
      }),
    ]);
    const mailbox = imapMailbox(() =>
      openImap(box.transport, "general@blackark.uk", "box-password"),
    );
    expect(await pollMailbox(t.sql, mailbox, t.clock.now)).toEqual([1, 2]);
    expect(await getCase(t.sql, 1)).toMatchObject({
      customer_id: "demo-shop",
      channel: "email",
    });
    expect((await getCase(t.sql, 2))?.subject).toBe("Cc to support");
    expect(box.stored.map((m) => [m.uid, m.seen])).toEqual([
      [100, true],
      [101, false],
      [102, true],
      [103, false],
    ]);
    // Only PEEK fetches, only of what the search found; only the taken ones flagged; nothing else.
    expect(box.commands).toEqual([
      "LOGIN ***",
      "SELECT INBOX",
      'UID SEARCH UNSEEN OR TO "support@blackark.uk" CC "support@blackark.uk"',
      "UID FETCH 100 (BODY.PEEK[])",
      "UID FETCH 102 (BODY.PEEK[])",
      "UID FETCH 103 (BODY.PEEK[])",
      "UID STORE 100 +FLAGS.SILENT (\\Seen)",
      "UID STORE 102 +FLAGS.SILENT (\\Seen)",
    ]);
    expect(await pollMailbox(t.sql, mailbox, t.clock.now)).toEqual([]);
    await mailbox.close();
    expect(box.commands.at(-1)).toBe("LOGOUT");
  });

  test("a reply to a case's message becomes a note on it", async () => {
    const t = await testBoard();
    current = t;
    const box = generalMailbox([
      mail({ id: "first@x", to: "support@blackark.uk", subject: "Problem" }),
      mail({
        id: "second@x",
        to: "support@blackark.uk",
        subject: "Re: Problem",
        text: "More detail",
        inReplyTo: "first@x",
      }),
    ]);
    const mailbox = imapMailbox(() =>
      openImap(box.transport, "general@blackark.uk", "box-password"),
    );
    expect(await pollMailbox(t.sql, mailbox, t.clock.now)).toEqual([1, 1]);
    expect((await notes(t.sql, 1)).at(-1)?.body.endsWith("More detail")).toBe(
      true,
    );
  });

  test("a wrong password is refused, and nothing is read", async () => {
    const box = generalMailbox([
      mail({ id: "a@x", to: "support@blackark.uk" }),
    ]);
    await expect(
      openImap(box.transport, "general@blackark.uk", "wrong"),
    ).rejects.toThrow("LOGIN refused");
    expect(box.commands).toEqual(["LOGIN ***"]);
  });

  test("a run takes at most 5 messages", async () => {
    const box = generalMailbox(
      Array.from({ length: 8 }, (_, i) =>
        mail({ id: `m${i}@x`, to: "support@blackark.uk" }),
      ),
    );
    const connection: ImapConnection = await openImap(
      box.transport,
      "u",
      "box-password",
    );
    const mailbox = imapMailbox(async () => connection);
    expect((await mailbox.unseen()).length).toBe(5);
  });
});

describe("reading a message (MIME)", () => {
  test("To, Cc, Message-ID, In-Reply-To, an encoded subject, quoted-printable Greek; attachments dropped", () => {
    const raw = [
      "From: Someone <someone@shop.example>",
      "To: General <general@blackark.uk>",
      "Cc: support@blackark.uk",
      "Subject: =?UTF-8?B?zpTOtc69IM6xzr3Ov86vzrPOtc65?=",
      "Message-ID: <abc@shop.example>",
      "In-Reply-To: <case-1@blackark.uk>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="b1"',
      "",
      "--b1",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "=CE=A4=CE=BF Gmail =CE=B4=CE=B5=CE=BD =CE=B1=CE=BD=CE=BF=CE=AF=CE=B3=CE=B5=CE=B9.",
      "--b1",
      'Content-Type: application/octet-stream; name="x.bin"',
      'Content-Disposition: attachment; filename="x.bin"',
      "Content-Transfer-Encoding: base64",
      "",
      "AAEC",
      "--b1--",
      "",
    ].join("\r\n");
    expect(parseMail(new TextEncoder().encode(raw))).toEqual({
      messageId: "<abc@shop.example>",
      inReplyTo: "<case-1@blackark.uk>",
      from: "Someone <someone@shop.example>",
      to: ["general@blackark.uk"],
      cc: ["support@blackark.uk"],
      subject: "Δεν ανοίγει",
      text: "Το Gmail δεν ανοίγει.\n\n(1 attachment(s) not kept)",
    });
  });

  test("an HTML-only message keeps its words without the tags; a base64 body is decoded", () => {
    const html = parseMail(
      new TextEncoder().encode(
        "To: support@blackark.uk\r\nContent-Type: text/html\r\n\r\n<p>Hello <b>there</b></p>\r\n",
      ),
    );
    expect(html.text).toBe("Hello there");
    const b64 = parseMail(
      new TextEncoder().encode(
        `To: support@blackark.uk\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${btoa(
          String.fromCharCode(...new TextEncoder().encode("Καλημέρα")),
        )}\r\n`,
      ),
    );
    expect(b64.text).toBe("Καλημέρα");
  });
});
