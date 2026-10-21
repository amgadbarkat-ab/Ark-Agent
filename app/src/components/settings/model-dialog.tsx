import { useForm, useStore } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { modelFormSchema } from "@/lib/models/form";
import {
  createModelConnectionMutationOptions,
  type ModelProbe,
  probeModelConnection,
  probeSavedModelConnection,
  removeModelConnectionMutationOptions,
  setDefaultModelMutationOptions,
  updateModelConnectionMutationOptions,
} from "@/lib/models/mutations";
import type {
  ModelCatalogue,
  ModelConnection,
  ModelProvider,
  ModelProviderTier,
} from "@/lib/models/queries";
import { queryClient } from "@/query-client";

/** The order and wording of the picker: what costs nothing first, then what the person pays for. */
const TIER_GROUPS: { tier: ModelProviderTier; label: string }[] = [
  { tier: "local", label: "On this computer" },
  { tier: "free", label: "Free, hosted (with your own free key)" },
  { tier: "paid", label: "Your own paid key" },
  { tier: "custom", label: "Another server" },
];

export function ModelDialog({
  catalogue,
  connection,
  initialProviderId,
  onOpenChange,
  open,
}: {
  catalogue: ModelCatalogue;
  /** The connection being changed. Absent means a new one is being added. */
  connection?: ModelConnection;
  /** For a new one: the provider to start on, when it was chosen from the list of what is available. */
  initialProviderId?: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        {/* Mounted only while open, so every opening starts from a clean form and a clean test. */}
        <ModelForm
          catalogue={catalogue}
          connection={connection}
          initialProviderId={initialProviderId}
          key={connection?.id ?? `new-${initialProviderId ?? ""}`}
          onDone={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function usable(providers: ModelProvider[]) {
  return providers.filter((provider) => !provider.unavailable);
}

function ModelForm({
  catalogue,
  connection,
  initialProviderId,
  onDone,
}: {
  catalogue: ModelCatalogue;
  connection?: ModelConnection;
  initialProviderId?: string;
  onDone: () => void;
}) {
  const editing = connection !== undefined;
  const choices = usable(catalogue.providers);
  const first =
    choices.find((provider) => provider.id === initialProviderId) ?? choices[0];

  const create = useMutation(createModelConnectionMutationOptions(queryClient));
  const update = useMutation(updateModelConnectionMutationOptions(queryClient));
  const remove = useMutation(removeModelConnectionMutationOptions(queryClient));
  const makeDefault = useMutation(setDefaultModelMutationOptions(queryClient));
  const [probe, setProbe] = useState<ModelProbe | undefined>();
  const [testing, setTesting] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const form = useForm({
    defaultValues: {
      providerId: connection?.providerId ?? first?.id ?? "",
      label: connection?.label ?? "",
      baseUrl: connection?.baseUrl ?? first?.baseUrl ?? "",
      apiKey: "",
      model: connection?.model ?? first?.suggestedModels[0] ?? "",
    },
    validators: { onSubmit: modelFormSchema },
    onSubmit: async ({ value }) => {
      if (!provider) return;
      if (connection) {
        await update.mutateAsync({
          id: connection.id,
          patch: {
            ...(value.label ? { label: value.label } : {}),
            ...(provider.baseUrlEditable && value.baseUrl !== connection.baseUrl
              ? { baseUrl: value.baseUrl }
              : {}),
            ...(value.apiKey ? { apiKey: value.apiKey } : {}),
            model: value.model,
          },
        });
      } else {
        await create.mutateAsync({
          providerId: value.providerId,
          ...(value.label ? { label: value.label } : {}),
          ...(provider.baseUrlEditable ? { baseUrl: value.baseUrl } : {}),
          ...(value.apiKey ? { apiKey: value.apiKey } : {}),
          model: value.model,
        });
      }
      onDone();
    },
  });

  const providerId = useStore(form.store, (state) => state.values.providerId);
  const provider = catalogue.providers.find((p) => p.id === providerId);
  const saving = create.isPending || update.isPending;
  const failure = (create.error ?? update.error ?? remove.error)?.message;

  // What the model box suggests: what the provider just said it has, then what we know is good.
  const suggestions = [
    ...new Set([
      ...(probe?.ok ? probe.models : []),
      ...(provider?.suggestedModels ?? []),
      ...(provider?.tier === "local"
        ? catalogue.localModels.map((advice) => advice.model)
        : []),
    ]),
  ];

  async function test() {
    if (!provider) return;
    const { baseUrl, apiKey } = form.state.values;
    setTesting(true);
    try {
      setProbe(
        connection && !apiKey
          ? await probeSavedModelConnection(connection.id)
          : await probeModelConnection({
              providerId: provider.id,
              ...(provider.baseUrlEditable && baseUrl ? { baseUrl } : {}),
              ...(apiKey ? { apiKey } : {}),
            }),
      );
    } finally {
      setTesting(false);
    }
  }

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        form.handleSubmit();
      }}
    >
      <DialogHeader>
        <DialogTitle>{editing ? "Change model" : "Add a model"}</DialogTitle>
        <DialogDescription>
          Your digital employees think with the model you choose. Keys are held
          encrypted and are never shown again.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="mt-4 overflow-y-auto">
        <FieldGroup>
          {editing ? null : (
            <form.Field name="providerId">
              {(field) => (
                <Field>
                  <FieldLabel htmlFor={field.name}>
                    Where it comes from
                  </FieldLabel>
                  <Select
                    onValueChange={(value) => {
                      const next = catalogue.providers.find(
                        (p) => p.id === value,
                      );
                      field.handleChange(String(value));
                      if (next) {
                        // A different provider is a different address and a different set of models.
                        form.setFieldValue("baseUrl", next.baseUrl);
                        form.setFieldValue(
                          "model",
                          next.suggestedModels[0] ?? "",
                        );
                        form.setFieldValue("apiKey", "");
                      }
                      setProbe(undefined);
                    }}
                    value={field.state.value}
                  >
                    <SelectTrigger id={field.name}>
                      {/* The name, not the id the value is stored as. */}
                      <SelectValue>{provider?.name}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {TIER_GROUPS.map(({ tier, label }) => {
                        const group = choices.filter((p) => p.tier === tier);
                        return group.length === 0 ? null : (
                          <SelectGroup key={tier}>
                            <SelectLabel>{label}</SelectLabel>
                            {group.map((p) => (
                              <SelectItem key={p.id} value={p.id}>
                                {p.name}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        );
                      })}
                    </SelectContent>
                  </Select>
                </Field>
              )}
            </form.Field>
          )}

          {provider ? (
            <div className="space-y-1 text-muted-foreground text-sm">
              <p>{provider.summary}</p>
              {provider.notes?.map((note) => (
                <p key={note}>{note}</p>
              ))}
              {provider.keyHelpUrl && !editing ? (
                <p>
                  <a
                    className="underline underline-offset-2"
                    href={provider.keyHelpUrl}
                    rel="noreferrer"
                    target="_blank"
                  >
                    Get a key
                  </a>
                </p>
              ) : null}
            </div>
          ) : null}

          <form.Field name="label">
            {(field) => (
              <Field>
                <FieldLabel htmlFor={field.name}>Name</FieldLabel>
                <Input
                  id={field.name}
                  name={field.name}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder={provider?.name ?? "My model"}
                  value={field.state.value}
                />
              </Field>
            )}
          </form.Field>

          {provider?.baseUrlEditable ? (
            <form.Field name="baseUrl">
              {(field) => (
                <Field>
                  <FieldLabel htmlFor={field.name}>Address</FieldLabel>
                  <Input
                    autoComplete="off"
                    id={field.name}
                    name={field.name}
                    onBlur={field.handleBlur}
                    onChange={(event) => {
                      field.handleChange(event.target.value);
                      setProbe(undefined);
                    }}
                    placeholder="https://"
                    value={field.state.value}
                  />
                </Field>
              )}
            </form.Field>
          ) : null}

          {provider && (provider.keyRequired || provider.tier === "custom") ? (
            <form.Field name="apiKey">
              {(field) => (
                <Field>
                  <FieldLabel htmlFor={field.name}>
                    API key{provider.keyRequired ? "" : " (optional)"}
                  </FieldLabel>
                  <Input
                    autoComplete="off"
                    id={field.name}
                    name={field.name}
                    onBlur={field.handleBlur}
                    onChange={(event) => {
                      field.handleChange(event.target.value);
                      setProbe(undefined);
                    }}
                    placeholder={
                      connection?.hasKey ? "Saved. Type to replace it." : ""
                    }
                    type="password"
                    value={field.state.value}
                  />
                </Field>
              )}
            </form.Field>
          ) : null}

          <form.Field name="model">
            {(field) => {
              const invalid =
                field.state.meta.isTouched && !field.state.meta.isValid;
              return (
                <Field data-invalid={invalid}>
                  <FieldLabel htmlFor={field.name}>Model</FieldLabel>
                  {suggestions.length > 0 ? (
                    <Select
                      onValueChange={(value) =>
                        field.handleChange(String(value))
                      }
                      value={
                        suggestions.includes(field.state.value)
                          ? field.state.value
                          : ""
                      }
                    >
                      <SelectTrigger
                        aria-label={`Choose one of ${suggestions.length} models`}
                        className="w-full"
                      >
                        <SelectValue>
                          {suggestions.includes(field.state.value)
                            ? field.state.value
                            : `Choose from ${suggestions.length} models`}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {suggestions.map((name) => (
                          <SelectItem key={name} value={name}>
                            {name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : null}
                  <Input
                    aria-invalid={invalid}
                    autoComplete="off"
                    id={field.name}
                    name={field.name}
                    onBlur={field.handleBlur}
                    onChange={(event) => field.handleChange(event.target.value)}
                    placeholder={
                      provider?.tier === "local"
                        ? "qwen3:8b"
                        : "Or type a model name"
                    }
                    value={field.state.value}
                  />
                  <FieldDescription>
                    {probe?.ok
                      ? "Every model this provider offers is in the list above."
                      : "Press Test to see what this provider offers."}
                  </FieldDescription>
                  {invalid ? (
                    <FieldError errors={field.state.meta.errors} />
                  ) : null}
                </Field>
              );
            }}
          </form.Field>

          <div className="flex items-center gap-3">
            <Button
              disabled={testing || !provider}
              onClick={test}
              size="sm"
              type="button"
              variant="outline"
            >
              {testing ? "Testing…" : "Test connection"}
            </Button>
            {probe?.ok ? (
              <p
                className="text-sm text-emerald-600 dark:text-emerald-500"
                role="status"
              >
                Connected.{" "}
                {probe.models.length === 1
                  ? "1 model found."
                  : `${probe.models.length} models found.`}
              </p>
            ) : probe ? (
              <p className="text-destructive text-sm" role="alert">
                {probe.reason}
              </p>
            ) : null}
          </div>

          {failure ? (
            <p className="text-destructive text-sm" role="alert">
              {failure}
            </p>
          ) : null}
        </FieldGroup>
      </DialogBody>
      <DialogFooter className="mt-4">
        {connection ? (
          <div className="mr-auto flex gap-2">
            {connection.isDefault ? null : (
              <Button
                disabled={makeDefault.isPending}
                onClick={async () => {
                  await makeDefault.mutateAsync(connection.id);
                  onDone();
                }}
                size="sm"
                type="button"
                variant="ghost"
              >
                Make default
              </Button>
            )}
            {confirmRemove ? (
              <Button
                disabled={remove.isPending}
                onClick={async () => {
                  await remove.mutateAsync(connection.id);
                  onDone();
                }}
                size="sm"
                type="button"
                variant="destructive"
              >
                {remove.isPending ? "Removing…" : "Remove for good"}
              </Button>
            ) : (
              <Button
                onClick={() => setConfirmRemove(true)}
                size="sm"
                type="button"
                variant="ghost"
              >
                Remove
              </Button>
            )}
          </div>
        ) : null}
        <Button onClick={onDone} size="sm" type="button" variant="ghost">
          Cancel
        </Button>
        <form.Subscribe
          selector={(state) => [state.canSubmit, state.isSubmitting]}
        >
          {([canSubmit, isSubmitting]) => (
            <Button
              disabled={!canSubmit || isSubmitting || saving}
              size="sm"
              type="submit"
            >
              {isSubmitting || saving ? "Saving…" : "Save"}
            </Button>
          )}
        </form.Subscribe>
      </DialogFooter>
    </form>
  );
}
