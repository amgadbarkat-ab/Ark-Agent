/**
 * Every Greek text, by area. Keys are the English exactly as it is written in the code; see
 * ../translate.ts. One file per area keeps the review sheet readable and the merges small.
 */
import { EL_COMMON } from "./common";

export const EL: Readonly<Record<string, string>> = {
  ...EL_COMMON,
};
