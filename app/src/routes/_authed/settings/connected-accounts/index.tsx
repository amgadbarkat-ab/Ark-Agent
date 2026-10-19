import {
  IconBrandGoogleDrive,
  IconBrandNotion,
  IconBrandWindows,
  IconCheck,
  IconPlug,
  IconSearch,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import * as React from "react";
import { PageShell } from "@/components/layout/page-shell";
import { RowMark } from "@/components/layout/row-mark";
import { PluginLogo } from "@/components/plugins/plugin-logo";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { DATA_SERVICES, type DataService } from "@/lib/data-services";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import {
  type CatalogueItem,
  connectionsQueryOptions,
  type PluginServer,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";

/**
 * Connect your Data: the places your work lives, which a digital employee reads as you.
 *
 * It lists every service ArkAgent knows of, each saying honestly where it stands: connected, ready to
 * connect, built but waiting for an administrator to set it up, or not built yet. A service is never
 * offered a Connect button that can only fail.
 *
 * Yours, not the deployment's. An administrator decides which vendors this deployment may reach at
 * all; this is the other half of that decision, and it is one nobody can make for you — there is no
 * endpoint for an administrator to connect an account on somebody's behalf. A Bot calling one of
 * these runs on your own grant, so it sees exactly what you can see and nothing else.
 */
export const Route = createFileRoute("/_authed/settings/connected-accounts/")({
  component: RouteComponent,
  /*
   * `?connected=` is how the OAuth callback reports back, carrying a server key on success and
   * `failed` otherwise. It is the only channel available: the callback is a redirect from another
   * company's server, so there is no response body to read.
   *
   * The key is omitted rather than set to undefined. Present-but-undefined makes `search` a required
   * prop on every Link to this route, which is a lot of ripple for a parameter only the callback sets.
   */
  validateSearch: (search: Record<string, unknown>): { connected?: string } =>
    typeof search.connected === "string" ? { connected: search.connected } : {},
});

/** The same marks the admin connector list uses: these are the same vendors seen from your side. */
const MARKS: Record<string, React.ComponentType<{ className?: string }>> = {
  "google-drive": IconBrandGoogleDrive,
  notion: IconBrandNotion,
  "microsoft-365": IconBrandWindows,
};

/**
 * The brokered apps this page lists, which is not every brokered row.
 *
 * Exported as a function rather than left inline in the render, for the reason `matchingApps` on the
 * Composio picker is: the rule is the thing worth pinning and pinning it needs no DOM, no router and
 * no query client. See its one clause below.
 */
export function brokeredAccountsListedOn(
  servers: PluginServer[],
): PluginServer[] {
  return servers.filter(
    (server) =>
      server.provenance === "composio" && server.authScheme !== "NO_AUTH",
  );
}

/** Where one service stands for the person looking at it. */
export type DataServiceState =
  | { kind: "connected" }
  | { kind: "ready" }
  /** Built, and waiting for somebody to set it up once. */
  | { kind: "needs-setup"; reason: string }
  | { kind: "not-available" };

/**
 * Where a service stands, decided from what the deployment says about its connector and nothing else.
 *
 * Exported for the reason `brokeredAccountsListedOn` is: the rule is the thing worth pinning, and
 * pinning it needs no DOM. The order is the point. A service with no connector is never anything but
 * "not available", whatever else is true; a connected one is connected; and "ready" is reached only
 * when a person pressing Connect would get to the vendor, which needs the connector turned on AND an
 * OAuth client behind it.
 */
export function dataServiceState(
  service: DataService,
  deployment: {
    catalogue: CatalogueItem[];
    servers: PluginServer[];
    connected: ReadonlySet<string>;
  },
): DataServiceState {
  const key = service.connector;
  if (!key) return { kind: "not-available" };
  const entry = deployment.catalogue.find((item) => item.key === key);
  if (!entry) return { kind: "not-available" };
  if (deployment.connected.has(key)) return { kind: "connected" };
  const server = deployment.servers.find((candidate) => candidate.id === key);
  if (!server) {
    return {
      kind: "needs-setup",
      reason: service.setup
        ? `Not turned on yet. It needs ${service.setup.charAt(0).toLowerCase()}${service.setup.slice(1)}.`
        : "Not turned on yet. An administrator turns it on.",
    };
  }
  if (
    entry.auth === "user-oauth" &&
    !server.dynamicClient &&
    !server.hasCredential
  ) {
    return {
      kind: "needs-setup",
      reason: service.setup
        ? `It needs ${service.setup.charAt(0).toLowerCase()}${service.setup.slice(1)}.`
        : "An administrator has to add the app's client id and secret.",
    };
  }
  return { kind: "ready" };
}

function RouteComponent() {
  const { connected: outcome } = Route.useSearch();
  const [search, setSearch] = React.useState("");
  const plugins = useQuery(pluginsPageQueryOptions());
  const connections = useQuery(connectionsQueryOptions());
  const { data: currentUser } = useQuery(currentUserQueryOptions());
  const isAdmin = currentUser?.role === "admin";

  const connected = new Set(
    (connections.data?.connections ?? []).map((row) => row.serverId),
  );
  const deployment = {
    catalogue: plugins.data?.catalogue ?? [],
    servers: plugins.data?.servers ?? [],
    connected,
  };

  /*
   * Brokered apps belong here for the same reason the OAuth ones do: they answer as you. EXCEPT THE
   * ONES THAT NEED NO ACCOUNT, which `brokeredAccountsListedOn` leaves out: there is nothing to
   * connect, so a row for one would be a permanently grey "Not connected" that reads as an unfinished
   * task.
   */
  const brokered = brokeredAccountsListedOn(plugins.data?.servers ?? []);

  const query = search.trim().toLocaleLowerCase();
  const matches = (name: string, summary: string) =>
    `${name} ${summary}`.toLocaleLowerCase().includes(query);
  const services = DATA_SERVICES.filter((service) =>
    matches(service.name, service.summary),
  ).map((service) => ({
    service,
    state: dataServiceState(service, deployment),
  }));
  const brokeredMatching = brokered.filter((server) =>
    matches(server.title, server.summary),
  );

  const sections: Array<{
    title: string;
    note?: string;
    rows: typeof services;
  }> = [
    {
      title: "Connected",
      rows: services.filter(({ state }) => state.kind === "connected"),
    },
    {
      title: "Ready to connect",
      rows: services.filter(({ state }) => state.kind === "ready"),
    },
    {
      title: "Needs setup",
      note: isAdmin
        ? "You run this deployment, so you can set these up."
        : "An administrator sets these up once, and then you can connect.",
      rows: services.filter(({ state }) => state.kind === "needs-setup"),
    },
    {
      title: "Not available yet",
      note: "On the list because people ask for them. They are not built, so there is nothing to connect.",
      rows: services.filter(({ state }) => state.kind === "not-available"),
    },
  ];
  const connectedCount = DATA_SERVICES.filter(
    (service) => dataServiceState(service, deployment).kind === "connected",
  ).length;

  return (
    <PageShell
      className="max-w-4xl @container"
      description="Connect the places your work lives, so your digital employees can read them as you. They only ever see what your own account can see."
      title="Connect your Data"
    >
      {/*
       * Only the failure is worth saying. A success needs no sentence: the row it came back to now
       * reads "Connected", which is the same news told by the thing it is news about.
       */}
      {outcome === "failed" ? (
        <p className="text-destructive text-sm" role="alert">
          That account could not be connected. Nothing was saved — try again.
        </p>
      ) : null}
      {/*
       * BOTH READS DECIDE THIS. A `/api/plugins` that succeeded beside a `/api/plugins/connections` that
       * failed left the connected set empty and every row asserting "not connected", with no error text
       * anywhere. One sentence for both: this page could not be loaded, and what it would otherwise
       * draw is not shown rather than drawn wrong.
       */}
      {plugins.isPending || connections.isPending ? null : plugins.error ||
        connections.error ? (
        <p className="mt-12 text-destructive text-sm" role="alert">
          Your connections could not be loaded, so nothing is listed here rather
          than a list that may be wrong. Reload the page, and tell an
          administrator if it persists.
        </p>
      ) : (
        <>
          <p className="mt-5 text-xs text-muted-foreground">
            {connectedCount} connected · {DATA_SERVICES.length} on the list
          </p>
          <InputGroup className="mt-3 h-9 border-transparent bg-muted/60 shadow-none dark:bg-muted/60">
            <InputGroupAddon>
              <IconSearch aria-hidden="true" className="size-4" />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="Search services"
              placeholder="Search services"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </InputGroup>
          {services.length === 0 && brokeredMatching.length === 0 ? (
            <p className="mt-8 text-sm text-muted-foreground" role="status">
              No services match “{search.trim()}”.
            </p>
          ) : (
            <>
              {sections
                .filter((section) => section.rows.length > 0)
                .map((section) => (
                  <section
                    className="mt-8"
                    key={section.title}
                    aria-label={section.title}
                  >
                    <h2 className="px-2 text-xs font-medium text-muted-foreground">
                      {section.title}
                    </h2>
                    {section.note ? (
                      <p className="mt-1 mb-3 px-2 text-xs text-muted-foreground">
                        {section.note}
                      </p>
                    ) : (
                      <div className="mb-3" />
                    )}
                    <div className="grid grid-cols-1 gap-x-6 gap-y-2 @min-[36rem]:grid-cols-2">
                      {section.rows.map(({ service, state }) => (
                        <ServiceRow
                          isAdmin={isAdmin}
                          key={service.id}
                          service={service}
                          state={state}
                        />
                      ))}
                    </div>
                  </section>
                ))}
              {brokeredMatching.length > 0 ? (
                <section className="mt-8" aria-label="More apps">
                  <h2 className="mb-3 px-2 text-xs font-medium text-muted-foreground">
                    More apps
                  </h2>
                  <div className="grid grid-cols-1 gap-x-6 gap-y-2 @min-[36rem]:grid-cols-2">
                    {brokeredMatching.map((server) => (
                      <AccountLink
                        connected={connected.has(server.id)}
                        id={server.id}
                        key={server.id}
                        mark={<PluginLogo logo={server.logo} />}
                        summary={
                          server.summary ||
                          `Connect your ${server.title} account.`
                        }
                        title={server.title}
                      />
                    ))}
                  </div>
                </section>
              ) : null}
              {query === "" ? <YourOwnTools isAdmin={isAdmin} /> : null}
            </>
          )}
        </>
      )}
    </PageShell>
  );
}

/** One service, in whichever of its four states. Only the first two lead anywhere a person can act. */
function ServiceRow({
  isAdmin,
  service,
  state,
}: {
  isAdmin: boolean;
  service: DataService;
  state: DataServiceState;
}) {
  const Mark = service.connector
    ? (MARKS[service.connector] ?? IconPlug)
    : IconPlug;
  const mark = <Mark className="size-4" />;
  if (state.kind === "connected" || state.kind === "ready") {
    return (
      <AccountLink
        connected={state.kind === "connected"}
        id={service.connector as string}
        mark={mark}
        note={service.untested ? UNTESTED : undefined}
        summary={service.summary}
        title={service.name}
      />
    );
  }
  const body = (
    <>
      <RowMark className="size-9">{mark}</RowMark>
      <ItemContent className="min-w-0 gap-0.5">
        <ItemTitle className="block w-auto truncate">{service.name}</ItemTitle>
        <ItemDescription
          className="line-clamp-2 text-xs"
          title={service.summary}
        >
          {service.summary}
          {state.kind === "needs-setup" ? ` ${state.reason}` : ""}
          {service.untested ? ` ${UNTESTED}` : ""}
        </ItemDescription>
      </ItemContent>
      <ItemActions className="shrink-0">
        {state.kind === "needs-setup" ? (
          <span className="rounded-full bg-amber-500/15 px-3 py-1 text-xs font-medium text-amber-600 dark:text-amber-400">
            {isAdmin ? "Set up" : "Needs setup"}
          </span>
        ) : (
          <span className="rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
            Not yet
          </span>
        )}
      </ItemActions>
    </>
  );
  return state.kind === "needs-setup" && isAdmin && service.connector ? (
    <Item
      className="min-w-0 flex-nowrap gap-3 px-2 py-3"
      data-testid={`service-${service.id}`}
      render={
        <Link params={{ key: service.connector }} to="/admin/plugins/$key" />
      }
      size="sm"
    >
      {body}
    </Item>
  ) : (
    <Item
      className="min-w-0 flex-nowrap gap-3 px-2 py-3"
      data-testid={`service-${service.id}`}
      size="sm"
    >
      {body}
    </Item>
  );
}

/** Said on a connector that has been written but never tried against a real account. */
const UNTESTED = "Built, but not yet tried with a real account.";

function AccountLink({
  connected,
  id,
  mark,
  note,
  summary,
  title,
}: {
  connected: boolean;
  id: string;
  mark: React.ReactNode;
  note?: string;
  summary: string;
  title: string;
}) {
  return (
    <Item
      className="min-w-0 flex-nowrap gap-3 px-2 py-3"
      data-testid={`account-${id}`}
      render={
        <Link params={{ key: id }} to="/settings/connected-accounts/$key" />
      }
      size="sm"
    >
      <RowMark className="size-9">{mark}</RowMark>
      <ItemContent className="min-w-0 gap-0.5">
        <ItemTitle className="block w-auto truncate">{title}</ItemTitle>
        <ItemDescription
          className="line-clamp-2 text-xs"
          title={`${summary}${note ? ` ${note}` : ""}`}
        >
          {summary}
          {note ? ` ${note}` : ""}
        </ItemDescription>
      </ItemContent>
      <ItemActions className="shrink-0">
        {connected ? (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <IconCheck
              aria-hidden="true"
              className="size-3.5 text-emerald-600 dark:text-emerald-400"
            />
            Connected
          </span>
        ) : (
          <span className="rounded-full bg-muted px-3 py-1 text-xs font-medium">
            Connect
          </span>
        )}
      </ItemActions>
    </Item>
  );
}

/** Where a tool that speaks MCP is added. It is an administrator's decision, so it says whose. */
function YourOwnTools({ isAdmin }: { isAdmin: boolean }) {
  return (
    <section className="mt-8" aria-label="Your own tools">
      <h2 className="mb-3 px-2 text-xs font-medium text-muted-foreground">
        Your own tools
      </h2>
      <Item
        className="min-w-0 flex-nowrap gap-3 px-2 py-3"
        data-testid="own-mcp"
        render={isAdmin ? <Link to="/admin/plugins" /> : undefined}
        size="sm"
      >
        <RowMark className="size-9">
          <IconPlug className="size-4" />
        </RowMark>
        <ItemContent className="min-w-0 gap-0.5">
          <ItemTitle className="block w-auto truncate">
            Add your own MCP server
          </ItemTitle>
          <ItemDescription className="line-clamp-2 text-xs">
            Anything that speaks MCP can be connected, so your digital employees
            can use a tool nobody on this list has built.
            {isAdmin
              ? ""
              : " An administrator adds it, and decides who may use it."}
          </ItemDescription>
        </ItemContent>
        {isAdmin ? (
          <ItemActions className="shrink-0">
            <span className="rounded-full bg-muted px-3 py-1 text-xs font-medium">
              Add
            </span>
          </ItemActions>
        ) : null}
      </Item>
    </section>
  );
}
