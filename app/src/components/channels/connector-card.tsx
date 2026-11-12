import { useT } from "@/lib/i18n";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { useConversation } from "@/lib/copilot/conversation";
import type { ConnectorCard as Card } from "../../../../shared/connector-results";

/** How many items show before "Show more": a page of results, not the whole mailbox. */
const FIRST = 6;

/**
 * A connector's results drawn as a list a person can act on (P2 idea 9A, desk #90).
 *
 * The model was given the same results as text and answers from them as before; this is what the
 * person sees of the call. Opening goes to the vendor's own page in the browser. Summarise and Use
 * this file are ordinary messages in the conversation, typed for the person, so they go through
 * everything a typed message does, approvals included.
 */
export function ConnectorCard({ card }: { card: Card }) {
  const conversation = useConversation();
  const t = useT();
  const [all, setAll] = useState(false);
  const total = card.items.length;
  const shown = all ? total : Math.min(total, FIRST);
  const ask = conversation?.ask;

  const rows =
    card.kind === "mail"
      ? card.items.slice(0, shown).map((mail) => (
          <Item key={mail.id} size="sm" variant="outline">
            <ItemContent>
              <ItemTitle className="flex items-center gap-1.5">
                {mail.unread ? (
                  <span
                    aria-label={t("card.unread")}
                    className="size-1.5 shrink-0 rounded-full bg-sky-500"
                    role="img"
                  />
                ) : null}
                <span className="truncate">
                  {mail.subject || "(no subject)"}
                </span>
              </ItemTitle>
              <ItemDescription className="truncate text-xs">
                {[mail.from, mail.date].filter(Boolean).join(" · ")}
              </ItemDescription>
              {mail.preview ? (
                <ItemDescription className="line-clamp-2 text-xs">
                  {mail.preview}
                </ItemDescription>
              ) : null}
            </ItemContent>
            <ItemActions>
              {ask ? (
                <Button
                  onClick={() =>
                    ask(
                      `Summarise the email "${mail.subject}" from ${mail.from} (id: ${mail.id}).`,
                    )
                  }
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  {t("card.summarise")}
                </Button>
              ) : null}
              {mail.link ? <OpenLink href={mail.link} /> : null}
            </ItemActions>
          </Item>
        ))
      : card.kind === "files"
        ? card.items.slice(0, shown).map((file) => (
            <Item key={file.id} size="sm" variant="outline">
              <ItemContent>
                <ItemTitle className="truncate">{file.name}</ItemTitle>
                <ItemDescription className="truncate text-xs">
                  {[
                    readableKind(file.kind),
                    file.modified && `modified ${file.modified}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                {ask ? (
                  <Button
                    onClick={() =>
                      ask(`Use the file "${file.name}" (id: ${file.id}).`)
                    }
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    {t("card.useFile")}
                  </Button>
                ) : null}
                {file.link ? <OpenLink href={file.link} /> : null}
              </ItemActions>
            </Item>
          ))
        : card.items.slice(0, shown).map((event, index) => (
            <Item
              key={`${event.title}-${event.when}-${index.toString()}`}
              size="sm"
              variant="outline"
            >
              <ItemContent>
                <ItemTitle className={event.cancelled ? "line-through" : ""}>
                  {event.title || "(no title)"}
                </ItemTitle>
                <ItemDescription className="text-xs">
                  {[
                    event.when,
                    event.where && `at ${event.where}`,
                    event.organiser,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                {event.joinUrl ? (
                  <OpenLink href={event.joinUrl} label={t("card.join")} />
                ) : null}
                {event.link ? <OpenLink href={event.link} /> : null}
              </ItemActions>
            </Item>
          ));

  return (
    <div className="my-1.5 flex flex-col gap-1.5">
      {rows}
      {total > shown ? (
        <div>
          <Button
            onClick={() => setAll(true)}
            size="sm"
            type="button"
            variant="ghost"
          >
            {t("card.more", { n: total - shown })}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function OpenLink({ href, label }: { href: string; label?: string }) {
  const t = useT();
  // Only the vendor's own https pages: the addresses come from the vendor's answer.
  if (!href.startsWith("https://")) return null;
  return (
    <Button
      render={<a href={href} rel="noopener noreferrer" target="_blank" />}
      size="sm"
      variant="outline"
    >
      {label ?? t("card.open")}
    </Button>
  );
}

const KINDS: Record<string, string> = {
  "application/vnd.google-apps.document": "Google Doc",
  "application/vnd.google-apps.spreadsheet": "Google Sheet",
  "application/vnd.google-apps.presentation": "Google Slides",
  "application/vnd.google-apps.folder": "Folder",
  "application/pdf": "PDF",
};

function readableKind(mime: string): string {
  return KINDS[mime] ?? mime;
}
