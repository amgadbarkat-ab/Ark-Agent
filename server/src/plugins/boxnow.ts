/**
 * BOX NOW parcels, tracking and cash on delivery (#109, v0.1.43), for every install. Read only.
 *
 * From BOX NOW's Partner API manual (v1.69): OAuth 2.0 client credentials at `POST
 * /api/v1/auth-sessions`, then `GET /api/v1/parcels` with filters (orderNumber, parcelId, state,
 * paymentMode, paymentState). Each parcel carries its events, and, for cash on delivery, whether
 * the money is pending, paid by the customer, or transferred to the partner.
 *
 * The API address (stage or production) and the client id and secret are BOX NOW's, given to the
 * customer when they register as a partner, and typed at setup.
 */
import {
  answer,
  BusinessError,
  businessFetch,
  call,
  checkedBase,
  settingsFrom,
  text,
  vendorSaid,
} from "./business-http";
import type { McpCallResult, McpTool } from "./mcp";

const TITLE = "BOX NOW";

const STATES = [
  "new",
  "in-transit",
  "in-depot",
  "final-destination",
  "delivered",
  "returned",
  "expired-return",
  "canceled",
  "lost",
  "missing",
] as const;
const PAYMENT_STATES = [
  "pending",
  "paid-by-customer",
  "transferred-to-partner",
] as const;

const TOOLS: readonly McpTool[] = Object.freeze([
  {
    name: "find_parcels",
    description:
      "BOX NOW parcels: by the shop's order number or the parcel id, or all in one state. Each with its state, its latest events (where and when), and for cash on delivery the amount and whether it was collected and paid over.",
    inputSchema: {
      type: "object",
      properties: {
        order_number: { type: "string" },
        parcel_id: { type: "string" },
        state: { type: "string", enum: [...STATES] },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
    },
  },
  {
    name: "cash_on_delivery",
    description:
      "Cash-on-delivery parcels by money state: pending (not yet collected), paid-by-customer (collected, not yet paid to the shop) or transferred-to-partner (paid to the shop). With amounts and a total.",
    inputSchema: {
      type: "object",
      properties: {
        payment_state: { type: "string", enum: [...PAYMENT_STATES] },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["payment_state"],
    },
  },
]);

export const listNeedsCredential = false;

export async function listTools(): Promise<McpTool[]> {
  return TOOLS.map((tool) => ({ ...tool }));
}

const tokens = new Map<string, { token: string; until: number }>();

async function accessToken(settings: Record<string, string>): Promise<string> {
  const base = checkedBase(settings.apiUrl, "The BOX NOW API address");
  const key = `${base.toString()}|${settings.clientId}`;
  const held = tokens.get(key);
  if (held && held.until > Date.now()) return held.token;
  const result = await call(
    businessFetch(),
    `${base.toString().replace(/\/$/, "")}/api/v1/auth-sessions`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: settings.clientId,
        client_secret: settings.clientSecret,
      }),
    },
  );
  const body = result.body as Record<string, unknown> | null;
  if (result.status >= 400 || typeof body?.access_token !== "string") {
    throw new BusinessError(
      result.status === 401 || result.status === 403
        ? "BOX NOW refused the client id or secret. Check them with BOX NOW, then connect again in Settings."
        : `BOX NOW did not sign in (${result.status}): ${vendorSaid(result)}`,
    );
  }
  const seconds = typeof body.expires_in === "number" ? body.expires_in : 3600;
  tokens.set(key, {
    token: body.access_token,
    until: Date.now() + Math.max(60, seconds - 60) * 1000,
  });
  return body.access_token;
}

