import { z } from "zod";

const INSTRUCTIONS_TOO_LONG = "Instructions must be 8000 characters or fewer.";

/** The instructions field on its own, for the screen that edits just that. */
export const instructionsSchema = z.string().max(8000, INSTRUCTIONS_TOO_LONG);

/**
 * Browser-side coworker form contract. Limits match the server parser so validation errors can be
 * shown next to fields before submit.
 */
export const agentFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required.")
    .max(80, "Name must be 80 characters or fewer."),
  title: z
    .string()
    .trim()
    .min(1, "Title is required.")
    .max(120, "Title must be 120 characters or fewer."),
  roleDescription: z
    .string()
    .trim()
    .min(1, "Role description is required.")
    .max(1000, "Role description must be 1000 characters or fewer."),
  /**
   * The full standing instruction. Left out, an edit leaves it alone; empty clears it, which puts the
   * role description back as the whole instruction.
   */
  persona: z.string().max(8000, INSTRUCTIONS_TOO_LONG).optional(),
  visibility: z.enum(["public", "private"]),
  /**
   * The AG-UI endpoint this coworker runs on. Empty means the Bot in the box.
   *
   * Only URL shape is checked here; deployment allow/deny rules are server-side.
   */
  endpoint: z
    .string()
    .trim()
    .refine(
      (value) => value === "" || /^https?:\/\/\S+$/.test(value),
      "Enter a web address starting with http:// or https://.",
    ),
  /**
   * A key the agent sits behind. WRITE-ONLY: it is never sent back from the server, so this field is
   * always empty when editing, and leaving it empty keeps whatever key is already set.
   */
  authValue: z.string(),
  /**
   * Where it runs. Left out, the coworker keeps wherever it runs now (or the cloud, when new): only
   * a person who chose a place sends one.
   */
  runLocation: z.enum(["cloud", "device"]).optional(),
});

export type AgentFormValues = z.infer<typeof agentFormSchema>;

export const emptyAgentForm: AgentFormValues = {
  name: "",
  title: "",
  roleDescription: "",
  visibility: "private",
  endpoint: "",
  authValue: "",
};

/** Convert form values to API input; omit an empty key so editing preserves the current credential. */
export function agentInputFrom(values: AgentFormValues) {
  return {
    name: values.name,
    title: values.title,
    roleDescription: values.roleDescription,
    ...(values.persona !== undefined ? { persona: values.persona } : {}),
    visibility: values.visibility,
    endpoint: values.endpoint,
    ...(values.runLocation ? { runLocation: values.runLocation } : {}),
    ...(values.authValue.trim()
      ? { auth: { header: "Authorization", value: values.authValue.trim() } }
      : {}),
  };
}
