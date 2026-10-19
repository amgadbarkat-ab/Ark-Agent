import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * The Marketplace was folded into the Digital Team page. A bookmark or a link somebody was sent still
 * lands somewhere: on the page that now holds what it used to show.
 */
export const Route = createFileRoute("/_authed/_app/marketplace/")({
  beforeLoad: () => {
    throw redirect({ to: "/agents", replace: true });
  },
});
