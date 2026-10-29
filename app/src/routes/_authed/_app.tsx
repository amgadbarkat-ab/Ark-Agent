import {
  createFileRoute,
  isRedirect,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { OwnBrowserIndicator } from "@/components/computer/own-browser-indicator";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { accountQueryOptions } from "@/lib/account/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";

export const Route = createFileRoute("/_authed/_app")({
  /*
   * Somebody who has signed up but not chosen a plan is taken to choose one before anything else.
   *
   * Only where plans are in force, only for the "no plan yet" case (a lapsed or suspended account is
   * told why on the page it lands on instead), and never for staff, who reach Admin and Settings
   * either way. The check is cached briefly so moving between conversations does not ask each time.
   * A deployment with no account service answers an error here, which means there is nothing to gate.
   */
  beforeLoad: async ({ context }) => {
    try {
      const user = await context.queryClient.ensureQueryData(
        currentUserQueryOptions(),
      );
      if (user?.role === "admin") return;
      const overview = await context.queryClient.fetchQuery({
        ...accountQueryOptions(),
        staleTime: 30_000,
      });
      if (
        overview.billing.mode === "subscriptions" &&
        overview.account.blockedCode === "no_plan"
      ) {
        throw redirect({ to: "/settings/plan" });
      }
    } catch (error) {
      if (isRedirect(error)) throw error;
    }
  },
  component: RouteComponent,
});

function RouteComponent() {
  return (
    // One viewport, never scrolls: panes scroll inside it. A growable shell lets the transcript's
    // scroller size against the page, grow it, and grow again.
    <SidebarShell className="h-svh overflow-hidden" width="340px">
      <AppSidebar />
      <main className="flex-1 flex flex-col min-h-0 overflow-hidden">
        {/* Above every screen: a digital employee working in the person's own browser is never out of sight. */}
        <OwnBrowserIndicator />
        <Outlet />
      </main>
    </SidebarShell>
  );
}
