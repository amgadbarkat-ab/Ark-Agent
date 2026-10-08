import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import { Route as PrivacyNoticeRoute } from "@/routes/privacy";

/** The notice is public and is the file the lawyer edits, not a copy. */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

test("the public notice names the company, and shows every row of what is collected", async () => {
  const router = createRouter({
    routeTree: createRootRoute({
      component: PrivacyNoticeRoute.options.component as never,
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const screen = render(<RouterProvider router={router as never} />);

  const heading = await screen.findByRole(
    "heading",
    { name: "Privacy notice" },
    { timeout: 5000 },
  );
  expect(heading.tagName).toBe("H1");
  const text = (document.body.textContent ?? "").replace(/\s+/g, " ");
  expect(text).toContain("Black Ark");
  // The ten rows of the first table (and its header) are all in the page, not behind a scrollbox.
  // Cloud running is one of them: it is held about a person only if they choose it.
  expect(document.querySelectorAll("table")[0]?.rows.length).toBe(11);
  expect(text).toContain("Cloud running");
  expect(text).toContain(
    "we do not use your conversations or files to train AI models",
  );
});
