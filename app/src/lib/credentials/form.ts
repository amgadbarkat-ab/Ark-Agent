import { z } from "zod";
import { tNow } from "@/lib/i18n";

export const credentialFormSchema = z.object({
  kind: z.enum(["model", "connector"]),
  provider: z.string().trim().min(1, tNow("Provider is required.")),
  keyId: z.string().trim().min(1, "Key ID is required."),
  plaintext: z.string().min(1, tNow("Secret is required.")),
});

export type CredentialFormValues = z.infer<typeof credentialFormSchema>;
