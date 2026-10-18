import { IconDownload, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
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
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  deleteMyAccountMutationOptions,
  MY_EXPORT_PATH,
} from "@/lib/privacy/mutations";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/settings/privacy")({
  component: PrivacyPage,
});

/** Where somebody is sent once they are gone: the front door, which asks them to sign in. */
function leave() {
  window.location.assign("/");
}

function PrivacyPage() {
  const me = useQuery(currentUserQueryOptions());
  const [confirming, setConfirming] = useState(false);

  return (
    <PageShell
      description="Everything Ark holds about you is yours to have, and to have removed."
      title="Your data"
    >
      <PageSection
        description="Your account, your coworkers and what they were told, your skills and routines, your conversations and the record of what you did. Never a key or a token."
        title="Get a copy"
      >
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconDownload />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Download your data</ItemTitle>
              <ItemDescription className="line-clamp-none">
                One file you can keep, as it is today. It can be large if you
                have had a lot of conversations.
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              {/* A plain link, not a button dressed as one: it is a file, and a link is what a reader announces. */}
              <a
                className={buttonVariants({ size: "sm", variant: "outline" })}
                download
                href={MY_EXPORT_PATH}
              >
                Download
              </a>
            </ItemActions>
          </Item>
        </PageRows>
      </PageSection>

      <PageSection
        description="Removes you, your coworkers, your conversations, your keys and your sign-ins. If this account is only you, the account and its plan go too, and your subscription is stopped at once. This cannot be undone."
        title="Delete your account"
      >
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconTrash />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Delete my account</ItemTitle>
              <ItemDescription className="line-clamp-none">
                Download your data first if you want to keep a copy. What we
                must keep, and why, is in the privacy notice.
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button
                onClick={() => setConfirming(true)}
                size="sm"
                variant="destructive"
              >
                Delete…
              </Button>
            </ItemActions>
          </Item>
        </PageRows>
      </PageSection>
      {confirming ? (
        <DeleteDialog
          email={me.data?.email ?? ""}
          onOpenChange={setConfirming}
        />
      ) : null}
      <Separator className="mt-12 opacity-0" />
    </PageShell>
  );
}

function DeleteDialog({
  email,
  onOpenChange,
}: {
  email: string;
  onOpenChange: (open: boolean) => void;
}) {
  const [typed, setTyped] = useState("");
  const remove = useMutation(deleteMyAccountMutationOptions(queryClient));
  const matches =
    email !== "" && typed.trim().toLowerCase() === email.toLowerCase();

  return (
    <Dialog onOpenChange={onOpenChange} open>
      <DialogContent>
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            remove.mutate(typed, { onSuccess: leave });
          }}
        >
          <DialogHeader>
            <DialogTitle>Delete your account?</DialogTitle>
            <DialogDescription>
              This removes everything that is yours and signs you out. It cannot
              be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4 overflow-y-auto">
            <Field>
              <FieldLabel htmlFor="confirm-email">
                Type your email address, {email}, to confirm
              </FieldLabel>
              <Input
                autoComplete="off"
                id="confirm-email"
                onChange={(event) => setTyped(event.target.value)}
                value={typed}
              />
            </Field>
            {remove.error ? (
              <p className="mt-4 text-destructive text-sm" role="alert">
                {remove.error.message}
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
              Keep my account
            </Button>
            <Button
              disabled={!matches || remove.isPending}
              size="sm"
              type="submit"
              variant="destructive"
            >
              {remove.isPending ? "Deleting…" : "Delete everything"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
