/**
 * Ark Private Server (#149; COO's tiers, prices approved by Amgad 19 Nov 17:45): a server BlackArk
 * sets up for this customer alone, to run an open model on.
 *
 * WHAT IS SENT. To blackark.uk/checkin/servers/, and only this: the customer id, this install's random
 * id and BlackArk's own proof of it (trial/install-proof.ts), exactly as for Help & support and the
 * licence. Nothing a person wrote.
 *
 * WHAT COMES BACK. The tiers as BlackArk sells them (storage, the model each suits, the price), the
 * address of BlackArk's buy page, and this customer's latest order: being set up by BlackArk, ready,
 * stopped or cancelled. Once BlackArk has set it up, the order carries the server's address, model and
 * key. The key is kept only in memory here and is never sent to a browser: `connect` puts it into the
 * person's model connections, encrypted, where every other key lives.
 *
 * Buying happens on BlackArk's page in the person's browser (Stripe Checkout); this file never sees a
 * card or an amount being charged.
 */
import { checkConnectionInput } from "../../../shared/model-providers";
import type { Database } from "../db/client";
import type {
  ModelConnection,
  ModelConnectionStore,
} from "../models/connections";
import { installIdentity } from "../trial/install-proof";

export const DEFAULT_SERVERS_URL = "https://blackark.uk/checkin/servers/";
export const PRIVATE_SERVER_PROVIDER = "blackark-private-server";
const FRESH_MS = 60_000;

export type ServerTier = {
  id: string;
  name: string;
  cpu: string | null;
  memory: string;
  gpu: string | null;
  storage: string;
  modelSize: string;
  models: string[];
  monthlyCents: number;
  activationCents: number;
};

export type ServerOrderStatus =
  | "setting_up"
  | "ready"
  | "stopped"
  | "cancelled";

/** An order as the app may show it: no key, ever. */
export type ServerOrderView = {
  tier: string;
  status: ServerOrderStatus;
  orderedAt: string;
  paidUntil: string | null;
  readyAt: string | null;
  baseUrl: string | null;
  model: string | null;
};

export type PrivateServerView = {
  /** False when this install has no BlackArk proof yet (not activated), so it cannot ask. */
  available: boolean;
  tiers: ServerTier[];
  order: ServerOrderView | null;
  /** BlackArk's buy page for this customer; the tier id goes on the end. Null until known. */
  buyUrl: string | null;
  /** Whether this person's model connections already use the ready server. */
  connected: boolean;
  /** A sentence for the app when BlackArk could not be asked. */
  error: string | null;
};

export class PrivateServerNotReadyError extends Error {}

type Answer = {
  tiers: ServerTier[];
  order: (ServerOrderView & { apiKey: string | null }) | null;
  buyUrl: string;
};

const STATUSES = new Set(["setting_up", "ready", "stopped", "cancelled"]);
const text = (value: unknown, max = 200) =>
  typeof value === "string" && value.length <= max ? value : null;
const cents = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;

/** BlackArk's answer, checked field by field; null when it is not one. */
export function readServersAnswer(raw: unknown): Answer | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  if (!Array.isArray(body.tiers) || body.tiers.length > 20) return null;
  const tiers: ServerTier[] = [];
  for (const item of body.tiers) {
    const tier = (item ?? {}) as Record<string, unknown>;
    const id = text(tier.id, 40);
    const name = text(tier.name);
    const memory = text(tier.memory, 80);
    const storage = text(tier.storage, 80);
    const modelSize = text(tier.modelSize, 40);
    const monthly = cents(tier.monthlyCents);
    const activation = cents(tier.activationCents);
    const models = Array.isArray(tier.models)
      ? tier.models.filter((m): m is string => text(m, 80) !== null)
      : null;
    if (
      !id ||
      !/^[a-z0-9_]+$/.test(id) ||
      !name ||
      !memory ||
      !storage ||
      !modelSize ||
      monthly === null ||
      activation === null ||
      !models
    )
      return null;
    tiers.push({
      id,
      name,
      cpu: text(tier.cpu, 80),
      memory,
      gpu: text(tier.gpu, 80),
      storage,
      modelSize,
      models: models.slice(0, 10),
      monthlyCents: monthly,
      activationCents: activation,
    });
  }
  const buyUrl = text(body.buyUrl, 400);
  if (!buyUrl?.startsWith("https://")) return null;
  let order: Answer["order"] = null;
  if (body.order !== null && body.order !== undefined) {
    const o = body.order as Record<string, unknown>;
    const status = text(o.status, 20);
    const tier = text(o.tier, 40);
    const orderedAt = text(o.orderedAt, 40);
    if (!status || !STATUSES.has(status) || !tier || !orderedAt) return null;
    const baseUrl = text(o.baseUrl, 300);
    order = {
      tier,
      status: status as ServerOrderStatus,
      orderedAt,
      paidUntil: text(o.paidUntil, 40),
      readyAt: text(o.readyAt, 40),
      baseUrl: baseUrl?.startsWith("https://") ? baseUrl : null,
      model: text(o.model, 120),
      apiKey: text(o.apiKey, 512),
    };
  }
  return { tiers, order, buyUrl };
}

