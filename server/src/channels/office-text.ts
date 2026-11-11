/**
 * The words in a Word document and the cells of an Excel workbook, as text a model can read
 * (desk #83: `.docx` and `.xlsx` were refused as "not a file type this chat accepts").
 *
 * Both formats are a zip of XML files, so this reads them with what the runtime already has
 * (`node:zlib`) and no parsing library: the archive's directory, the one or two members that hold
 * the content, and the handful of elements in them that carry text.
 *
 * NOT A CONVERTER. Formatting, images, comments, tracked deletions, formulas (their last computed
 * value is kept) and charts are left out, and a date in a sheet is the number Excel stores. What
 * comes out is what a person would get by selecting everything and pasting it as plain text, which
 * is what "read this file" needs.
 *
 * NOTHING HERE TRUSTS THE FILE. Sizes come from the archive's own directory and are checked before
 * anything is inflated, inflation is capped, and a member that is missing, encrypted or oddly
 * compressed is an error with a sentence, never a crash.
 */
import { inflateRawSync } from "node:zlib";

/** The most text one member may inflate to. A workbook's shared strings can be large; a bomb is larger. */
const MAX_MEMBER_BYTES = 64 * 1024 * 1024;

/** The most sheets read from one workbook, in the order the workbook lists them. */
const MAX_SHEETS = 20;

export class UnreadableDocument extends Error {}

