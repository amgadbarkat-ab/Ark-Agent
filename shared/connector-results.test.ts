import { describe, expect, test } from "bun:test";
import { connectorCard, gmailMessages } from "./connector-results";

const LINE =
  '- Tue, 10 Nov 2026 09:00:00 +0200 · from Anna <anna@example.com> · "Order 42" (unread) — Two cases · id: m1';

describe("connector results as cards (9A)", () => {
  test("only our own connectors' list tools get a card", () => {
    expect(connectorCard("google-gmail", "search_messages", LINE)?.kind).toBe(
      "mail",
    );
    expect(connectorCard("google-gmail", "read_message", LINE)).toBeNull();
    expect(
      connectorCard("someone-elses-mcp", "search_messages", LINE),
    ).toBeNull();
  });

  test("one line that does not read as a message means no card, never a card with a gap", () => {
    expect(
      gmailMessages(`${LINE}\n- (message m2 could not be read: 404)`),
    ).toBeNull();
    expect(
      gmailMessages(
        "Nothing was found, so there is nothing here to answer from.",
      ),
    ).toBeNull();
  });

  test("a subject with quotes and a preview with dots still reads whole", () => {
    expect(
      gmailMessages(
        '- from Nikos · "Re: "special" order" — Price · 12€ · id: abc_9',
      ),
    ).toEqual([
      {
        id: "abc_9",
        subject: 'Re: "special" order',
        from: "Nikos",
        date: "",
        unread: false,
        preview: "Price · 12€",
        link: "https://mail.google.com/mail/u/0/#all/abc_9",
      },
    ]);
  });
});
