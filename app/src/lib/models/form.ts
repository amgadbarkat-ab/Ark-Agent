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
