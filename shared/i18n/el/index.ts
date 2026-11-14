/**
 * Every Greek text, by area. Keys are the English exactly as it is written in the code; see
 * ../translate.ts. One file per area keeps the review sheet readable and the merges small.
 */
import { EL_ADMIN } from "./admin";
import { EL_ADMIN2 } from "./admin2";
import { EL_COMMON } from "./common";
import { EL_COMPONENTS } from "./components";
import { EL_DAILY } from "./daily";
import { EL_DESKTOP } from "./desktop";
import { EL_MESSAGES } from "./messages";
import { EL_MORE } from "./more";
import { EL_SCREENS } from "./screens";
import { EL_SCREENS2 } from "./screens2";
import { EL_SERVER } from "./server";
import { EL_SERVER_COUNTS } from "./server-counts";
import { EL_SERVER_LABELS } from "./server-labels";

export const EL: Readonly<Record<string, string>> = {
  ...EL_COMMON,
  ...EL_DAILY,
  ...EL_COMPONENTS,
  ...EL_SCREENS,
  ...EL_ADMIN,
  ...EL_MESSAGES,
  ...EL_MORE,
  ...EL_SCREENS2,
  ...EL_ADMIN2,
  ...EL_SERVER,
  ...EL_SERVER_COUNTS,
  ...EL_SERVER_LABELS,
  ...EL_DESKTOP,
};
