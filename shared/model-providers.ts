/**
 * Where a bot's language model can come from.
 *
 * One list, read by the server (to validate what a person saves and to know how to talk to it) and by
 * the app (to draw the picker), so the two cannot disagree about what exists.
 *
 * The order of the tiers is the product's position: Ark's default is a model that costs the person
 * nothing and leaves their machine nowhere, then a free hosted model, then their own paid key. A
 * plan sign-in appears only where the provider allows an app like this one to offer it.
 */

export type ProviderTier = "local" | "free" | "paid" | "custom" | "plan";

/** The wire protocol a provider speaks. Most speak OpenAI's; two have their own. */
export type ProviderProtocol = "openai" | "anthropic" | "google";

export interface ProviderDefinition {
  id: string;
  name: string;
  tier: ProviderTier;
  protocol: ProviderProtocol;
  /** Where its API lives. For a provider that is `baseUrlEditable`, only the starting suggestion. */
  baseUrl: string;
  /** Whether the person may point it somewhere else (their own server, a gateway). */
  baseUrlEditable: boolean;
  /** Whether a request needs a key. Local servers do not. */
  keyRequired: boolean;
  /** Where a person gets a key, shown beside the field. */
  keyHelpUrl?: string;
  /** Names worth suggesting when the provider's own list cannot be fetched. Never a limit. */
  suggestedModels: readonly string[];
  /** When listing the provider's models, keep only ids matching this expression. */
  modelFilter?: string;
  /** One honest sentence for the picker. */
  summary: string;
  /** What a person should know before choosing it: limits, who sees their data. */
  notes?: readonly string[];
  /**
   * Reaches an address on the person's own computer or network. A hosted deployment refuses these:
   * to a server in a datacentre, "localhost" is the datacentre.
   */
  local?: boolean;
  /** Listed but not usable yet, and the reason, shown instead of a form. */
  unavailable?: string;
}

