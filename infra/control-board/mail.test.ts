import { afterEach, describe, expect, test } from "bun:test";
import { getCase, notes } from "./cases";
import { pollMailbox } from "./intake";
import {
  type ImapClient,
  imapMailbox,
  mailparserParse,
  type ParsedMail,
} from "./mail";
import { testBoard } from "./test-helpers";

let current: ReturnType<typeof testBoard> | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

type Stored = {
  uid: number;
  seen: boolean;
  flagged: string[];
  mail: ParsedMail;
};

/**
 * A stand-in for General@ on an IMAP server: SEARCH matches To/Cc as a substring, as IMAP does,
 * so the board's exact check after parsing is tested too. It records every fetch and flag.
 */
function generalMailbox(messages: ParsedMail[]) {
  const stored: Stored[] = messages.map((mail, index) => ({
    uid: 100 + index,
    seen: false,
    flagged: [],
    mail,
  }));
  const fetched: number[] = [];
  let locks = 0;
  const client: ImapClient = {
    async connect() {},
    async getMailboxLock(path) {
      expect(path).toBe("INBOX");
      locks += 1;
      return {
        release: () => {
          locks -= 1;
        },
      };
    },
    async search(query) {
      const q = query as {
        seen: boolean;
        or: Array<{ to?: string; cc?: string }>;
      };
      return stored
        .filter((one) => one.seen === q.seen)
        .filter((one) =>
          q.or.some(
            (term) =>
              (term.to &&
                one.mail.to.some((a) =>
                  a.toLowerCase().includes(term.to as string),
                )) ||
              (term.cc &&
                one.mail.cc.some((a) =>
                  a.toLowerCase().includes(term.cc as string),
                )),
          ),
        )
        .map((one) => one.uid);
    },
    async fetchOne(range) {
      const one = stored.find((m) => m.uid === Number(range));
      if (!one) return false;
      fetched.push(one.uid);
      return { uid: one.uid, source: Buffer.from(JSON.stringify(one.mail)) };
    },
    async messageFlagsAdd(range, flags) {
      const one = stored.find((m) => m.uid === Number(range));
      if (!one) return false;
      one.flagged.push(...flags);
      if (flags.includes("\\Seen")) one.seen = true;
      return true;
    },
    async logout() {},
  };
  return { client, stored, fetched, locks: () => locks };
}

const parseJson = async (source: Buffer) =>
  JSON.parse(source.toString()) as ParsedMail;

const mail = (over: Partial<ParsedMail>): ParsedMail => ({
  messageId: "<m@mail.example>",
  from: "Someone <someone@shop.example>",
  to: ["general@blackark.uk"],
  cc: [],
  subject: "Hello",
  text: "Text",
  ...over,
});

describe("General@ over IMAP, filtered on support@", () => {
  test("takes only messages sent to support@ (To or Cc); everything else stays unread and untouched", async () => {
    const t = testBoard();
    current = t;
    const box = generalMailbox([
      mail({
        messageId: "<a@x>",
        to: ["support@blackark.uk"],
        subject: "Gmail stopped [customer:demo-shop]",
      }),
      mail({
        messageId: "<b@x>",
        to: ["general@blackark.uk"],
        subject: "An invoice from a supplier",
      }),
      mail({
        messageId: "<c@x>",
        to: ["general@blackark.uk"],
        cc: ["Support@BlackArk.uk"],
        subject: "Cc to support",
      }),
      mail({
        messageId: "<d@x>",
        to: ["nosupport@blackark.uk"],
        subject: "Looks like support, is not",
      }),
    ]);
    const mailbox = imapMailbox(async () => box.client, parseJson);
    expect(await pollMailbox(t.db, mailbox, t.clock.now)).toEqual([1, 2]);
    expect(getCase(t.db, 1)).toMatchObject({
      customer_id: "demo-shop",
      channel: "email",
      subject: "Gmail stopped [customer:demo-shop]",
    });
    expect(getCase(t.db, 2)?.subject).toBe("Cc to support");
    // b was never fetched or flagged; d was fetched (IMAP's search is a substring) but left as it was.
    expect(box.fetched).toEqual([100, 102, 103]);
    expect(
      box.stored.map((one) => [one.uid, one.seen, one.flagged.join()]),
    ).toEqual([
      [100, true, "\\Seen"],
      [101, false, ""],
      [102, true, "\\Seen"],
      [103, false, ""],
    ]);
    expect(box.locks()).toBe(0);
    // A second run finds nothing new.
    expect(await pollMailbox(t.db, mailbox, t.clock.now)).toEqual([]);
  });

  test("a reply to a case's message becomes a note on it", async () => {
    const t = testBoard();
    current = t;
    const box = generalMailbox([
      mail({
        messageId: "<first@x>",
        to: ["support@blackark.uk"],
        subject: "Problem",
      }),
      mail({
        messageId: "<second@x>",
        inReplyTo: "<first@x>",
        to: ["support@blackark.uk"],
        subject: "Re: Problem",
        text: "More detail",
      }),
    ]);
    expect(
      await pollMailbox(
        t.db,
        imapMailbox(async () => box.client, parseJson),
        t.clock.now,
      ),
    ).toEqual([1, 1]);
    expect(notes(t.db, 1).at(-1)?.body.endsWith("More detail")).toBe(true);
  });
});

describe("parsing a real message with mailparser (from the server workspace)", () => {
  test("reads To, Cc, Message-ID, In-Reply-To, subject and text; drops attachments", async () => {
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
      "",
      "Το Gmail δεν ανοίγει.",
      "--b1",
      'Content-Type: application/octet-stream; name="x.bin"',
      'Content-Disposition: attachment; filename="x.bin"',
      "Content-Transfer-Encoding: base64",
      "",
      "AAEC",
      "--b1--",
      "",
    ].join("\r\n");
    const parsed = await mailparserParse(Buffer.from(raw));
    expect(parsed).toEqual({
      messageId: "<abc@shop.example>",
      inReplyTo: "<case-1@blackark.uk>",
      from: '"Someone" <someone@shop.example>',
      to: ["general@blackark.uk"],
      cc: ["support@blackark.uk"],
      subject: "Δεν ανοίγει",
      text: "Το Gmail δεν ανοίγει.\n\n(1 attachment(s) not kept)",
    });
  });
});
