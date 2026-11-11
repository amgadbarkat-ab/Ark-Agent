/**
 * The text in a PDF, as a model can read it (desk #83: "test-page.pdf" was refused; Amgad approved
 * `unpdf` for this on 11 Nov 2026).
 *
 * `unpdf` is Mozilla's PDF.js packaged to run without a browser or a worker: what Firefox uses to
 * show a PDF, asked here only for the words on each page. It is MIT licensed and has no
 * dependencies of its own.
 *
 * NOT OCR. A scanned page is a picture of words and has none to give, so a PDF that is only scans
 * comes back empty, and the caller says so in a sentence rather than handing the model nothing.
 *
 * NOTHING HERE TRUSTS THE FILE. PDF.js 5 compiles no font or script code from a file at all, fonts
 * are never loaded into anything, a password-protected file is a sentence and not a prompt, pages are read one at a time and reading stops once there is more
 * text than a model is given anyway, and the whole read has a time limit.
 */
import { getDocumentProxy } from "unpdf";
import { MAX_EXTRACTED_CHARACTERS } from "../../../shared/attachments";
import { UnreadableDocument } from "./office-text";

/** "%PDF-", which the format puts at the start of every file. */
const SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d];

/**
 * How far into a file the signature may start. The specification allows junk before it, and some
 * generators write a byte-order mark or a line of their own; 1024 is the limit PDF readers use.
 */
const SIGNATURE_WINDOW = 1024;

/** How long one file may take to read before it is given up on. */
const READ_TIMEOUT_MS = 30_000;

/** Whether these bytes are a PDF, from the signature alone. */
export function isPdf(bytes: Uint8Array): boolean {
  const last = Math.min(bytes.length - SIGNATURE.length, SIGNATURE_WINDOW);
  for (let at = 0; at <= last; at++) {
    if (SIGNATURE.every((byte, index) => bytes[at + index] === byte)) {
      return true;
    }
  }
  return false;
}

type TextItem = { str?: unknown; hasEOL?: unknown };

/** One page's words, with the line breaks PDF.js marks. */
function pageText(items: readonly TextItem[]): string {
  let text = "";
  for (const item of items) {
    if (typeof item.str === "string") text += item.str;
    if (item.hasEOL === true) text += "\n";
  }
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function read(bytes: Uint8Array): Promise<string> {
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // A copy, because PDF.js takes ownership of the buffer it is given, and the caller's bytes are
    // still the stored file.
    pdf = await getDocumentProxy(new Uint8Array(bytes), {
      disableFontFace: true,
      useSystemFonts: false,
      stopAtErrors: false,
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "PasswordException") {
      throw new UnreadableDocument("protected with a password");
    }
    throw new UnreadableDocument("damaged or not a PDF this app can open");
  }

  try {
    const pages: string[] = [];
    let length = 0;
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      const text = pageText(content.items as TextItem[]);
      page.cleanup();
      if (text) {
        // Pages are marked when there is more than one, so "on page 3" means something.
        pages.push(pdf.numPages > 1 ? `[Page ${number}]\n${text}` : text);
        length += text.length;
      }
      // The model is given at most this much from one file, so reading further only costs time.
      if (length > MAX_EXTRACTED_CHARACTERS) break;
    }
    return pages.join("\n\n");
  } finally {
    await pdf.loadingTask.destroy().catch(() => {});
  }
}

/** A PDF's text, page by page; empty when it has none (a scan). */
export async function pdfText(bytes: Uint8Array): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new UnreadableDocument("too slow to read")),
      READ_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([read(bytes), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
