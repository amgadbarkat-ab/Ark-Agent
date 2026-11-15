/**
 * Two built-in tool sets (#109), for administrators, on Settings, then Connect your Data:
 * - the business's price list, uploaded as CSV or XLSX, which the price employees read prices from;
 * - whether video editing can run on this computer, and where its files go.
 */
import { IconMovie, IconTable } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useId, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  removePriceListMutationOptions,
  uploadPriceListMutationOptions,
} from "@/lib/builtin-tools/mutations";
import {
  priceListQueryOptions,
  videoStatusQueryOptions,
} from "@/lib/builtin-tools/queries";
import { useT } from "@/lib/i18n";
import { queryClient } from "@/query-client";

export function PriceListSection() {
  const t = useT();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const list = useQuery(priceListQueryOptions());
  const upload = useMutation(uploadPriceListMutationOptions(queryClient));
  const remove = useMutation(removePriceListMutationOptions(queryClient));
  const held = list.data ?? null;

  return (
    <section aria-label={t("Price list")} className="mt-8">
      <h2 className="px-2 text-xs font-medium text-muted-foreground">
        {t("Price list")}
      </h2>
      <div className="mt-3 rounded-lg border border-border p-4">
        <div className="flex items-start gap-3">
          <IconTable aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-sm" role="status">
              {held
                ? t("{file}: {rows} products, uploaded {date}.", {
                    file: held.fileName,
                    rows: String(held.rows),
                    date: new Date(held.uploadedAt).toLocaleDateString(),
                  })
                : t(
                    "No price list yet. Until one is uploaded, employees say the prices are not loaded.",
                  )}
            </p>
            <p className="mt-1 text-muted-foreground text-xs">
              {t(
                "A CSV or Excel (.xlsx) file, up to 8 MB: a header row, then one product per row, for example code, product, size, price, VAT. Employees quote prices only from this list.",
              )}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <input
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="hidden"
              id={`${id}-file`}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) upload.mutate(file);
                event.target.value = "";
              }}
              ref={input}
              type="file"
            />
            <Button
              disabled={upload.isPending}
              onClick={() => input.current?.click()}
              size="sm"
              variant="outline"
            >
              {held ? t("Replace") : t("Upload")}
            </Button>
            {held ? (
              <Button
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
                size="sm"
                variant="ghost"
              >
                {t("Remove")}
              </Button>
            ) : null}
          </div>
        </div>
        {upload.error || remove.error ? (
          <p className="mt-2 text-destructive text-sm" role="alert">
            {(upload.error ?? remove.error)?.message}
          </p>
        ) : null}
      </div>
    </section>
  );
}

export function VideoEditingSection() {
  const t = useT();
  const status = useQuery(videoStatusQueryOptions());
  const data = status.data;
  if (!data?.enabled) return null;

  return (
    <section aria-label={t("Video editing")} className="mt-8">
      <h2 className="px-2 text-xs font-medium text-muted-foreground">
        {t("Video editing")}
      </h2>
      <div className="mt-3 rounded-lg border border-border p-4">
        <div className="flex items-start gap-3">
          <IconMovie aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-sm" role="status">
              {data.ready
                ? t("Ready: FFmpeg was found on this computer.")
                : t(data.problem ?? "Not ready.")}
            </p>
            {data.mediaDir ? (
              <p className="mt-1 text-muted-foreground text-xs">
                {t(
                  "Put footage, photos and music in {inDir}. Finished videos appear in {outDir}. Every render waits for your approval, and nothing is published.",
                  {
                    inDir: `${data.mediaDir}/in`,
                    outDir: `${data.mediaDir}/out`,
                  },
                )}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
