import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { installExternalLinks } from "./lib/external-links";
import { queryClient } from "./query-client";
import { router } from "./router";
import "@copilotkit/react-core/v2/styles.css";
import "./styles.css";

installExternalLinks();

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("OpenBot could not find the application root element.");
}

/*
 * The installable app's worker, registered in a build and never in development, where it would hold
 * on to files the dev server is changing. A page that cannot register one still works: it is a
 * convenience for phones, not something the app depends on.
 */
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} context={{ queryClient }} />
    </QueryClientProvider>
  </StrictMode>,
);
