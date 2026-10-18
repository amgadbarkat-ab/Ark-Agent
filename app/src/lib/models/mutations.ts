import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";
import { type ModelConnection, modelKeys } from "./queries";

const FALLBACK = "Could not save the model";

export type ModelConnectionInput = {
  providerId: string;
  label?: string;
  baseUrl?: string;
  /** Held by the server, encrypted, and never shown again. */
  apiKey?: string;
  model: string;
};

export type ModelConnectionPatch = {
  label?: string;
  baseUrl?: string;
  /** A new key. Empty text removes the stored one, for a provider that does not need it. */
  apiKey?: string;
  model?: string;
};

function invalidate(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: modelKeys.all });
}

export function createModelConnectionMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: ModelConnectionInput): Promise<ModelConnection> =>
      client("/api/models/connections", "connection", {
        method: "POST",
        body: input,
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidate(queryClient),
  });
}

export function updateModelConnectionMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      id: string;
      patch: ModelConnectionPatch;
    }): Promise<ModelConnection> =>
      client(`/api/models/connections/${variables.id}`, "connection", {
        method: "PATCH",
        body: variables.patch,
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidate(queryClient),
  });
}

export function removeModelConnectionMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (id: string): Promise<void> => {
      await client(`/api/models/connections/${id}`, {
        method: "DELETE",
        fallback: "Could not remove the model",
      });
    },
    onSuccess: () => invalidate(queryClient),
  });
}

export function setDefaultModelMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (id: string): Promise<void> => {
      await client(`/api/models/connections/${id}/default`, {
        method: "POST",
        fallback: "Could not change your default model",
      });
    },
    onSuccess: () => invalidate(queryClient),
  });
}

/** What testing a connection answers: it works and here are its models, or why it does not. */
export type ModelProbe =
  | { ok: true; models: string[] }
  | { ok: false; reason: string };

async function probeFrom(response: Response): Promise<ModelProbe> {
  const body = (await response.json().catch(() => undefined)) as
    | (ModelProbe & { error?: string })
    | undefined;
  if (response.ok && body && "ok" in body) return body;
  return {
    ok: false,
    reason: body?.error ?? "Could not test that connection.",
  };
}

/**
 * Tests a connection that has not been saved, with whatever is in the form.
 *
 * A plain function: it is a verdict about this moment, so a refusal is the answer and not an
 * exception, and there is nothing cached for it to invalidate. The key travels in the body, is used
 * once, and is not kept.
 */
export async function probeModelConnection(input: {
  providerId: string;
  baseUrl?: string;
  apiKey?: string;
}): Promise<ModelProbe> {
  return probeFrom(
    await tryClient("/api/models/probe", { method: "POST", body: input }),
  );
}

/** Tests one that is saved, with the key the server holds for it. */
export async function probeSavedModelConnection(
  id: string,
): Promise<ModelProbe> {
  return probeFrom(
    await tryClient(`/api/models/connections/${id}/probe`, { method: "POST" }),
  );
}

/** Point one coworker at one of the person's models, or null to go back to their default. */
export function setBotModelMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      botId: string;
      connectionId: string | null;
    }): Promise<void> => {
      await client(`/api/models/bots/${encodeURIComponent(variables.botId)}`, {
        method: "PUT",
        body: { connectionId: variables.connectionId },
        fallback: "Could not change the model for that digital employee",
      });
    },
    onSuccess: () => invalidate(queryClient),
  });
}
