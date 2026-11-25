import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import {
  currentUserQueryOptions,
  needsOnboarding,
  needsTerms,
} from "../lib/auth/queries";
import { CopilotProvider } from "../lib/copilot/provider";
import { AppHotkeys } from "../lib/hotkeys/app-hotkeys";
import { teamMeQueryOptions } from "../lib/team/queries";
import { activationQueryOptions } from "../lib/trial/queries";

export const Route = createFileRoute("/_authed")({
  beforeLoad: async ({ context, location }) => {
    const user = await context.queryClient.ensureQueryData(
      currentUserQueryOptions(),
    );
    if (!user) {
      throw redirect({ to: "/sign" });
    }
    /*
     * The terms come first, before anything else is shown: nobody is walked through the product, or
     * let into it, on terms they have not accepted. Checked against the destination so the screen
     * that asks stays reachable.
     */
    if (needsTerms(user) && location.pathname !== "/accept-terms") {
      throw redirect({ to: "/accept-terms" });
    }
    /*
     * Somebody who has not finished onboarding goes there and nowhere else. Here rather than in
     * `_app`, so admin and settings are behind the same gate; checked against the destination so
     * the onboarding route itself stays reachable.
     */
    if (needsOnboarding(user) && location.pathname !== "/onboarding") {
      throw redirect({ to: "/onboarding" });
    }
    /*
     * A staff sub-profile's first sign-in (Amgad, 24 Nov 2026): they choose their own password
     * before anything else. Null where there is no team; an error is not a reason to lock out.
     */
    if (location.pathname !== "/new-password") {
      const me = await context.queryClient
        .ensureQueryData(teamMeQueryOptions())
        .catch(() => null);
      if (me?.mustChangePassword) {
        throw redirect({ to: "/new-password" });
      }
    }
    /*
     * Activation (#109, v0.1.42): on a desktop install, nothing opens without a trial activation
     * code, a paid licence key or the trial setup file. Null means the server has nothing to gate;
     * an error reading it is not a reason to lock somebody out, and the server refuses runs anyway.
     */
    if (location.pathname !== "/activate") {
      const activation = await context.queryClient
        .ensureQueryData(activationQueryOptions())
        .catch(() => null);
      if (activation && !activation.allowed) {
        throw redirect({ to: "/activate" });
      }
    }
  },
  // Mounted INSIDE the authed boundary, not at the root: the runtime endpoint requires a session, so
  // a provider above the sign-in gate would open a run for a visitor who has not signed in yet.
  component: () => (
    <CopilotProvider>
      <AppHotkeys />
      <Outlet />
    </CopilotProvider>
  ),
});
