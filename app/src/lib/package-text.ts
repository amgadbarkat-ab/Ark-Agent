import { EL_PACKAGE } from "../../../shared/i18n/el/package";
import { storedLanguage } from "./i18n";

/**
 * The installed package's own words in Greek (#108): its digital employees, conversations and
 * skills arrive from many endpoints (the roster, a conversation, the skills list, the admin
 * screens), so they are translated once, as a response is read, rather than at every screen.
 *
 * Narrow on purpose. Only these fields, only an exact match with a sentence the package ships,
 * so a name or a role somebody wrote themselves is never changed, and ids, slugs and instructions
 * are never touched.
 */
const FIELDS = new Set([
  "name",
  "title",
  "roleDescription",
  "summary",
  "description",
  "channelName",
  "agentName",
]);

function walk(value: unknown, depth: number): unknown {
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++)
      value[index] = walk(value[index], depth + 1);
    return value;
  }
  const record = value as Record<string, unknown>;
  for (const [key, field] of Object.entries(record)) {
    if (typeof field === "string") {
      if (FIELDS.has(key)) {
        const greek = EL_PACKAGE[field.trim()];
        if (greek !== undefined) record[key] = greek;
      }
    } else if (field && typeof field === "object") {
      record[key] = walk(field, depth + 1);
    }
  }
  return record;
}

/** The body, with the package's sentences in Greek when Greek is chosen. Mutates and returns it. */
export function packageText<T>(body: T): T {
  if (storedLanguage() !== "el") return body;
  return walk(body, 0) as T;
}
