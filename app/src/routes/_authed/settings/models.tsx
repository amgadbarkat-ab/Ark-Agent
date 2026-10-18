import {
  IconChevronRight,
  IconCloud,
  IconCpu,
  IconPlus,
  IconRobot,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import React, { useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { ModelDialog } from "@/components/settings/model-dialog";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import { setBotModelMutationOptions } from "@/lib/models/mutations";
import {
  botModelChoicesQueryOptions,
  type ModelCatalogue,
  type ModelConnection,
  type ModelProviderTier,
  modelCatalogueQueryOptions,
  modelConnectionsQueryOptions,
} from "@/lib/models/queries";
import { queryClient } from "@/query-client";

/** The value the picker uses for "no choice of its own", which the server stores as no row. */
const DEFAULT_MODEL = "default";

export const Route = createFileRoute("/_authed/settings/models")({
  component: ModelsPage,
});

/** How a provider's tier reads on a row. */
const TIER_LABEL: Record<ModelProviderTier, string> = {
  local: "On this computer",
  free: "Free",
  paid: "Your own key",
  custom: "Your own server",
  plan: "Subscription",
};

/** What the dialog is for right now: nothing, a new model, or one that exists. */
type Editing =
  | { kind: "none" }
  | { kind: "new"; providerId?: string }
  | { kind: "edit"; id: string };

function ModelsPage() {
  const catalogue = useQuery(modelCatalogueQueryOptions());
  const connections = useQuery(modelConnectionsQueryOptions());
  const coworkers = useQuery(agentListQueryOptions());
  const choices = useQuery(botModelChoicesQueryOptions());
  const [editing, setEditing] = useState<Editing>({ kind: "none" });

  const editedConnection =
    editing.kind === "edit"
      ? connections.data?.find((c) => c.id === editing.id)
      : undefined;
  const unavailable =
    catalogue.data?.providers.filter((p) => p.unavailable) ?? [];

  return (
    <PageShell
      action={
        <Button
          disabled={!catalogue.data}
          onClick={() => setEditing({ kind: "new" })}
          size="sm"
          variant="ghost"
        >
          <IconPlus />
          Add model
        </Button>
      }
      description="Choose the model your digital employees think with. Models on your computer and free models cost nothing. If you use your own key, your provider bills you directly."
      title="Models"
    >
      {catalogue.data ? (
        <ModelDialog
          catalogue={catalogue.data}
          connection={editedConnection}
          initialProviderId={
            editing.kind === "new" ? editing.providerId : undefined
          }
          // Closed rather than mounted-and-hidden, so a connection removed under it cannot linger.
          onOpenChange={(open) => {
            if (!open) setEditing({ kind: "none" });
          }}
          open={
            editing.kind === "new" ||
            (editing.kind === "edit" && editedConnection !== undefined)
          }
        />
      ) : null}

      <PageSection
        description="Your default is used for every conversation unless a digital employee says otherwise."
        title="Your models"
      >
        {connections.isPending ? null : connections.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            Could not load your models.
          </p>
        ) : connections.data?.length === 0 ? (
          <PageEmpty>
            No model is connected. Your digital employees use this deployment's
            own model, if it has one. Add one to choose for yourself.
          </PageEmpty>
        ) : (
          <PageRows>
            {connections.data?.map((connection, index) => (
              <React.Fragment key={connection.id}>
                <ConnectionRow
                  catalogue={catalogue.data}
                  connection={connection}
                  onOpen={() => setEditing({ kind: "edit", id: connection.id })}
                />
                {index !== (connections.data?.length ?? 0) - 1 && <Separator />}
              </React.Fragment>
            ))}
          </PageRows>
        )}
      </PageSection>

      <PageSection
        description="Add any of these. A model on this computer needs its program installed and running first: ArkAgent does not install Ollama, LM Studio or llama.cpp."
        title="Available models"
      >
        {catalogue.data ? (
          <PageRows>
            {catalogue.data.providers
              .filter((provider) => !provider.unavailable)
              .map((provider, index, all) => (
                <React.Fragment key={provider.id}>
                  <Item size="sm">
                    <ItemMedia variant="icon">
                      {provider.tier === "local" ? <IconCpu /> : <IconCloud />}
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>
                        {provider.name}
                        <span className="rounded-md bg-muted px-1.5 py-0.5 font-normal text-muted-foreground text-xs">
                          {TIER_LABEL[provider.tier]}
                        </span>
                      </ItemTitle>
                      <ItemDescription className="line-clamp-none">
                        {provider.summary}
                        {provider.suggestedModels.length > 0
                          ? ` Such as ${provider.suggestedModels.slice(0, 3).join(", ")}.`
                          : ""}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <Button
                        onClick={() =>
                          setEditing({ kind: "new", providerId: provider.id })
                        }
                        size="sm"
                        variant="ghost"
                      >
                        <IconPlus />
                        Add
                      </Button>
                    </ItemActions>
                  </Item>
                  {index !== all.length - 1 && <Separator />}
                </React.Fragment>
              ))}
          </PageRows>
        ) : null}
      </PageSection>

      {/* Only worth showing when there is something to choose between. */}
      {(connections.data?.length ?? 0) > 1 &&
      (coworkers.data?.length ?? 0) > 0 &&
      choices.data ? (
        <PageSection
          description="Each digital employee uses your default model unless you choose another for it."
          title="Digital employees"
        >
          <PageRows>
            {coworkers.data?.map((coworker, index) => (
              <React.Fragment key={coworker.id}>
                <CoworkerRow
                  choice={
                    choices.data?.find((c) => c.botId === coworker.id)
                      ?.connectionId
                  }
                  connections={connections.data ?? []}
                  coworker={coworker}
                />
                {index !== (coworkers.data?.length ?? 0) - 1 && <Separator />}
              </React.Fragment>
            ))}
          </PageRows>
        </PageSection>
      ) : null}

      {unavailable.length > 0 ? (
        <PageSection
          description="These are not offered here, and why."
          title="Not available"
        >
          <PageRows>
            {unavailable.map((provider, index) => (
              <React.Fragment key={provider.id}>
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconCloud />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{provider.name}</ItemTitle>
                    <ItemDescription className="line-clamp-none">
                      {provider.unavailable}
                    </ItemDescription>
                  </ItemContent>
                </Item>
                {index !== unavailable.length - 1 && <Separator />}
              </React.Fragment>
            ))}
          </PageRows>
        </PageSection>
      ) : null}
    </PageShell>
  );
}

function ConnectionRow({
  catalogue,
  connection,
  onOpen,
}: {
  catalogue: ModelCatalogue | undefined;
  connection: ModelConnection;
  onOpen: () => void;
}) {
  const provider = catalogue?.providers.find(
    (p) => p.id === connection.providerId,
  );
  return (
    <Item render={<button onClick={onOpen} type="button" />} size="sm">
      <ItemMedia variant="icon">
        {provider?.tier === "local" ? <IconCpu /> : <IconCloud />}
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          {connection.label}
          {connection.isDefault ? (
            <span className="rounded-md bg-muted px-1.5 py-0.5 font-normal text-muted-foreground text-xs">
              Default
            </span>
          ) : null}
        </ItemTitle>
        <ItemDescription>
          {/* A name the person never changed is the provider's own, so saying it twice is noise. */}
          {connection.label === provider?.name
            ? connection.model
            : `${provider?.name ?? connection.providerId} · ${connection.model}`}
          {connection.hasKey ? " · key saved" : ""}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <IconChevronRight className="size-4 text-muted-foreground" />
      </ItemActions>
    </Item>
  );
}

function CoworkerRow({
  choice,
  connections,
  coworker,
}: {
  /** The connection chosen for this coworker, if any. */
  choice: string | undefined;
  connections: ModelConnection[];
  coworker: AgentProfile;
}) {
  const setModel = useMutation(setBotModelMutationOptions(queryClient));
  const chosen = connections.find((c) => c.id === choice);
  const fallback = connections.find((c) => c.isDefault);
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        <IconRobot />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{coworker.name}</ItemTitle>
        {setModel.error ? (
          <ItemDescription className="text-destructive" role="alert">
            {setModel.error.message}
          </ItemDescription>
        ) : null}
      </ItemContent>
      <ItemActions>
        <Select
          disabled={setModel.isPending}
          onValueChange={(value) =>
            setModel.mutate({
              botId: coworker.id,
              connectionId: value === DEFAULT_MODEL ? null : String(value),
            })
          }
          value={chosen?.id ?? DEFAULT_MODEL}
        >
          <SelectTrigger aria-label={`Model for ${coworker.name}`} size="sm">
            <SelectValue>
              {chosen
                ? chosen.label
                : `Default${fallback ? ` (${fallback.label})` : ""}`}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_MODEL}>
              Default{fallback ? ` (${fallback.label})` : ""}
            </SelectItem>
            {connections.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </ItemActions>
    </Item>
  );
}
