import {
  IconChevronRight,
  IconCloud,
  IconCpu,
  IconPlus,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
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
import { Separator } from "@/components/ui/separator";
import {
  type ModelCatalogue,
  type ModelConnection,
  modelCatalogueQueryOptions,
  modelConnectionsQueryOptions,
} from "@/lib/models/queries";

export const Route = createFileRoute("/_authed/settings/models")({
  component: ModelsPage,
});

/** What the dialog is for right now: nothing, a new model, or one that exists. */
type Editing =
  | { kind: "none" }
  | { kind: "new" }
  | { kind: "edit"; id: string };

function ModelsPage() {
  const catalogue = useQuery(modelCatalogueQueryOptions());
  const connections = useQuery(modelConnectionsQueryOptions());
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
      description="Choose the model your coworkers think with. Models on your computer and free models cost nothing. If you use your own key, your provider bills you directly."
      title="Models"
    >
      {catalogue.data ? (
        <ModelDialog
          catalogue={catalogue.data}
          connection={editedConnection}
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
        description="Your default is used for every conversation unless a coworker says otherwise."
        title="Your models"
      >
        {connections.isPending ? null : connections.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            Could not load your models.
          </p>
        ) : connections.data?.length === 0 ? (
          <PageEmpty>
            No model is connected. Your coworkers use this deployment's own
            model, if it has one. Add one to choose for yourself.
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