export const PROVIDERS: readonly ProviderDefinition[] = [
  // ---- on this computer ---------------------------------------------------------------------
  {
    id: "ollama",
    name: "Ollama",
    tier: "local",
    protocol: "openai",
    baseUrl: "http://localhost:11434/v1",
    baseUrlEditable: true,
    keyRequired: false,
    suggestedModels: [],
    summary: "Models that run on this computer. Free, private, and no account.",
    notes: [
      "Quality and speed depend on your computer. Small models are noticeably weaker at using tools and browsing than the large hosted ones.",
    ],
    local: true,
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    tier: "local",
    protocol: "openai",
    baseUrl: "http://localhost:1234/v1",
    baseUrlEditable: true,
    keyRequired: false,
    suggestedModels: [],
    summary: "Models running in LM Studio on this computer.",
    local: true,
  },
  {
    id: "llamacpp",
    name: "llama.cpp",
    tier: "local",
    protocol: "openai",
    baseUrl: "http://localhost:8080/v1",
    baseUrlEditable: true,
    keyRequired: false,
    suggestedModels: [],
    summary: "A llama.cpp server running on this computer.",
    local: true,
  },

  // ---- free hosted, with the person's own free key ------------------------------------------
  {
    id: "openrouter-free",
    name: "OpenRouter (free models)",
    tier: "free",
    protocol: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    baseUrlEditable: false,
    keyRequired: true,
    keyHelpUrl: "https://openrouter.ai/keys",
    suggestedModels: [],
    modelFilter: ":free$",
    summary: "Many open models at no cost, with a free OpenRouter key.",
    notes: [
      "Free models share a small daily allowance per account, and the free line-up changes.",
      "A provider behind a free model may keep prompts. Do not send customer data through it.",
    ],
  },
  {
    id: "groq",
    name: "Groq",
    tier: "free",
    protocol: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    baseUrlEditable: false,
    keyRequired: true,
    keyHelpUrl: "https://console.groq.com/keys",
    suggestedModels: [],
    summary:
      "Very fast open models. A free plan with rate limits, with your own key.",
    notes: [
      "The free plan has per-minute and per-day limits for the whole organisation.",
    ],
  },
  {
    id: "cerebras",
    name: "Cerebras",
    tier: "free",
    protocol: "openai",
    baseUrl: "https://api.cerebras.ai/v1",
    baseUrlEditable: false,
    keyRequired: true,
    keyHelpUrl: "https://cloud.cerebras.ai/",
    suggestedModels: [],
    summary:
      "Fast open models with a limited free allowance, with your own key.",
    notes: [
      "Free access is small and its terms change. Check the limits on your account.",
    ],
  },

  // ---- paid, with the person's own key ------------------------------------------------------
  {
    id: "anthropic",
    name: "Anthropic (Claude)",
    tier: "paid",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com",
    baseUrlEditable: false,
    keyRequired: true,
    keyHelpUrl: "https://console.anthropic.com/settings/keys",
    suggestedModels: [
      "claude-sonnet-5",
      "claude-opus-5-5",
      "claude-haiku-4-5-20251001",
    ],
    summary: "Claude, billed by Anthropic to your own API account.",
    notes: [
      "Use an API key. A Claude.ai subscription cannot be used here: Anthropic does not allow other apps to sign in with it.",
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    tier: "paid",
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    baseUrlEditable: false,
    keyRequired: true,
    keyHelpUrl: "https://platform.openai.com/api-keys",
    suggestedModels: ["gpt-5.5"],
    summary: "OpenAI models, billed by OpenAI to your own API account.",
  },
  {
    id: "google",
    name: "Google Gemini",
    tier: "paid",
    protocol: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    baseUrlEditable: false,
    keyRequired: true,
    keyHelpUrl: "https://aistudio.google.com/apikey",
    suggestedModels: [],
    summary: "Gemini, billed by Google to your own API account.",
    notes: [
      "Use a paid key. Google allows only paid Gemini API use for people in the EU, the UK and Switzerland, and its free tier may use prompts to improve its products.",
      "A Google subscription cannot be used here: Google does not allow other apps to sign in with it.",
    ],
  },
  {
    id: "inception",
    name: "Inception · Mercury 3",
    tier: "paid",
    protocol: "openai",
    baseUrl: "https://api.inceptionlabs.ai/v1",
    baseUrlEditable: false,
    keyRequired: true,
    keyHelpUrl: "https://platform.inceptionlabs.ai/dashboard/api-keys",
    suggestedModels: ["mercury-3"],
    modelFilter: "^mercury-3",
    summary:
      "Mercury 3, a very fast model with a 1M-token context, billed by Inception to your own account.",
    notes: [
      "New Inception accounts start with a free allowance of tokens; after that it is billed per token.",
      "Inception's documentation does not say how it keeps or uses prompts. Check its terms before sending customer data.",
    ],
  },
  {
    id: "xai",
    name: "xAI (Grok)",
    tier: "paid",
    protocol: "openai",
    baseUrl: "https://api.x.ai/v1",
    baseUrlEditable: false,
    keyRequired: true,
    keyHelpUrl: "https://console.x.ai/",
    suggestedModels: [],
    summary: "Grok, billed by xAI to your own API account.",
  },
  {
    id: "azure-openai",
    name: "Azure OpenAI",
    tier: "paid",
    protocol: "openai",
    baseUrl: "",
    baseUrlEditable: true,
    keyRequired: true,
    suggestedModels: [],
    summary: "Models in your own Azure subscription.",
    unavailable:
      "Planned. Azure needs its own deployment names and API version.",
  },

  // ---- any server that speaks the OpenAI API ------------------------------------------------
  {
    id: "openai-compatible",
    name: "Another OpenAI-compatible server",
    tier: "custom",
    protocol: "openai",
    baseUrl: "",
    baseUrlEditable: true,
    keyRequired: false,
    suggestedModels: [],
    summary:
      "vLLM, a company gateway, or any server that speaks the OpenAI API.",
    notes: [
      "The key is optional: a server that needs none is fine, and one that does will refuse requests without it.",
    ],
  },

  // ---- sign in with a subscription ----------------------------------------------------------
  {
    id: "chatgpt-plan",
    name: "ChatGPT subscription",
    tier: "plan",
    protocol: "openai",
    baseUrl: "",
    baseUrlEditable: false,
    keyRequired: false,
    suggestedModels: [],
    summary: "Use the ChatGPT plan you already pay for.",
    unavailable:
      "Waiting for OpenAI's approval for paid apps. Use an OpenAI API key for now.",
  },
  {
    id: "claude-code",
    name: "Claude Code (your own installation)",
    tier: "plan",
    protocol: "anthropic",
    baseUrl: "",
    baseUrlEditable: false,
    keyRequired: false,
    suggestedModels: [],
    summary:
      "Run the Claude Code you have installed, signed in with your own plan.",
    unavailable:
      "Planned. It will run your own unmodified Claude Code; Ark will never see your Claude login.",
  },
];

const byId = new Map(PROVIDERS.map((provider) => [provider.id, provider]));

export function providerById(id: string): ProviderDefinition | undefined {
  return byId.get(id);
}

/** The providers a person can actually set up, in the order the picker shows them. */
export function usableProviders(): ProviderDefinition[] {
  return PROVIDERS.filter((provider) => !provider.unavailable);
}

const MAX_URL_LENGTH = 2048;

export type ConnectionInputProblem =
  | "unknown-provider"
  | "unavailable"
  | "key-required"
  | "base-url-required"
  | "base-url-invalid"
  | "base-url-not-editable";

export type ConnectionInputVerdict =
  | { ok: true; baseUrl: string }
  | { ok: false; problem: ConnectionInputProblem; message: string };

/**
 * Whether what a person typed is a connection this provider can have, and the address it will use.
 *
 * Shape only. Whether an address is one the deployment is willing to contact is a server decision
 * (see `checkAgentEndpoint`), made where the address is stored and again where it is used.
 */
export function checkConnectionInput(input: {
  providerId: string;
  baseUrl?: string | null;
  apiKey?: string | null;
}): ConnectionInputVerdict {
  const provider = providerById(input.providerId);
  if (!provider) {
    return {
      ok: false,
      problem: "unknown-provider",
      message: "That provider is not one Ark knows.",
    };
  }
  if (provider.unavailable) {
    return {
      ok: false,
      problem: "unavailable",
      message: provider.unavailable,
    };
  }
  if (provider.keyRequired && !input.apiKey?.trim()) {
    return {
      ok: false,
      problem: "key-required",
      message: `${provider.name} needs an API key.`,
    };
  }

  const given = input.baseUrl?.trim() ?? "";
  if (!provider.baseUrlEditable) {
    if (given && given.replace(/\/+$/, "") !== provider.baseUrl) {
      return {
        ok: false,
        problem: "base-url-not-editable",
        message: `${provider.name} always uses its own address.`,
      };
    }
    return { ok: true, baseUrl: provider.baseUrl };
  }

  const chosen = given || provider.baseUrl;
  if (!chosen) {
    return {
      ok: false,
      problem: "base-url-required",
      message: `${provider.name} needs the address of the server.`,
    };
  }
  if (chosen.length > MAX_URL_LENGTH) {
    return {
      ok: false,
      problem: "base-url-invalid",
      message: "That address is too long.",
    };
  }
  let url: URL;
  try {
    url = new URL(chosen);
  } catch {
    return {
      ok: false,
      problem: "base-url-invalid",
      message: "That is not a web address.",
    };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      ok: false,
      problem: "base-url-invalid",
      message: "The address must start with http:// or https://.",
    };
  }
  if (url.username || url.password) {
    return {
      ok: false,
      problem: "base-url-invalid",
      message: "Put the key in the key field, not in the address.",
    };
  }
  return { ok: true, baseUrl: chosen.replace(/\/+$/, "") };
}

