/**
 * The EN/ΕΛ string sheet (#108): every English text the product shows and its Greek, by area, as a
 * CSV a reviewer can open in a spreadsheet. Rebuilt from the tables, so it is never out of step:
 *
 *   bun scripts/i18n-sheet.ts > docs/i18n/en-el-strings.csv
 */
import { EL_ADMIN } from "../shared/i18n/el/admin";
import { EL_ADMIN2 } from "../shared/i18n/el/admin2";
import { EL_COMMON } from "../shared/i18n/el/common";
import { EL_COMPONENTS } from "../shared/i18n/el/components";
import { EL_DAILY } from "../shared/i18n/el/daily";
import { EL_DESKTOP } from "../shared/i18n/el/desktop";
import { EL_MESSAGES } from "../shared/i18n/el/messages";
import { EL_MORE } from "../shared/i18n/el/more";
import { EL_PACKAGE } from "../shared/i18n/el/package";
import { EL_SCREENS } from "../shared/i18n/el/screens";
import { EL_SCREENS2 } from "../shared/i18n/el/screens2";
import { EL_SCREENS3 } from "../shared/i18n/el/screens3";
import { EL_SERVER } from "../shared/i18n/el/server";
import { EL_SERVER_COUNTS } from "../shared/i18n/el/server-counts";
import { EL_SERVER_LABELS } from "../shared/i18n/el/server-labels";

const AREAS: [string, Record<string, string>][] = [
  ["Common", EL_COMMON],
  ["Daily screens", EL_DAILY],
  ["Components", EL_COMPONENTS],
  ["Screens", EL_SCREENS],
  ["Screens (2)", EL_SCREENS2],
  ["Screens (3)", EL_SCREENS3],
  ["Admin", EL_ADMIN],
  ["Admin (2)", EL_ADMIN2],
  ["Messages", EL_MESSAGES],
  ["More", EL_MORE],
  ["Server messages", EL_SERVER],
  ["Server counts", EL_SERVER_COUNTS],
  ["Server labels", EL_SERVER_LABELS],
  ["Desktop setup", EL_DESKTOP],
  ["Installed package", EL_PACKAGE],
];

const cell = (text: string) => `"${text.replace(/"/g, '""')}"`;
const rows = ["Area,English,Greek"];
const seen = new Set<string>();
for (const [area, table] of AREAS) {
  for (const [english, greek] of Object.entries(table)) {
    if (seen.has(english)) continue;
    seen.add(english);
    rows.push([area, english, greek].map(cell).join(","));
  }
}
// A byte-order mark so a spreadsheet opens the Greek as UTF-8.
process.stdout.write(`﻿${rows.join("\r\n")}\r\n`);