type Member = {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  headerOffset: number;
  encrypted: boolean;
};

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** The archive's directory, read from its end as the format requires. */
export function zipMembers(bytes: Uint8Array): Map<string, Member> {
  const data = view(bytes);
  // The end record is 22 bytes plus a comment of at most 65,535, so that is as far back as it can be.
  const earliest = Math.max(0, bytes.length - 22 - 0xffff);
  let end = -1;
  for (let at = bytes.length - 22; at >= earliest; at--) {
    if (data.getUint32(at, true) === EOCD) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new UnreadableDocument("not a zip archive");
  const count = data.getUint16(end + 10, true);
  let at = data.getUint32(end + 16, true);
  const members = new Map<string, Member>();
  const decoder = new TextDecoder();
  for (let index = 0; index < count; index++) {
    if (at + 46 > bytes.length || data.getUint32(at, true) !== CENTRAL) {
      throw new UnreadableDocument("a damaged zip directory");
    }
    const flags = data.getUint16(at + 8, true);
    const nameLength = data.getUint16(at + 28, true);
    const extraLength = data.getUint16(at + 30, true);
    const commentLength = data.getUint16(at + 32, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    members.set(name, {
      name,
      method: data.getUint16(at + 10, true),
      compressedSize: data.getUint32(at + 20, true),
      size: data.getUint32(at + 24, true),
      headerOffset: data.getUint32(at + 42, true),
      encrypted: (flags & 1) === 1,
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return members;
}

/** One member's content, as text. */
function readMember(bytes: Uint8Array, member: Member): string {
  if (member.encrypted) {
    throw new UnreadableDocument("protected with a password");
  }
  if (member.size > MAX_MEMBER_BYTES) {
    throw new UnreadableDocument("too large to read");
  }
  const data = view(bytes);
  const at = member.headerOffset;
  if (at + 30 > bytes.length || data.getUint32(at, true) !== LOCAL) {
    throw new UnreadableDocument("a damaged zip entry");
  }
  const start =
    at + 30 + data.getUint16(at + 26, true) + data.getUint16(at + 28, true);
  const packed = bytes.subarray(start, start + member.compressedSize);
  let content: Uint8Array;
  if (member.method === 0) {
    content = packed;
  } else if (member.method === 8) {
    try {
      content = inflateRawSync(packed, { maxOutputLength: MAX_MEMBER_BYTES });
    } catch {
      throw new UnreadableDocument("a damaged or oversized zip entry");
    }
  } else {
    throw new UnreadableDocument("compressed in a way this app cannot read");
  }
  return new TextDecoder().decode(content);
}

function memberText(
  bytes: Uint8Array,
  members: Map<string, Member>,
  name: string,
): string | null {
  const member = members.get(name);
  return member ? readMember(bytes, member) : null;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (whole, body: string) => {
    if (body.startsWith("#x")) {
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    }
    if (body.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    }
    return ENTITIES[body] ?? whole;
  });
}

/** Which kind of Office file an archive is, from what it holds; null for any other zip. */
export function officeKindOf(bytes: Uint8Array): "docx" | "xlsx" | null {
  let members: Map<string, Member>;
  try {
    members = zipMembers(bytes);
  } catch {
    return null;
  }
  if (members.has("word/document.xml")) return "docx";
  if (members.has("xl/workbook.xml")) return "xlsx";
  return null;
}

/**
 * A Word document's text: one line per paragraph, and one line per table row with a tab between
 * its cells.
 *
 * Only `<w:t>` holds words a reader sees. Field codes (`<w:instrText>`) and tracked deletions
 * (`<w:delText>`) are other elements, so naming the one that counts leaves them out without a list.
 */
export function docxText(bytes: Uint8Array): string {
  const members = zipMembers(bytes);
  const xml = memberText(bytes, members, "word/document.xml");
  if (xml === null) throw new UnreadableDocument("not a Word document");
  const out: string[] = [];
  const token =
    /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>|<w:cr\s*\/>|<\/w:p>|<w:tc[\s>]|<\/w:tc>|<\/w:tr>/g;
  // How deep in table cells the walk is: a paragraph that ends inside a cell stays on the row's line.
  let cells = 0;
  for (const match of xml.matchAll(token)) {
    const whole = match[0];
    if (match[1] !== undefined) out.push(decodeXml(match[1]));
    else if (whole.startsWith("<w:tab")) out.push("\t");
    else if (whole.startsWith("<w:tc")) cells += 1;
    else if (whole === "</w:tc>") {
      cells = Math.max(0, cells - 1);
      out.push("\t");
    } else if (whole === "</w:tr>") out.push("\n");
    else out.push(cells > 0 ? " " : "\n");
  }
  return tidy(out.join(""));
}

/** Trailing tabs and spaces off each line, and no more than one blank line in a row. */
function tidy(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/ +\t/g, "\t").replace(/[\t ]+$/u, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** "BC" → 54: a column's letters as its position, counting from zero. */
function columnIndex(reference: string): number {
  let index = 0;
  for (const letter of reference) {
    const code = letter.charCodeAt(0);
    if (code < 65 || code > 90) break;
    index = index * 26 + (code - 64);
  }
  return index - 1;
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match ? decodeXml(match[1] ?? "") : undefined;
}

/** The text of one `<si>` or `<is>`: every `<t>` in it, in order (a cell can hold several runs). */
function runsText(xml: string): string {
  let text = "";
  for (const match of xml.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)) {
    text += decodeXml(match[1] ?? "");
  }
  return text;
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/**
 * A workbook's cells: each sheet under its name, one line per row, commas between cells.
 *
 * A cell keeps its column, so a row with a gap has an empty cell there and columns still line up.
 */
export function xlsxText(bytes: Uint8Array): string {
  const members = zipMembers(bytes);
  const workbook = memberText(bytes, members, "xl/workbook.xml");
  if (workbook === null) throw new UnreadableDocument("not an Excel workbook");

  const shared: string[] = [];
  const sharedXml = memberText(bytes, members, "xl/sharedStrings.xml");
  if (sharedXml) {
    for (const match of sharedXml.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)) {
      shared.push(match[1] ? runsText(match[1]) : "");
    }
  }

  // Sheet names are in the workbook; which file each one is in is in its relationships.
  const targets = new Map<string, string>();
  const rels = memberText(bytes, members, "xl/_rels/workbook.xml.rels");
  if (rels) {
    for (const match of rels.matchAll(/<Relationship\s[^>]*>/g)) {
      const id = attribute(match[0], "Id");
      const target = attribute(match[0], "Target");
      if (id && target) {
        targets.set(
          id,
          target.startsWith("/") ? target.slice(1) : `xl/${target}`,
        );
      }
    }
  }

  const sheets: string[] = [];
  let position = 0;
  for (const match of workbook.matchAll(/<sheet\s[^>]*>/g)) {
    position += 1;
    if (sheets.length >= MAX_SHEETS) break;
    const name = attribute(match[0], "name") ?? `Sheet ${position}`;
    const id = attribute(match[0], "r:id");
    const path =
      (id && targets.get(id)) ?? `xl/worksheets/sheet${position}.xml`;
    const xml = memberText(bytes, members, path);
    if (xml === null) continue;
    const rows: string[] = [];
    for (const row of xml.matchAll(/<row[\s>][\s\S]*?<\/row>/g)) {
      const cells: string[] = [];
      for (const cell of row[0].matchAll(
        /<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g,
      )) {
        const tag = ` ${cell[1] ?? ""}`;
        const body = cell[2] ?? "";
        const reference = attribute(tag, "r") ?? "";
        const type = attribute(tag, "t");
        const raw = /<v>([^<]*)<\/v>/.exec(body)?.[1];
        let value = "";
        if (type === "s") value = shared[Number(raw)] ?? "";
        else if (type === "inlineStr") value = runsText(body);
        else if (type === "b") value = raw === "1" ? "TRUE" : "FALSE";
        else if (raw !== undefined) value = decodeXml(raw);
        const column = reference ? columnIndex(reference) : cells.length;
        while (cells.length < column) cells.push("");
        cells[column] = csvCell(value);
      }
      if (cells.some((value) => value !== "")) rows.push(cells.join(","));
    }
    sheets.push(`Sheet "${name}":\n${rows.join("\n")}`);
  }
  if (sheets.length === 0) throw new UnreadableDocument("an empty workbook");
  return sheets.join("\n\n");
}
