import { IconBan, IconBuildingStore, IconUser } from "@tabler/icons-react";
import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import {
  resumeAccountMutationOptions,
  setAccountPlanMutationOptions,
  suspendAccountMutationOptions,
} from "@/lib/account/mutations";
import {
  type AdminAccount,
  adminAccountsQueryOptions,
} from "@/lib/account/queries";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/admin/accounts")({
  component: AccountsPage,
});

/** The plans staff can put an account on. The internal plan is theirs to give, never for sale. */
const PLAN_CHOICES: { id: string; name: string }[] = [
  { id: "agent", name: "ArkAgent" },
  { id: "team", name: "Ark Team" },
  { id: "enterprise", name: "Ark Team Enterprise" },
  { id: "internal", name: "Internal" },
];

function describe(account: AdminAccount): string {
  const status = account.suspended
    ? `Suspended${account.suspendedReason ? `: ${account.suspendedReason}` : ""}`
    : account.subscriptionStatus.replace("_", " ");
  return `${status} · ${account.activeBots} working now · since ${new Date(account.createdAt).toLocaleDateString()}`;
}

function AccountsPage() {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const accounts = useInfiniteQuery(adminAccountsQueryOptions(query));
  const rows = accounts.data?.pages.flatMap((page) => page.tenants) ?? [];
  const setPlan = useMutation(setAccountPlanMutationOptions(queryClient));
  const suspend = useMutation(suspendAccountMutationOptions(queryClient));
  const resume = useMutation(resumeAccountMutationOptions(queryClient));
  /** The account being suspended, and the reason being written, until it is sent or dropped. */
  const [suspending, setSuspending] = useState<{
    tenantId: string;
    reason: string;
  } | null>(null);

  const busy = setPlan.isPending || suspend.isPending || resume.isPending;
  const failure = setPlan.error ?? suspend.error ?? resume.error;

  return (
    <PageShell
      description="Every customer account: what it has bought, how much is in use, and whether it is allowed to run."
      title="Accounts"
    >
      <PageSection
        description="Changing a plan here sets it by hand and does not charge anyone. Suspending stops every coworker on the account at its next run and shows the customer the reason."
        title="Who is paying"
      >
        {failure ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {failure.message}
          </p>
        ) : null}
        <Input
          aria-label="Search accounts"
          className="mt-4"
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by name or address"
          value={search}
        />

        {accounts.isPending ? null : accounts.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            Could not load accounts.
          </p>
        ) : rows.length === 0 ? (
          <PageEmpty>
            {query
              ? `No account matches "${query}".`
              : "No accounts yet. They appear when people sign up."}
          </PageEmpty>
        ) : (
          <PageRows>
            {rows.map((account, index) => (
              <StaggerItem index={index} key={account.tenantId}>
                <Item size="sm">
                  <ItemMedia variant="icon">
                    {account.suspended ? (
                      <IconBan />
                    ) : account.planId === "internal" ? (
                      <IconBuildingStore />
                    ) : (
                      <IconUser />
                    )}
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{account.ownerEmail ?? account.name}</ItemTitle>
                    <ItemDescription className="line-clamp-none">
                      {describe(account)}
                    </ItemDescription>
                    {suspending?.tenantId === account.tenantId ? (
                      <Input
                        aria-label={`Reason for suspending ${account.ownerEmail ?? account.name}`}
                        autoFocus
                        className="mt-2"
                        onChange={(event) =>
                          setSuspending({
                            tenantId: account.tenantId,
                            reason: event.target.value,
                          })
                        }
                        placeholder="Why? The customer is shown this."
                        value={suspending.reason}
                      />
                    ) : null}
                  </ItemContent>
                  <ItemActions>
                    <Select
                      disabled={busy}
                      onValueChange={(value) =>
                        setPlan.mutate({
                          tenantId: account.tenantId,
                          planId: String(value),
                        })
                      }
                      value={account.planId}
                    >
                      <SelectTrigger
                        aria-label={`Plan for ${account.ownerEmail ?? account.name}`}
                        size="sm"
                      >
                        <SelectValue>
                          {PLAN_CHOICES.find((p) => p.id === account.planId)
                            ?.name ?? account.planId}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {PLAN_CHOICES.map((plan) => (
                          <SelectItem key={plan.id} value={plan.id}>
                            {plan.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {account.suspended ? (
                      <Button
                        disabled={busy}
                        onClick={() => resume.mutate(account.tenantId)}
                        size="sm"
                        variant="outline"
                      >
                        Restore
                      </Button>
                    ) : suspending?.tenantId === account.tenantId ? (
                      <>
                        <Button
                          onClick={() => setSuspending(null)}
                          size="sm"
                          variant="ghost"
                        >
                          Cancel
                        </Button>
                        <Button
                          disabled={busy || !suspending.reason.trim()}
                          onClick={() =>
                            suspend.mutate(
                              {
                                tenantId: account.tenantId,
                                reason: suspending.reason.trim(),
                              },
                              { onSuccess: () => setSuspending(null) },
                            )
                          }
                          size="sm"
                          variant="destructive"
                        >
                          Suspend
                        </Button>
                      </>
                    ) : (
                      <Button
                        disabled={busy}
                        onClick={() =>
                          setSuspending({
                            tenantId: account.tenantId,
                            reason: "",
                          })
                        }
                        size="sm"
                        variant="outline"
                      >
                        Suspend
                      </Button>
                    )}
                  </ItemActions>
                </Item>
                {index !== rows.length - 1 && <Separator />}
              </StaggerItem>
            ))}
          </PageRows>
        )}

        {accounts.hasNextPage ? (
          <Button
            className="mt-4"
            disabled={accounts.isFetchingNextPage}
            onClick={() => accounts.fetchNextPage()}
            size="sm"
            variant="outline"
          >
            {accounts.isFetchingNextPage ? "Loading…" : "Show more"}
          </Button>
        ) : null}
      </PageSection>
    </PageShell>
  );
}
