import { IconLock, IconShieldCheck, IconUser } from "@tabler/icons-react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import { Button, buttonVariants } from "@/components/ui/button";
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
import { Switch } from "@/components/ui/switch";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  setPersonAccessMutationOptions,
  setPersonRoleMutationOptions,
} from "@/lib/people/mutations";
import {
  erasePersonMutationOptions,
  personExportPath,
} from "@/lib/privacy/mutations";
import { type Person, peopleListQueryOptions } from "@/lib/people/queries";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/admin/people")({
  component: PeoplePage,
});

/** What each provider is called, since the id it registers under is not a name. */
const PROVIDER_NAMES: Record<string, string> = {
  google: "Google",
  microsoft: "Microsoft",
  okta: "Okta",
};

/**
 * The second line of a person's row: how they got here, and when they were last here.
 *
 * The address is the title, so this is everything else worth knowing at a glance while deciding
 * whether somebody should still have access.
 */
function describe(person: Person): string {
  const providers = person.providers
    .map((provider) => PROVIDER_NAMES[provider] ?? provider)
    .join(", ");
  const when = person.lastSignedInAt
    ? `last signed in ${new Date(person.lastSignedInAt).toLocaleDateString()}`
    : "never signed in";

  if (person.revoked)
    return `Access removed · ${providers || "no provider"} · ${when}`;
  if (person.configuredAdmin) {
    return `Administrator by configuration · ${when}`;
  }
  return `${providers || "no provider"} · ${when}`;
}

function PeoplePage() {
  const [search, setSearch] = useState("");
  /*
   * Debounced, so typing a name is one request rather than one per keystroke against an aggregate
   * over every user in the deployment.
   */
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const people = useInfiniteQuery(peopleListQueryOptions(query));
  const rows = people.data?.pages.flatMap((page) => page.people) ?? [];
  const currentUser = useQuery(currentUserQueryOptions());
  const setRole = useMutation(setPersonRoleMutationOptions(queryClient));
  const setAccess = useMutation(setPersonAccessMutationOptions(queryClient));
  const erase = useMutation(erasePersonMutationOptions(queryClient));
  /** Whose data is being removed, and the address typed to confirm it, until it is sent or dropped. */
  const [erasing, setErasing] = useState<{
    userId: string;
    typed: string;
  } | null>(null);

  // The server refuses these too. Disabling them here is so the screen does not offer something it
  // knows will be refused, not so the rule is enforced in the browser.
  const failure = setRole.error ?? setAccess.error ?? erase.error;

  return (
    <PageShell
      description="Everybody who has signed in. Administrators reach these screens; everybody else talks to Bots."
      title="People"
    >
      <PageSection
        description="An address named in INITIAL_ADMIN_EMAILS is an administrator whatever this screen says, so it cannot be changed here."
        title="Who is here"
      >
        {failure ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {failure.message}
          </p>
        ) : null}
        {/*
          Server-side search. Filtering what already arrived would only search the first page, which
          is the opposite of what somebody looking for a colleague needs.
        */}
        <Input
          aria-label="Search people"
          className="mt-4"
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by name or address"
          value={search}
        />

        {people.isPending ? null : people.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            Could not load people.
          </p>
        ) : rows.length === 0 ? (
          <PageEmpty>
            {query
              ? `Nobody here matches "${query}".`
              : "Nobody has signed in yet. People appear here once they do."}
          </PageEmpty>
        ) : (
          <PageRows>
            {rows.map((person, index) => {
              const isSelf = person.id === currentUser.data?.id;
              const busy =
                setRole.isPending || setAccess.isPending || erase.isPending;

              return (
                <StaggerItem index={index} key={person.id}>
                  <Item size="sm">
                    <ItemMedia variant="icon">
                      {person.revoked ? (
                        <IconLock />
                      ) : person.role === "admin" ? (
                        <IconShieldCheck />
                      ) : (
                        <IconUser />
                      )}
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>{person.name ?? person.email}</ItemTitle>
                      <ItemDescription>
                        {person.name ? `${person.email} · ` : ""}
                        {describe(person)}
                      </ItemDescription>
                      {erasing?.userId === person.id ? (
                        <Input
                          aria-label={`Type ${person.email} to confirm removing their data`}
                          autoFocus
                          className="mt-2"
                          onChange={(event) =>
                            setErasing({
                              userId: person.id,
                              typed: event.target.value,
                            })
                          }
                          placeholder={`Type ${person.email} to confirm. This cannot be undone.`}
                          value={erasing.typed}
                        />
                      ) : null}
                    </ItemContent>
                    <ItemActions>
                      {/*
                       * For a person who has asked, by email, to be sent or to be rid of what is held
                       * about them. Both are on the audit trail. Erasing takes their data and their
                       * account for good, which is why it asks for the address to be typed.
                       */}
                      {erasing?.userId === person.id ? (
                        <>
                          <Button
                            onClick={() => setErasing(null)}
                            size="sm"
                            variant="ghost"
                          >
                            Cancel
                          </Button>
                          <Button
                            disabled={
                              busy ||
                              erasing.typed.trim().toLowerCase() !==
                                person.email.toLowerCase()
                            }
                            onClick={() =>
                              erase.mutate(
                                {
                                  userId: person.id,
                                  confirmEmail: erasing.typed,
                                },
                                { onSuccess: () => setErasing(null) },
                              )
                            }
                            size="sm"
                            variant="destructive"
                          >
                            Erase data
                          </Button>
                        </>
                      ) : (
                        <>
                          <a
                            className={buttonVariants({
                              size: "sm",
                              variant: "ghost",
                            })}
                            download
                            href={personExportPath(person.id)}
                          >
                            Export
                          </a>
                          <Button
                            disabled={busy || isSelf}
                            onClick={() =>
                              setErasing({ userId: person.id, typed: "" })
                            }
                            size="sm"
                            variant="outline"
                          >
                            Erase…
                          </Button>
                        </>
                      )}
                      {/*
                       * Removing access is the louder decision, so it is a button rather than a
                       * second switch: two switches on one row invites somebody to flip the wrong
                       * one, and these two do very different things.
                       */}
                      <Button
                        disabled={busy || isSelf || person.configuredAdmin}
                        onClick={() =>
                          setAccess.mutate({
                            userId: person.id,
                            revoked: !person.revoked,
                          })
                        }
                        size="sm"
                        variant={person.revoked ? "outline" : "destructive"}
                      >
                        {person.revoked ? "Restore" : "Remove"}
                      </Button>
                      <Switch
                        aria-label={`Administrator: ${person.email}`}
                        checked={person.role === "admin"}
                        disabled={busy || person.configuredAdmin || isSelf}
                        onCheckedChange={(checked) =>
                          setRole.mutate({
                            userId: person.id,
                            role: checked ? "admin" : "user",
                          })
                        }
                      />
                    </ItemActions>
                  </Item>
                  {index !== rows.length - 1 && <Separator />}
                </StaggerItem>
              );
            })}
          </PageRows>
        )}

        {/*
          Only when there is one. A button that says there is more when there is not is worse than
          no button, and this list ends for most deployments on the first page.
        */}
        {people.hasNextPage ? (
          <Button
            className="mt-4"
            disabled={people.isFetchingNextPage}
            onClick={() => people.fetchNextPage()}
            size="sm"
            variant="outline"
          >
            {people.isFetchingNextPage ? "Loading…" : "Show more"}
          </Button>
        ) : null}
      </PageSection>
    </PageShell>
  );
}
