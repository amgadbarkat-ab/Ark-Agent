import { z } from "zod";

/**
 * What the Add/Edit model dialog collects.
 *
 * The key is optional here because whether one is needed depends on the provider, which the server
 * decides and says in plain words; this only refuses what no provider could accept.
 */
export const modelFormSchema = z.object({
  providerId: z.string().min(1, "Choose where the model comes from."),
  label: z.string().trim().max(80, "Keep the name under 80 characters."),
  baseUrl: z.string().trim().max(2048),
  apiKey: z.string().max(4096),
  model: z.string().trim().min(1, "Choose a model."),
});

export type ModelFormValues = z.infer<typeof modelFormSchema>;

/**
 * Whether a model name is one a provider offers for nothing.
 *
 * OpenRouter marks them with a `:free` suffix. They are shared and small, and they are the models
 * most likely to ignore a digital employee's role and instructions or to be unable to call a tool at
 * all, so the person is told before they judge ArkAgent by one.
 */
export function isFreeModel(model: string): boolean {
  return /:free$/i.test(model.trim());
}

export const FREE_MODEL_NOTE =
  "Free models are shared and small. They often ignore a digital employee's role and instructions, or cannot use tools such as asking a colleague. For a demo or real work, choose a paid model.";
