/**
 * Every Greek text, by area. Keys are the English exactly as it is written in the code; see
 * ../translate.ts. One file per area keeps the review sheet readable and the merges small.
 */
import { EL_ADMIN } from "./admin";
import { EL_COMMON } from "./common";
import { EL_COMPONENTS } from "./components";
import { EL_DAILY } from "./daily";
import { EL_SCREENS } from "./screens";

export const EL: Readonly<Record<string, string>> = {
  ...EL_COMMON,
  ...EL_DAILY,
  ...EL_COMPONENTS,
  ...EL_SCREENS,
  ...EL_ADMIN,
};
