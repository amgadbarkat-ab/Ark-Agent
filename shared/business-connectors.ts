/**
 * The business connectors (#109, v0.1.43): Skroutz, WooCommerce, BOX NOW, and later ELTA Courier.
 *
 * GENERAL, NOT ANY CUSTOMER'S. Every install has every connector. The credentials are typed at the
 * setup session, on that computer, into Settings → Connect your Data. They are stored encrypted on
 * that computer only and never come back out. Nothing here names a customer.
 *
 * One list, read by the server (which fields a connection must have) and by the app (the form).
 */
export type BusinessField = {
  name: string;
  label: string;
  /** Masked when typed, and never shown again. */
  secret?: boolean;
  optional?: boolean;
  placeholder?: string;
  help?: string;
  /** Must be an https:// address. */
  url?: boolean;
  /** For a `url` field: plain http:// is allowed too (ELTA serves only http). */
  allowHttp?: boolean;
};

export type BusinessConnector = {
  key: "skroutz" | "woocommerce" | "boxnow" | "elta";
  title: string;
  summary: string;
  /** Where the customer gets what the form asks for. */
  whereToGet: string;
  fields: readonly BusinessField[];
};

export const BUSINESS_CONNECTORS: readonly BusinessConnector[] = [
  {
    key: "skroutz",
    title: "Skroutz (Smart Cart orders and Skroutz Last Mile)",
    summary:
      "Read Smart Cart orders by their code, with their state and their Skroutz Last Mile or courier tracking. New orders are found from Skroutz's emails in the Mailbox. Accepting, rejecting or marking an order ready waits for your approval.",
    whereToGet:
      "In the Skroutz merchant panel: Merchants, then Services, then Skroutz Marketplace, then the API token. Making a new token cancels the old one.",
    fields: [{ name: "apiToken", label: "API token", secret: true }],
  },
  {
    key: "woocommerce",
    title: "WooCommerce (orders and stock)",
    summary:
      "Read the shop's orders, products, prices and stock. Changing a stock level or a price waits for your approval.",
    whereToGet:
      "In WordPress: WooCommerce, then Settings, then Advanced, then REST API, then Add key. Read for reading only, Read/Write to allow approved changes.",
    fields: [
      {
        name: "siteUrl",
        label: "Shop address",
        url: true,
        placeholder: "https://shop.example.gr",
      },
      { name: "consumerKey", label: "Consumer key", placeholder: "ck_…" },
      {
        name: "consumerSecret",
        label: "Consumer secret",
        secret: true,
        placeholder: "cs_…",
      },
    ],
  },
  {
    key: "boxnow",
    title: "BOX NOW (parcels, tracking and cash on delivery)",
    summary:
      "Read parcels, where each one is, and whether cash on delivery was collected and paid over. Read only.",
    whereToGet:
      "From BOX NOW, after registering as a partner: the API address (API_URL), the client id and the client secret. Use the stage address first.",
    fields: [
      {
        name: "apiUrl",
        label: "API address (API_URL)",
        url: true,
        placeholder: "https://…",
      },
      { name: "clientId", label: "Client id" },
      { name: "clientSecret", label: "Client secret", secret: true },
    ],
  },
  {
    key: "elta",
    title: "ELTA Courier (shipment tracking)",
    summary:
      "Read where each ELTA Courier shipment is, its tracking events, and when and to whom it was delivered. Read only.",
    whereToGet:
      "From ELTA Courier, for a contract customer: ask the branch, 210 607 3000 or info@elta-courier.gr for web service access. They give the customer code, the user code and the password. ELTA's service uses plain http.",
    fields: [
      { name: "customerCode", label: "Customer code" },
      { name: "userCode", label: "User code", placeholder: "123456" },
      { name: "password", label: "Password", secret: true },
      {
        name: "serviceUrl",
        label: "Service address (optional)",
        optional: true,
        url: true,
        allowHttp: true,
        placeholder: "http://212.205.47.226:9003",
        help: "Leave empty for ELTA's usual address. Change it only if ELTA gives you another one.",
      },
    ],
  },
];

export type BusinessConnectorKey = BusinessConnector["key"];

export function businessConnector(key: string): BusinessConnector | undefined {
  return BUSINESS_CONNECTORS.find((connector) => connector.key === key);
}

/** The fields a form sent, checked against the connector's list. Throws a sentence a person reads. */
export function businessSettingsFrom(
  connector: BusinessConnector,
  body: unknown,
): Record<string, string> {
  const raw = (body ?? {}) as Record<string, unknown>;
  const settings: Record<string, string> = {};
  for (const field of connector.fields) {
    const value = typeof raw[field.name] === "string" ? raw[field.name] : "";
    const trimmed = (value as string).trim();
    if (!trimmed) {
      if (field.optional) continue;
      throw new Error(`Fill in ${field.label}.`);
    }
    if (trimmed.length > 2000) throw new Error(`${field.label} is too long.`);
    if (field.url) {
      let parsed: URL;
      try {
        parsed = new URL(trimmed);
      } catch {
        throw new Error(`${field.label} is not an address.`);
      }
      if (
        parsed.protocol !== "https:" &&
        !(field.allowHttp && parsed.protocol === "http:")
      ) {
        throw new Error(`${field.label} must start with https://.`);
      }
      settings[field.name] = parsed.toString().replace(/\/$/, "");
      continue;
    }
    settings[field.name] = trimmed;
  }
  const unknown = Object.keys(raw).filter(
    (name) => !connector.fields.some((field) => field.name === name),
  );
  if (unknown.length > 0) throw new Error("The form sent an unknown field.");
  return settings;
}
