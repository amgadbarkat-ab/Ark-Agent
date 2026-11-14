import type { ComponentProps } from "react";
import { useLanguage, useT } from "@/lib/i18n";
import { markdownComponents } from "@/lib/markdown";

/*
 * Plain tables. The ones Streamdown draws for a chat answer sit in a 300px box that scrolls, with
 * copy and download controls: right for a table a Bot produced, wrong for a legal notice, where a
 * reader must see every row without finding a scrollbar inside the page.
 */
type Cell<T extends "table" | "th" | "td"> = ComponentProps<T> & {
  node?: unknown;
};
export const legalComponents = {
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

/**
 * The terms and the privacy notice stay in English until counsel supplies the Greek (MD order, 13
 * Nov 2026, #108): a translation of a legal text is itself a legal text. In Greek the page says so
 * in Greek and then shows the English, marked as English for screen readers.
 */
export function EnglishOnlyNote() {
  const t = useT();
  const language = useLanguage();
  if (language !== "el") return null;
  return (
    <p
      className="mb-6 rounded-lg border border-border bg-muted px-4 py-3 text-sm"
      data-testid="legal-english-only"
    >
      {t(
        "The Greek translation is being prepared by legal counsel. Until then the English text applies:",
      )}
    </p>
  );
}
