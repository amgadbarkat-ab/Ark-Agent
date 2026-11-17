/**
 * What the business connectors share (#109, v0.1.43): reading the stored settings, one HTTPS call
 * with a timeout, and the answer an employee reads.
 *
 * The settings are the connection's token: the JSON the person typed in Settings, stored encrypted in
 * the vault and read back by the store for this call only. Nothing in a tool's arguments chooses an
 * account, a shop or an address.
 */
import { cutAtCodeUnits } from "../channels/text";
import { refusedMailHost } from "./mailbox";
import { MAX_RESULT_CHARS, type McpCallResult } from "./mcp";

const TIMEOUT_MS = 30_000;

export function answer(text: string, isError = false): McpCallResult {
  const truncated = text.length > MAX_RESULT_CHARS;
  return {
    text: truncated ? cutAtCodeUnits(text, MAX_RESULT_CHARS) : text,
    isError,
    truncated,
  };
}

export function settingsFrom(
  token: string | undefined,
  title: string,
): Record<string, string> {
  if (!token) {
    throw new BusinessError(
      `${title} is not connected. Connect it in Settings, then Connect your Data, and ask again.`,
    );
  }
  try {
    const parsed = JSON.parse(token) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    throw new BusinessError(
      `${title} has to be connected again, in Settings, then Connect your Data.`,
    );
  }
}

export class BusinessError extends Error {}

/** An https address on the internet, never this computer or its network. */
export function checkedBase(url: string | undefined, what: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url ?? "");
  } catch {
    throw new BusinessError(`${what} is not an address.`);
  }
  if (parsed.protocol !== "https:") {
    throw new BusinessError(`${what} must start with https://.`);
  }
  if (refusedMailHost(parsed.hostname)) {
    throw new BusinessError(`${what} points at this computer or its network.`);
  }
  return parsed;
}

export type HttpAnswer = { status: number; body: unknown; text: string };

export async function call(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<HttpAnswer> {
  let response: Response;
  try {
    response = await fetcher(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new BusinessError(
      `${new URL(url).host} could not be reached. Check this computer's internet connection and try again.`,
    );
  }
  const text = await response.text().catch(() => "");
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: response.status, body, text };
}

/** The vendor's own error words, short, for a refused call. */
export function vendorSaid(result: HttpAnswer): string {
  const body = result.body as Record<string, unknown> | null;
  const said =
    (typeof body?.message === "string" && body.message) ||
    (Array.isArray(body?.errors) && body.errors.length > 0
      ? JSON.stringify(body.errors)
      : "") ||
    result.text;
  return cutAtCodeUnits(String(said).replace(/\s+/g, " ").trim(), 300);
}

export function text(value: unknown, max = 200): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

let fetcher: typeof fetch | null = null;

/** For tests: where the business connectors send their calls. */
export function useBusinessFetch(value: typeof fetch | null): void {
  fetcher = value;
}

export function businessFetch(): typeof fetch {
  return fetcher ?? fetch;
}
