import { createFileRoute } from "@tanstack/react-router";
import type { ComponentProps } from "react";
import { Streamdown } from "streamdown";
import { privacyNotice } from "@/lib/generated/privacy-notice";
import { markdownComponents } from "@/lib/markdown";

/**
 * The privacy notice, public: a customer reads it before they sign up, and Google's sign-in consent
 * screen asks for its address. Outside the signed-in area on purpose.
 *
 * The text is docs/legal/privacy-notice.md, generated into the build, so the one file a lawyer edits
 * is the one people read. Its draft banner stays visible until it is removed from that file: a notice
 * that is still a draft must not look final.
 */
export const Route = createFileRoute("/privacy")({
  component: PrivacyNotice,
});

/*
 * Plain tables. The ones Streamdown draws for a chat answer sit in a 300px box that scrolls, with
 * copy and download controls: right for a table a Bot produced, wrong for a legal notice, where a
 * reader must see every row without finding a scrollbar inside the page.
 */
type Cell<T extends "table" | "th" | "td"> = ComponentProps<T> & {
  node?: unknown;
};
const noticeComponents = {
  ...markdownComponents,
  table: ({ node: _node, ...props }: Cell<"table">) => (
    <div className="my-4 overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-left text-sm" {...props} />
    </div>
  ),
  th: ({ node: _node, ...props }: Cell<"th">) => (
    <th className="bg-muted px-3 py-2 align-top font-medium" {...props} />
  ),
  td: ({ node: _node, ...props }: Cell<"td">) => (
    <td className="border-border border-t px-3 py-2 align-top" {...props} />
  ),
};

function PrivacyNotice() {
  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-12">
      <article className="text-sm">
        <Streamdown components={noticeComponents}>{privacyNotice}</Streamdown>
      </article>
    </main>
  );
}
