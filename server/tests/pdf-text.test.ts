import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyAttachment } from "../../shared/attachments";
import { sniffMimeType } from "../src/channels/attachment-mime";
import { UnreadableDocument } from "../src/channels/office-text";
import { isPdf, pdfText } from "../src/channels/pdf-text";

/**
 * Reading a PDF's text (desk #83), against files LibreOffice made: a one-page Greek order, a
 * two-page tender, a picture saved as a PDF (what a scan is), and one locked with a password.
 */
const fixture = (name: string) =>
  new Uint8Array(readFileSync(join(import.meta.dir, "fixtures", name)));

describe("recognising a PDF", () => {
  test("by its signature, whatever it claims", () => {
    const bytes = fixture("order.pdf");
    expect(isPdf(bytes)).toBe(true);
    for (const claim of ["application/pdf", "", "application/octet-stream"]) {
      expect(sniffMimeType(bytes, claim)).toBe("application/pdf");
    }
    expect(classifyAttachment("application/pdf")).toBe("document");
  });

  test("a signature a little way in still counts, as PDF readers allow", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...fixture("order.pdf")]);
    expect(isPdf(bytes)).toBe(true);
  });

  test("bytes that only claim to be a PDF are not one", () => {
    const bytes = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
    expect(isPdf(bytes)).toBe(false);
    expect(sniffMimeType(bytes, "application/pdf")).toBe(
      "application/octet-stream",
    );
    expect(isPdf(new Uint8Array())).toBe(false);
  });
});

describe("the text in it", () => {
  test("a one-page Greek document, with no page mark", async () => {
    expect(await pdfText(fixture("order.pdf"))).toBe(
      "Δοκιμή εγγράφου\nΗ παραγγελία πρέπει να επιβεβαιωθεί & να σταλεί <σήμερα>.\nΚρασί Τιμή\nΑσύρτικο 18,50 €\nLast line.",
    );
  });

  test("a longer one, marked page by page", async () => {
    const text = await pdfText(fixture("tender.pdf"));
    expect(text).toStartWith("[Page 1]\nTender 2026/17: first page.\n");
    expect(text).toContain("\n\n[Page 2]\n");
    expect(text).toEndWith("Closing date: 30 November 2026.");
  });

  test("a scan has no text, and says nothing rather than something", async () => {
    expect(await pdfText(fixture("scan.pdf"))).toBe("");
  });

  test("a locked file is a sentence, not a prompt for a password", async () => {
    const error = await pdfText(fixture("locked.pdf")).catch((e) => e);
    expect(error).toBeInstanceOf(UnreadableDocument);
    expect((error as Error).message).toBe("protected with a password");
  });

  test("a damaged file is a sentence, not a crash", async () => {
    const error = await pdfText(
      new TextEncoder().encode("%PDF-1.7\nthis is not really a PDF\n"),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(UnreadableDocument);
  });

  test("the bytes it is given are left as they were", async () => {
    const bytes = fixture("order.pdf");
    const before = bytes.byteLength;
    await pdfText(bytes);
    expect(bytes.byteLength).toBe(before);
    expect(isPdf(bytes)).toBe(true);
  });
});
