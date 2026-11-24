import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Switch } from "@/components/ui/switch";
import { setChatSummaryMutationOptions } from "@/lib/chat-summary/mutations";
import { chatSummaryQueryOptions } from "@/lib/chat-summary/queries";
import { dateLocale, tNow, useLanguage, useT } from "@/lib/i18n";
import { queryClient } from "@/query-client";

/**
 * Weekly summary, then chat cleanup (Amgad, 24 Nov 2026). Once a week, on Sunday night in the person's
 * own time zone, this employee writes a summary of its conversations with them, keeps it, and only then
 * deletes those conversations; it starts every request from the summary. On by default for a new
 * employee. Switching it off shows Amgad's warning first, in the person's language with the English
 * below.
 */
export function ChatSummarySection({ agentId }: { agentId: string }) {
  const t = useT();
  const language = useLanguage();
  const state = useQuery(chatSummaryQueryOptions(agentId));
  const set = useMutation(setChatSummaryMutationOptions(queryClient));
  const [confirming, setConfirming] = useState(false);
  const data = state.data;
  if (!data) return null;

  return (
    <section
      aria-labelledby="chat-summary-title"
      className="flex flex-col gap-3"
    >
      <Item variant="outline" size="sm">
        <ItemContent>
          <ItemTitle id="chat-summary-title">
            {t("Weekly summary, then chat cleanup")}
          </ItemTitle>
          <ItemDescription className="line-clamp-none">
            {t(
              "Once a week, on Sunday night, this digital employee writes a summary of its conversations with you, keeps it, and then deletes those conversations. It starts every request from the summary, for lower usage and cost of your language model.",
            )}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <Switch
            aria-label={t("Weekly summary, then chat cleanup")}
            checked={data.enabled}
            disabled={set.isPending}
            onCheckedChange={(next) => {
              if (next) set.mutate({ agentId, enabled: true });
              else setConfirming(true);
            }}
          />
        </ItemActions>
      </Item>
      {data.lastError ? (
        <p className="text-sm text-muted-foreground">
          {t(
            "The last summary could not be made, so nothing was deleted. It is tried again next time.",
          )}
        </p>
      ) : null}
      {data.summary ? (
        <details>
          <summary className="cursor-pointer text-sm">
            {data.summarisedAt
              ? tNow("The summary it starts from (made {date})", {
                  date: new Date(data.summarisedAt).toLocaleDateString(
                    dateLocale(),
                    {
                      dateStyle: "medium",
                    },
                  ),
                })
              : t("The summary it starts from")}
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">
            {data.summary}
          </pre>
        </details>
      ) : null}
      {set.error ? (
        <p className="text-sm text-destructive" role="alert">
          {set.error.message}
        </p>
      ) : null}

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Keep the full chat?")}</DialogTitle>
            <DialogDescription render={<div />}>
              <p>{t(data.warning)}</p>
              {language === "en" ? null : (
                <p className="mt-2 text-xs" lang="en">
                  {data.warning}
                </p>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setConfirming(false)} variant="outline">
              {t("Keep it on")}
            </Button>
            <Button
              onClick={() =>
                set.mutate(
                  { agentId, enabled: false },
                  { onSuccess: () => setConfirming(false) },
                )
              }
              variant="destructive"
            >
              {t("Switch it off")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
