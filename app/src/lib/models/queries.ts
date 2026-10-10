import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/** Where a model can come from, as the server describes it. See shared/model-providers.ts. */
export type ModelProviderTier = "local" | "free" | "paid" | "custom" | "plan";

export type ModelProvider = {
  id: string;
  name: string;
  tier: ModelProviderTier;
  /** Whether the person may point it at a different address (their own server, a gateway). */
  baseUrlEditable: boolean;
  /** The address it uses unless the person changes it. */
  baseUrl: string;
  keyRequired: boolean;
  keyHelpUrl?: string;
  suggestedModels: string[];
  summary: string;
  notes?: string[];
  /**
   * Set when this cannot be set up here, with the reason in words: a subscription sign-in that is not
   * allowed yet, or a model on your own computer that a hosted server cannot reach. The screen shows
   * the reason and no form.
   */
  unavailable?: string;
};

export type LocalModelAdvice = {
  model: string;
  minMemoryGb: number;
  fits: string;
};

export type ModelCatalogue = {
  providers: ModelProvider[];
  localModels: LocalModelAdvice[];
};

/**
 * One of the person's own connections. There is no key in it, ever: `hasKey` is the whole of what
 * the browser may know about one.
 */
export type ModelConnection = {
  id: string;
  providerId: string;
  label: string;
  baseUrl: string;
  model: string;
  isDefault: boolean;
  hasKey: boolean;
  createdAt: string;
  updatedAt: string;
};

/** One coworker the person pointed at a connection other than their default. */
export type BotModelChoice = {
  botId: string;
  connectionId: string;
};

export const modelKeys = {
  all: ["models"] as const,
  catalogue: () => [...modelKeys.all, "catalogue"] as const,
  connections: () => [...modelKeys.all, "connections"] as const,
  bots: () => [...modelKeys.all, "bots"] as const,
};

export function modelCatalogueQueryOptions() {
  return queryOptions({
    queryKey: modelKeys.catalogue(),
    queryFn: async (): Promise<ModelCatalogue> =>
      (
        await client("/api/models/providers", {
          fallback: "Could not load the list of model providers",
        })
      ).json(),
  });
}

export function modelConnectionsQueryOptions() {
  return queryOptions({
    queryKey: modelKeys.connections(),
    queryFn: async (): Promise<ModelConnection[]> =>
      client("/api/models/connections", "connections", {
        fallback: "Could not load your models",
      }),
  });
}

export function botModelChoicesQueryOptions() {
  return queryOptions({
    queryKey: modelKeys.bots(),
    queryFn: async (): Promise<BotModelChoice[]> =>
      client("/api/models/bots", "choices", {
        fallback: "Could not load which model each coworker uses",
      }),
  });
}
