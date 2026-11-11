import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { DOCX_MIME, XLSX_MIME } from "../../shared/attachments";
import { sniffMimeType } from "../src/channels/attachment-mime";
import {
  docxText,
  officeKindOf,
  UnreadableDocument,
  xlsxText,
  zipMembers,
} from "../src/channels/office-text";

/**
 * Desk #83 (c): `.docx` and `.xlsx` were refused as "not a file type this chat accepts". The two
 * fixtures are real files written by LibreOffice, Greek text and a table included.
 */

const fixture = (name: string) =>
  new Uint8Array(readFileSync(join(import.meta.dir, "fixtures", name)));

/** A small zip, written here so the damaged and odd cases can be made on purpose. */
function zip(
  files: Record<string, string>,
  options: { store?: boolean; encrypted?: boolean } = {},
): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = encoder.encode(name);
    const raw = encoder.encode(text);
    const data = options.store ? raw : new Uint8Array(deflateRawSync(raw));
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(6, options.encrypted ? 1 : 0, true);
    lv.setUint16(8, options.store ? 0 : 8, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(8, options.encrypted ? 1 : 0, true);
    cv.setUint16(10, options.store ? 0 : 8, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const directory = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, directory, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + directory + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

describe("a real Excel workbook", () => {
  test("is read sheet by sheet, a line per row, cells in their columns", () => {
    expect(xlsxText(fixture("wines.xlsx"))).toBe(
      [
        'Sheet "wines":',
        "Κρασί,Περιοχή,Τιμή,Σε απόθεμα",
        "Ασύρτικο,Σαντορίνη,18.5,TRUE",
        '"Αγιωργίτικο, ξηρό",Νεμέα,12,FALSE',
        'only,,"note with ""quotes"""',
      ].join("\n"),
    );
  });

  test("is recognised from what it holds, whatever the browser called it", () => {
    const bytes = fixture("wines.xlsx");
    expect(officeKindOf(bytes)).toBe("xlsx");
    // Windows gives no type at all when Excel is not installed.
    expect(sniffMimeType(bytes, "")).toBe(XLSX_MIME);
    expect(sniffMimeType(bytes, "application/octet-stream")).toBe(XLSX_MIME);
    // And a claim to be a Word file does not make it one.
    expect(sniffMimeType(bytes, DOCX_MIME)).toBe(XLSX_MIME);
  });
});

describe("a real Word document", () => {
  test("is read a line per paragraph, a table row on one line with tabs between cells", () => {
    expect(docxText(fixture("order.docx"))).toBe(
      [
        "Δοκιμή εγγράφου",
        "Η παραγγελία πρέπει να επιβεβαιωθεί & να σταλεί <σήμερα>.",
        "Κρασί\tΤιμή",
        "Ασύρτικο\t18,50 €",
        "Last line.",
      ].join("\n"),
    );
  });

  test("is recognised from what it holds", () => {
    expect(sniffMimeType(fixture("order.docx"), "")).toBe(DOCX_MIME);
  });
});

describe("what Word hides is left out", () => {
  test("field codes and tracked deletions are not text; a tab and a line break are kept", () => {
    const bytes = zip({
      "word/document.xml":
        '<w:document><w:body><w:p><w:r><w:t xml:space="preserve">Total: </w:t></w:r>' +
        "<w:r><w:instrText>SUM(ABOVE)</w:instrText></w:r><w:r><w:t>42</w:t></w:r>" +
        "<w:del><w:r><w:delText>old</w:delText></w:r></w:del></w:p>" +
        "<w:p><w:r><w:t>a</w:t><w:tab/><w:t>b</w:t><w:br/><w:t>c &#x3A9; &amp;</w:t></w:r></w:p></w:body></w:document>",
    });
    expect(docxText(bytes)).toBe("Total: 42\na\tb\nc Ω &");
  });

  test("a stored (uncompressed) member reads the same as a deflated one", () => {
    const xml = {
      "word/document.xml": "<w:p><w:r><w:t>plain</w:t></w:r></w:p>",
    };
    expect(docxText(zip(xml, { store: true }))).toBe("plain");
    expect(docxText(zip(xml))).toBe("plain");
  });
});

describe("a workbook's other cell kinds", () => {
  test("inline strings, gaps in a row, a formula's value and a second sheet", () => {
    const bytes = zip({
      "xl/workbook.xml":
        '<workbook><sheets><sheet name="A &amp; B" sheetId="1" r:id="rId1"/><sheet name="Two" sheetId="2" r:id="rId2"/></sheets></workbook>',
      "xl/_rels/workbook.xml.rels":
        '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/other.xml"/></Relationships>',
      "xl/worksheets/sheet1.xml":
        '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>name</t></is></c><c r="D1"><f>SUM(B1:C1)</f><v>7</v></c></row>' +
        '<row r="2"/><row r="3"><c r="B3" t="b"><v>1</v></c></row></sheetData></worksheet>',
      "xl/worksheets/other.xml":
        '<worksheet><sheetData><row r="1"><c r="A1" t="str"><v>x &lt; y</v></c></row></sheetData></worksheet>',
    });
    expect(xlsxText(bytes)).toBe(
      'Sheet "A & B":\nname,,,7\n,TRUE\n\nSheet "Two":\nx < y',
    );
  });
});

describe("a file that cannot be read says why, and never throws anything else", () => {
  test("not a zip, a zip that is neither, a password, a damaged entry", () => {
    expect(() => docxText(new TextEncoder().encode("hello"))).toThrow(
      UnreadableDocument,
    );
    expect(
      officeKindOf(new TextEncoder().encode("PK\u0003\u0004 not really")),
    ).toBeNull();
    expect(officeKindOf(zip({ "readme.txt": "hi" }))).toBeNull();
    expect(() => xlsxText(zip({ "readme.txt": "hi" }))).toThrow(
      "not an Excel workbook",
    );
    expect(() =>
      docxText(
        zip({ "word/document.xml": "<w:t>x</w:t>" }, { encrypted: true }),
      ),
    ).toThrow("protected with a password");

    const damaged = zip({
      "word/document.xml": "<w:p><w:r><w:t>plain</w:t></w:r></w:p>",
    });
    damaged.fill(0xff, 40, 50);
    expect(() => docxText(damaged)).toThrow(UnreadableDocument);
  });

  test("a member that claims to be enormous is refused before anything is inflated", () => {
    const bytes = zip({ "word/document.xml": "<w:t>x</w:t>" });
    const members = zipMembers(bytes);
    const member = members.get("word/document.xml");
    expect(member).toBeDefined();
    // Rewrite the directory's size for it to 1 GB.
    const view = new DataView(bytes.buffer);
    for (let at = 0; at < bytes.length - 4; at++) {
      if (view.getUint32(at, true) === 0x02014b50) {
        view.setUint32(at + 24, 1024 * 1024 * 1024, true);
      }
    }
    expect(() => docxText(bytes)).toThrow("too large to read");
  });
});