export async function checkBoxNowLogin(
  settings: Record<string, string>,
): Promise<string | null> {
  try {
    tokens.clear();
    await accessToken(settings);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

type Row = Record<string, unknown>;

async function parcels(
  settings: Record<string, string>,
  query: Record<string, string>,
): Promise<Row[]> {
  const token = await accessToken(settings);
  const url = new URL(
    `${checkedBase(settings.apiUrl, "The BOX NOW API address").toString().replace(/\/$/, "")}/api/v1/parcels`,
  );
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  const result = await call(businessFetch(), url.toString(), {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  if (result.status >= 400) {
    throw new BusinessError(
      `BOX NOW said no (${result.status}): ${vendorSaid(result)}`,
    );
  }
  const data = (result.body as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? (data as Row[]) : [];
}

function money(parcel: Row): { amount: string; state: string } | null {
  const request = (parcel.deliveryRequest ?? {}) as Row;
  const payment = (parcel.payment ?? {}) as Row;
  const mode = String(request.paymentMode ?? payment.mode ?? "");
  if (mode !== "cod") return null;
  return {
    amount: String(request.amountToBeCollected ?? "?"),
    state: String(payment.state ?? "?"),
  };
}

export function describeParcel(parcel: Row): string {
  const request = (parcel.deliveryRequest ?? {}) as Row;
  const events = Array.isArray(parcel.events) ? (parcel.events as Row[]) : [];
  const cod = money(parcel);
  return [
    `Parcel ${String(parcel.id)} for order ${String(request.orderNumber ?? "?")}: ${String(parcel.state)}.`,
    ...events
      .slice(-5)
      .map(
        (event) =>
          `  ${String(event.createTime)}: ${String(event.type)}${event.locationDisplayName ? ` at ${String(event.locationDisplayName)}` : ""}`,
      ),
    ...(cod
      ? [`  Cash on delivery: ${cod.amount}, money state ${cod.state}.`]
      : []),
  ].join("\n");
}

export async function callTool(
  connection: { url: string; token?: string },
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  try {
    const settings = settingsFrom(connection.token, TITLE);
    if (toolName === "find_parcels") {
      const query: Record<string, string> = {};
      const order = text(args.order_number, 60);
      const parcel = text(args.parcel_id, 30);
      if (order) query.orderNumber = order;
      if (parcel) query.parcelId = parcel;
      if (STATES.includes(args.state as never))
        query.state = String(args.state);
      if (!order && !parcel && !query.state) {
        return answer(
          "Give an order number, a parcel id, or a state to list.",
          true,
        );
      }
      query.limit = String(
        typeof args.limit === "number"
          ? Math.max(1, Math.min(50, Math.trunc(args.limit)))
          : 20,
      );
      const found = await parcels(settings, query);
      if (found.length === 0)
        return answer("BOX NOW has no parcel that matches.");
      return answer(found.map(describeParcel).join("\n\n"));
    }
    if (toolName === "cash_on_delivery") {
      if (!PAYMENT_STATES.includes(args.payment_state as never)) {
        return answer(
          "Say which money state: pending, paid-by-customer or transferred-to-partner.",
          true,
        );
      }
      const found = await parcels(settings, {
        paymentMode: "cod",
        paymentState: String(args.payment_state),
        limit: String(
          typeof args.limit === "number"
            ? Math.max(1, Math.min(100, Math.trunc(args.limit)))
            : 50,
        ),
      });
      if (found.length === 0) {
        return answer(
          `No cash-on-delivery parcels are ${String(args.payment_state)}.`,
        );
      }
      let cents = 0;
      const lines = found.map((parcel) => {
        const cod = money(parcel);
        const value = Number(cod?.amount);
        if (Number.isFinite(value)) cents += Math.round(value * 100);
        const request = (parcel.deliveryRequest ?? {}) as Row;
        return `- parcel ${String(parcel.id)}, order ${String(request.orderNumber ?? "?")}: ${cod?.amount ?? "?"} (${String(parcel.state)})`;
      });
      return answer(
        [
          `${found.length} cash-on-delivery parcels ${String(args.payment_state)}, ${(cents / 100).toFixed(2)} in all (as BOX NOW lists them; the first ${found.length} only):`,
          ...lines,
        ].join("\n"),
      );
    }
    return answer(`There is no BOX NOW tool called ${toolName}.`, true);
  } catch (error) {
    return answer(
      error instanceof BusinessError ? error.message : "BOX NOW failed.",
      true,
    );
  }
}