export type PrivateServerService = ReturnType<
  typeof createPrivateServerService
>;

export function createPrivateServerService(
  database: Database,
  dependencies: {
    connections: ModelConnectionStore;
    version: string;
    url?: string;
    send?: typeof fetch;
    now?: () => number;
  },
) {
  const url = dependencies.url ?? DEFAULT_SERVERS_URL;
  const send = dependencies.send ?? fetch;
  const now = dependencies.now ?? Date.now;
  let cached: { at: number; answer: Answer } | null = null;
  let lastError: string | null = null;

  /** BlackArk's answer, at most a minute old unless `fresh`; null when it cannot be asked. */
  async function ask(fresh = false): Promise<Answer | null> {
    if (!fresh && cached && now() - cached.at < FRESH_MS) return cached.answer;
    const who = await installIdentity(database);
    if (!who) return null;
    try {
      const response = await send(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          customerId: who.customerId,
          installId: who.installId,
          version: dependencies.version,
          proof: who.proof,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        lastError =
          response.status === 403
            ? "BlackArk did not recognise this install. Activate ArkAgent first."
            : "BlackArk could not be reached. Try again in a few minutes.";
        return cached?.answer ?? null;
      }
      const answer = readServersAnswer(await response.json().catch(() => null));
      if (!answer) {
        lastError = "BlackArk's answer could not be read. Try again later.";
        return cached?.answer ?? null;
      }
      cached = { at: now(), answer };
      lastError = null;
      return answer;
    } catch {
      lastError = "BlackArk could not be reached. Try again in a few minutes.";
      return cached?.answer ?? null;
    }
  }

  async function serverConnection(
    userId: string,
    baseUrl: string | null,
  ): Promise<ModelConnection | undefined> {
    if (!baseUrl) return undefined;
    return (await dependencies.connections.list(userId)).find(
      (c) => c.providerId === PRIVATE_SERVER_PROVIDER && c.baseUrl === baseUrl,
    );
  }

  return {
    async view(userId: string): Promise<PrivateServerView> {
      const available = (await installIdentity(database)) !== null;
      const answer = available ? await ask() : null;
      const order = answer?.order ?? null;
      const ready = order?.status === "ready";
      return {
        available,
        tiers: answer?.tiers ?? [],
        order: order
          ? {
              tier: order.tier,
              status: order.status,
              orderedAt: order.orderedAt,
              paidUntil: order.paidUntil,
              readyAt: order.readyAt,
              baseUrl: ready ? order.baseUrl : null,
              model: ready ? order.model : null,
            }
          : null,
        buyUrl: answer?.buyUrl ?? null,
        connected: ready
          ? (await serverConnection(userId, order?.baseUrl ?? null)) !==
            undefined
          : false,
        error: available ? lastError : null,
      };
    },

    /**
     * Puts the ready server into this person's model connections, or brings the one already there up
     * to date (BlackArk may change its key or model), and makes it their default. Asks BlackArk afresh,
     * so a key is never taken from an answer older than this click.
     */
    async connect(userId: string): Promise<ModelConnection> {
      const answer = await ask(true);
      const order = answer?.order;
      if (
        order?.status !== "ready" ||
        !order.baseUrl ||
        !order.model ||
        !order.apiKey
      ) {
        throw new PrivateServerNotReadyError(
          "Your private server is not ready yet. It will be ready within 1 working day of payment.",
        );
      }
      const verdict = checkConnectionInput({
        providerId: PRIVATE_SERVER_PROVIDER,
        baseUrl: order.baseUrl,
        apiKey: order.apiKey,
      });
      if (!verdict.ok) throw new PrivateServerNotReadyError(verdict.message);
      const tier = answer?.tiers.find((t) => t.id === order.tier);
      const label = tier?.name ?? "Ark Private Server";
      const existing = await serverConnection(userId, verdict.baseUrl);
      const connection = existing
        ? await dependencies.connections.update(userId, existing.id, {
            label,
            model: order.model,
            apiKey: order.apiKey,
          })
        : await dependencies.connections.create(userId, {
            providerId: PRIVATE_SERVER_PROVIDER,
            label,
            baseUrl: verdict.baseUrl,
            model: order.model,
            apiKey: order.apiKey,
          });
      if (!connection) throw new PrivateServerNotReadyError("Try again.");
      return (
        (await dependencies.connections.setDefault(userId, connection.id)) ??
        connection
      );
    },
  };
}
