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
import { sentenceNow, tNow, useT } from "@/lib/i18n";
import {
  clearDefaultModelMutationOptions,
  setBotModelMutationOptions,
} from "@/lib/models/mutations";
import {
  botModelChoicesQueryOptions,
  type LocalModels,
  localModelsQueryOptions,
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

/** How a provider's tier reads on a row. A model on this computer says whether it is running instead. */
const TIER_LABEL: Record<ModelProviderTier, string> = {
  local: tNow("On this computer"),
  free: tNow("Free"),
  paid: tNow("Your own key"),
  custom: tNow("Your own server"),
  plan: tNow("Subscription"),
};

/** What the dialog is for right now: nothing, a new model, or one that exists. */
type Editing =
  | { kind: "none" }
  | { kind: "new"; providerId?: string }
  | { kind: "edit"; id: string };

function ModelsPage() {
  const t = useT();
  const catalogue = useQuery(modelCatalogueQueryOptions());
  const connections = useQuery(modelConnectionsQueryOptions());
  const coworkers = useQuery(agentListQueryOptions());
  const choices = useQuery(botModelChoicesQueryOptions());
  const local = useQuery(localModelsQueryOptions());
  const offline = local.data?.offline ?? null;
  const [editing, setEditing] = useState<Editing>({ kind: "none" });

  const editedConnection =
    editing.kind === "edit"
      ? connections.data?.find((c) => c.id === editing.id)
      : undefined;

  // Only what can be used now. A provider that is not offered here, or a model on this computer that
  // is not running, is not listed at all: a row that says "not available" is a row that has nothing
  // to do, and it appears again by itself when the model starts.
  const offered = (catalogue.data?.providers ?? []).filter((provider) => {
    if (provider.unavailable) return false;
    if (provider.tier !== "local") return true;
    return (
      local.data?.servers.find((server) => server.providerId === provider.id)
        ?.state === "running"
    );
  });

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
          {t("Add model")}
        </Button>
      }
      description={t(
        "Choose the model your digital employees think with. Models on your computer and free models cost nothing. If you use your own key, your provider bills you directly.",
      )}
      title={t("Models")}
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
        description={t(
          "Your default is used for every conversation unless a digital employee says otherwise.",
        )}
        title={t("Your models")}
      >
        {connections.isPending ? null : connections.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {t("Could not load your models.")}
          </p>
        ) : connections.data?.length === 0 && !offline ? (
          <PageEmpty>
            {t(
              "No model is connected. Your digital employees use this deployment's own model, if it has one. Add one to choose for yourself.",
            )}
          </PageEmpty>
        ) : (
          <PageRows>
            {offline ? (
              <>
                <OfflineModelRow
                  offline={offline}
                  otherDefault={connections.data?.find((c) => c.isDefault)}
                />
                {(connections.data?.length ?? 0) > 0 && <Separator />}
              </>
            ) : null}
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
        description={t(
          "Models you can add right now. A model on this computer appears here only while it is running, and this page notices when one starts.",
        )}
        title={t("Available models")}
      >
        {catalogue.data ? (
          <PageRows>
            {offered
              .map((provider) => {
                const status = local.data?.servers.find(
                  (server) => server.providerId === provider.id,
                );
                const isLocal = provider.tier === "local";
                const running = isLocal && status?.state === "running";
                return { provider, status, isLocal, running };
              })
              .map(({ provider, status, isLocal, running }, index, all) => {
                return (
                  <React.Fragment key={provider.id}>
                    <Item size="sm">
                      <ItemMedia variant="icon">
                        {isLocal ? <IconCpu /> : <IconCloud />}
                      </ItemMedia>
                      <ItemContent>
                        <ItemTitle>
                          {sentenceNow(provider.name)}
                          <span
                            className={`rounded-md px-1.5 py-0.5 font-normal text-xs ${
                              running
                                ? "bg-primary/15 text-primary"
                                : "bg-muted text-muted-foreground"
                            }`}
                          >
                            {isLocal
                              ? running
                                ? t("Running on this computer")
                                : status
                                  ? t("Not running")
                                  : t("On this computer")
                              : TIER_LABEL[provider.tier]}
                          </span>
                        </ItemTitle>
                        <ItemDescription className="line-clamp-none">
                          {sentenceNow(provider.summary)}
                          {running && status?.models?.length
                            ? ` ${
                                status.models.length > 3
                                  ? t("Found {models} and {more} more.", {
                                      models: status.models
                                        .slice(0, 3)
                                        .join(", "),
                                      more: status.models.length - 3,
                                    })
                                  : t("Found {models}.", {
                                      models: status.models
                                        .slice(0, 3)
                                        .join(", "),
                                    })
                              }`
                            : isLocal && status
                              ? " " +
                                t(
                                  "Nothing answered at {baseUrl}. Install and start {name}, or add it with a different address.",
                                  {
                                    baseUrl: provider.baseUrl,
                                    name: provider.name,
                                  },
                                )
                              : provider.suggestedModels.length > 0
                                ? ` ${t("Such as {models}.", {
                                    models: provider.suggestedModels
                                      .slice(0, 3)
                                      .join(", "),
                                  })}`
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
                          {isLocal && status && !running
                            ? t("Set address")
                            : tNow("Add")}
                        </Button>
                      </ItemActions>
                    </Item>
                    {index !== all.length - 1 && <Separator />}
                  </React.Fragment>
                );
              })}
          </PageRows>
        ) : null}
      </PageSection>

      {/* Only worth showing when there is something to choose between. */}
      {(connections.data?.length ?? 0) > 1 &&
      (coworkers.data?.length ?? 0) > 0 &&
      choices.data ? (
        <PageSection
          description={t(
            "Each digital employee uses your default model unless you choose another for it.",
          )}
          title={t("Digital employees")}
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
    </PageShell>
  );
}

/**
 * The model ArkAgent runs on this computer, listed first because it is the one that was downloaded for
 * this person. It is the deployment's own model, so it is not edited here: it is what answers unless a
 * model of their own is their default. It is not a connection, so its "Make default" clears theirs:
 * without it, the first model a person added took over and the only way back was to remove it.
 */
function OfflineModelRow({
  offline,
  otherDefault,
}: {
  offline: NonNullable<LocalModels["offline"]>;
  /** The person's own connection that is their default instead, if one is. */
  otherDefault: ModelConnection | undefined;
}) {
  const t = useT();
  const running = offline.state === "running";
  const makeDefault = useMutation(
    clearDefaultModelMutationOptions(queryClient),
  );
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        <IconCpu />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          {tNow("ArkAgent offline model · {name}", { name: offline.label })}
          {otherDefault ? null : (
            <span className="rounded-md bg-muted px-1.5 py-0.5 font-normal text-muted-foreground text-xs">
              {t("Default")}
            </span>
          )}
          <span
            className={`rounded-md px-1.5 py-0.5 font-normal text-xs ${
              running
                ? "bg-primary/15 text-primary"
                : "bg-muted text-muted-foreground"
            }`}
          >
            {running ? t("Running on this computer") : t("Not running")}
          </span>
        </ItemTitle>
        <ItemDescription className="line-clamp-none">
          {running
            ? otherDefault
              ? t(
                  "Works without internet and keeps everything on this computer, with the same tools and browser as any other model. Your default is {label} now; make this the default to use it again.",
                  { label: otherDefault.label },
                )
              : t(
                  "Works without internet and keeps everything on this computer, with the same tools and browser as any other model. Your digital employees use it unless you choose another model.",
                )
            : t(
                "It is installed, but it is not answering right now. Open ArkAgent from its window to start it again.",
              )}
        </ItemDescription>
        {makeDefault.error ? (
          <ItemDescription className="text-destructive" role="alert">
            {makeDefault.error.message}
          </ItemDescription>
        ) : null}
      </ItemContent>
      {running && otherDefault ? (
        <ItemActions>
          <Button
            disabled={makeDefault.isPending}
            onClick={() => makeDefault.mutate()}
            size="sm"
            type="button"
            variant="outline"
          >
            {t("Make default")}
          </Button>
        </ItemActions>
      ) : null}
    </Item>
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
  const t = useT();
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
              {t("Default")}
            </span>
          ) : null}
        </ItemTitle>
        <ItemDescription>
          {/* A name the person never changed is the provider's own, so saying it twice is noise. */}
          {connection.label === provider?.name
            ? connection.model
            : `${provider?.name ?? connection.providerId} · ${connection.model}`}
          {connection.hasKey ? ` · ${tNow("key saved")}` : ""}
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
  const t = useT();
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
          <SelectTrigger
            aria-label={t("Model for {name}", { name: coworker.name })}
            size="sm"
          >
            <SelectValue>
              {chosen
                ? chosen.label
                : fallback
                  ? tNow("Default ({name})", { name: fallback.label })
                  : tNow("Default")}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_MODEL}>
              {fallback
                ? tNow("Default ({name})", { name: fallback.label })
                : tNow("Default")}
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
