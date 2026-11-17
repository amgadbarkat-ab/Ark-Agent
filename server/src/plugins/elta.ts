/**
 * ELTA Courier tracking (#109, v0.1.44), for every install. Read only.
 *
 * ELTA publishes no developer documentation. This follows the interface public ELTA integrations use
 * (the `PELTT01` web service, as in the open-source `chinchillabrains/eltaws` client): one SOAP
 * operation, `READ`, document/literal, at ELTA's address on port 9003, taking the customer code, the
 * user code, the password and a voucher number (or the shop's own reference), and answering with a
 * status (`st_flag`, `st_title`), the delivery (`pod_date`, `pod_time`, `pod_name`) and up to 100
 * tracking events (`web_status`: date, time, station, title).
 *
 * TWO THINGS TO KNOW. ELTA serves this over plain http, not https: the login travels unencrypted, as
 * it does for every integration of this service. And it says nothing about cash-on-delivery money;
 * that comes from ELTA's statements. Checked for real only once a customer's ELTA login exists.
 */
import {
  answer,
  BusinessError,
  businessFetch,
  call,
  settingsFrom,
  text,
} from "./business-http";
import { refusedMailHost } from "./mailbox";
import type { McpCallResult, McpTool } from "./mcp";

const TITLE = "ELTA Courier";
export const ELTA_DEFAULT_URL = "http://212.205.47.226:9003";
const VOUCHER = /^[A-Za-z0-9-]{4,40}$/;

const TOOLS: readonly McpTool[] = Object.freeze([
  {
    name: "track_shipment",
    description:
      "Where an ELTA Courier shipment is: its status, its tracking events (date, time, station) and, once delivered, when and to whom. By the voucher number, or by the shop's own reference.",
    inputSchema: {
      type: "object",
      properties: {
        voucher: { type: "string", description: "The ELTA voucher number." },
        reference: {
          type: "string",
          description: "Or the shop's own reference for the shipment.",
        },
      },
    },
  },
]);

export const listNeedsCredential = false;

export async function listTools(): Promise<McpTool[]> {
  return TOOLS.map((tool) => ({ ...tool }));
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function readRequest(fields: {
  code: string;
  user: string;
  password: string;
  voucher: string;
  reference: string;
  byReference: boolean;
}): string {
  const field = (name: string, value: string) =>
    `<${name}>${xmlEscape(value)}</${name}>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns="/PELTT01">',
    "<soap:Body><ns:READ>",
    field("wpel_code", fields.code),
    field("wpel_user", fields.user),
    field("wpel_pass", fields.password),
    field("wpel_vg", fields.voucher),
    field("wpel_ref", fields.reference),
    field("wpel_flag", fields.byReference ? "2" : "1"),
    "</ns:READ></soap:Body></soap:Envelope>",
  ].join("");
}

function decode(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

/** The value of the first `<name>` (any namespace prefix) inside `xml`. */
function tag(xml: string, name: string): string {
  const match = new RegExp(
    `<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`,
  ).exec(xml);
  return match?.[1] ? decode(match[1]) : "";
}

export type EltaTracking = {
  flag: string;
  title: string;
  deliveredOn: string;
  deliveredTo: string;
  events: { date: string; time: string; station: string; title: string }[];
};

export function readResponse(xml: string): EltaTracking {
  const events = [
    ...xml.matchAll(
      /<(?:\w+:)?web_status(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?web_status>/g,
    ),
  ]
    .map((match) => match[1] ?? "")
    .map((block) => ({
      date: tag(block, "web_date"),
      time: tag(block, "web_time"),
      station: tag(block, "web_station"),
      title: tag(block, "web_status_title"),
    }))
    .filter((event) => event.date || event.title);
  return {
    flag: tag(xml, "st_flag"),
    title: tag(xml, "st_title"),
    deliveredOn: [tag(xml, "pod_date"), tag(xml, "pod_time")]
      .filter(Boolean)
      .join(" "),
    deliveredTo: tag(xml, "pod_name"),
    events,
  };
}

function endpoint(settings: Record<string, string>): string {
  const raw = settings.serviceUrl || ELTA_DEFAULT_URL;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new BusinessError("The ELTA service address is not an address.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BusinessError(
      "The ELTA service address must start with http:// or https://.",
    );
  }
  if (refusedMailHost(parsed.hostname)) {
    throw new BusinessError(
      "The ELTA service address points at this computer or its network.",
    );
  }
  return parsed.toString();
}

async function read(
  settings: Record<string, string>,
  voucher: string,
  reference: string,
): Promise<EltaTracking> {
  const result = await call(businessFetch(), endpoint(settings), {
    method: "POST",
    headers: { "content-type": "text/xml; charset=utf-8", soapaction: '""' },
    body: readRequest({
      code: settings.customerCode ?? "",
      user: settings.userCode ?? "",
      password: settings.password ?? "",
      voucher,
      reference,
      byReference: !voucher && Boolean(reference),
    }),
  });
  if (/<(?:\w+:)?Fault[\s>]/.test(result.text)) {
    throw new BusinessError(
      `ELTA refused the request: ${tag(result.text, "faultstring") || "no reason given"}.`,
    );
  }
  if (result.status >= 400 || !/READResponse|st_flag/.test(result.text)) {
    throw new BusinessError(
      `ELTA's service did not answer as expected (${result.status}).`,
    );
  }
  return readResponse(result.text);
}

/** Whether ELTA accepts the login: a lookup of a voucher that cannot exist must not say the login is wrong. */
export async function checkEltaLogin(
  settings: Record<string, string>,
): Promise<string | null> {
  if (!/^\d{1,12}$/.test(settings.userCode ?? "")) {
    return "The ELTA user code is a number.";
  }
  try {
    const tracking = await read(settings, "0000000000000", "");
    if (/κωδικ|συνθηματ|password|user|χρήστ|πελάτ/i.test(tracking.title)) {
      return `ELTA said: ${tracking.title}`;
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export async function callTool(
  connection: { url: string; token?: string },
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  if (toolName !== "track_shipment") {
    return answer(`There is no ELTA Courier tool called ${toolName}.`, true);
  }
  try {
    const settings = settingsFrom(connection.token, TITLE);
    const voucher = text(args.voucher, 40);
    const reference = text(args.reference, 60);
    if (voucher && !VOUCHER.test(voucher)) {
      return answer("That is not an ELTA voucher number.", true);
    }
    if (!voucher && !reference) {
      return answer(
        "Give the ELTA voucher number, or the shop's reference.",
        true,
      );
    }
    const tracking = await read(settings, voucher, reference);
    const lines = [
      `ELTA Courier, ${voucher ? `voucher ${voucher}` : `reference ${reference}`}: ${tracking.title || "no status given"}${tracking.flag ? ` (code ${tracking.flag})` : ""}.`,
      ...(tracking.deliveredOn
        ? [
            `Delivered ${tracking.deliveredOn}${tracking.deliveredTo ? `, received by ${tracking.deliveredTo}` : ""}.`,
          ]
        : []),
      ...tracking.events
        .slice(-10)
        .map(
          (event) =>
            `  ${event.date} ${event.time}: ${event.title}${event.station ? ` (${event.station})` : ""}`,
        ),
    ];
    if (tracking.events.length === 0 && !tracking.deliveredOn) {
      lines.push("No tracking events yet.");
    }
    return answer(lines.join("\n"));
  } catch (error) {
    return answer(
      error instanceof BusinessError ? error.message : "ELTA Courier failed.",
      true,
    );
  }
}