export interface LocalModelAdvice {
  /** The name to pull in Ollama. */
  model: string;
  /** Memory it wants free, in gigabytes. */
  minMemoryGb: number;
  /** In a sentence, what it is for. */
  fits: string;
}

/**
 * Open models worth trying, largest first, each with the memory it needs.
 *
 * Only models whose licences allow commercial use, because Ark is sold: the Apache-2.0 families.
 * The list is a starting point and goes stale as models do, so it is advice shown with a
 * "recommended" label and never a restriction on what a person may run.
 */
export const LOCAL_MODELS: readonly LocalModelAdvice[] = [
  {
    model: "gpt-oss:20b",
    minMemoryGb: 16,
    fits: "The most capable choice that runs on a good laptop.",
  },
  {
    model: "qwen3:8b",
    minMemoryGb: 8,
    fits: "A balanced choice for everyday work.",
  },
  {
    model: "qwen3:4b",
    minMemoryGb: 6,
    fits: "A small model that runs on most computers.",
  },
  {
    model: "qwen3:1.7b",
    minMemoryGb: 3,
    fits: "Tiny: chat only, and weak at using tools.",
  },
];

/**
 * The models that fit the memory a computer has, best first.
 *
 * `memoryGb` is memory available to a model: system RAM on most computers, graphics memory where
 * there is a GPU the runner uses. Nothing fits below the smallest, which is an answer of its own: the
 * picker then points to a hosted free model instead.
 */
export function recommendLocalModels(memoryGb: number): LocalModelAdvice[] {
  if (!Number.isFinite(memoryGb)) return [];
  return LOCAL_MODELS.filter((advice) => advice.minMemoryGb <= memoryGb);
}
