import { IconChevronRight, IconPlus, IconUser } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import { ListingRow } from "@/components/marketplace/listing-row";
import { ShareDialog } from "@/components/marketplace/share-dialog";
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
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { savePublisherMutationOptions } from "@/lib/marketplace/mutations";
import {
  LIMITS,
  myListingsQueryOptions,
  type PublisherProfile,
} from "@/lib/marketplace/queries";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/_app/marketplace/mine")({
  component: MinePage,
});

const STATUS_WORDS: Record<string, string> = {
  pending: "Waiting for review",
  published: "Published",
  rejected: "Not approved",
  removed: "Taken down",
};

function MinePage() {
  const mine = useQuery(myListingsQueryOptions());
  const [sharing, setSharing] = useState(false);
  const [naming, setNaming] = useState(false);
  const publisher = mine.data?.publisher;
  const listings = mine.data?.listings ?? [];

  return (
    <PageShell
      action={
        <Button onClick={() => setSharing(true)} size="sm" variant="ghost">
          <IconPlus />
          Share a digital employee
        </Button>
      }
      backButton={{
        label: "Marketplace",
        linkProps: { to: "/marketplace" },
      }}
      description="Digital employees you have shared as guides. Our team reads each one before anyone else can see it."
      title="Shared by you"
    >
      <PageSection title="Your name">
        {mine.isPending ? null : mine.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            Could not load your shared digital employees.
          </p>
        ) : (
          <PageRows>
            <Item
              render={<button onClick={() => setNaming(true)} type="button" />}
              size="sm"
            >
              <ItemMedia variant="icon">
                <IconUser />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>
                  {publisher?.displayName ?? "Not chosen yet"}
                </ItemTitle>
                <ItemDescription className="line-clamp-none">
                  {publisher
                    ? publisher.bio || "Shown on everything you share."
                    : "Chosen when you share your first digital employee."}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <IconChevronRight className="size-4 text-muted-foreground" />
              </ItemActions>
            </Item>
          </PageRows>
        )}
      </PageSection>

      <PageSection title="Your listings">
        {mine.isPending ? null : mine.error ? null : listings.length === 0 ? (
          <PageEmpty>You have not shared a digital employee yet.</PageEmpty>
        ) : (
          <PageRows>
            {listings.map((listing, index) => (
              <StaggerItem index={index} key={listing.id}>
                <ListingRow
                  listing={listing}
                  note={STATUS_WORDS[listing.status]}
                />
                {index !== listings.length - 1 && <Separator />}
              </StaggerItem>
            ))}
          </PageRows>
        )}
      </PageSection>

      <ShareDialog onOpenChange={setSharing} open={sharing} />
      {naming ? (
        <PublisherDialog
          onOpenChange={setNaming}
          publisher={publisher ?? null}
        />
      ) : null}
    </PageShell>
  );
}

function PublisherDialog({
  onOpenChange,
  publisher,
}: {
  onOpenChange: (open: boolean) => void;
  publisher: PublisherProfile | null;
}) {
  const [displayName, setDisplayName] = useState(publisher?.displayName ?? "");
  const [bio, setBio] = useState(publisher?.bio ?? "");
  const save = useMutation(savePublisherMutationOptions(queryClient));

  return (
    <Dialog onOpenChange={onOpenChange} open>
      <DialogContent>
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate(
              { displayName, bio },
              { onSuccess: () => onOpenChange(false) },
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>Your name in the marketplace</DialogTitle>
            <DialogDescription>
              Shown on everything you share. Use a name or a team, not an email
              address.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4 overflow-y-auto">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="publisher-name">Name</FieldLabel>
                <Input
                  id="publisher-name"
                  maxLength={LIMITS.displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  value={displayName}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="publisher-bio">
                  About you (optional)
                </FieldLabel>
                <Textarea
                  id="publisher-bio"
                  maxLength={LIMITS.bio}
                  onChange={(event) => setBio(event.target.value)}
                  rows={3}
                  value={bio}
                />
              </Field>
            </FieldGroup>
            {save.error ? (
              <p className="mt-4 text-destructive text-sm" role="alert">
                {save.error.message}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button
              onClick={() => onOpenChange(false)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              disabled={save.isPending || displayName.trim() === ""}
              size="sm"
              type="submit"
            >
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
