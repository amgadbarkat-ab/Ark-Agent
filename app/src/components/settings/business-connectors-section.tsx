/**
 * The business connectors on Settings, then Connect your Data (#109, v0.1.43): Skroutz, WooCommerce
 * and BOX NOW, one form each, from the shared list. Every install has all three; each customer's
 * account is typed at the setup session. The login is tried first and kept only if it works,
 * encrypted, on this computer. Secrets are never shown again.
 *
 * And the business's data files: exports such as Pylon's items, stock, sales and customers.
 */
import {
  IconBuildingStore,
  IconFileSpreadsheet,
  IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  connectBusinessMutationOptions,
  disconnectBusinessMutationOptions,
  removeBusinessFileMutationOptions,
  uploadBusinessFileMutationOptions,
} from "@/lib/business/mutations";
import { businessFilesQueryOptions } from "@/lib/business/queries";
import { dateLocale, useT } from "@/lib/i18n";
import { connectionsQueryOptions } from "@/lib/plugins/queries";
import { queryClient } from "@/query-client";
import {
  BUSINESS_CONNECTORS,
  type BusinessConnector,
} from "../../../../shared/business-connectors";

function ConnectorCard({ connector }: { connector: BusinessConnector }) {
  const t = useT();
  const id = useId();
  const connections = useQuery(connectionsQueryOptions());
  const connect = useMutation(
    connectBusinessMutationOptions(queryClient, connector.key),
  );
  const disconnect = useMutation(
    disconnectBusinessMutationOptions(queryClient, connector.key),
  );
  const [form, setForm] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState(false);
  const held = connections.data?.connections.find(
    (row) => row.serverId === connector.key,
  );

  return (
    <div className="mt-3 rounded-lg border border-border p-4">
      <div className="flex items-start gap-3">
        <IconBuildingStore
          aria-hidden="true"
          className="mt-0.5 size-5 shrink-0"
        />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-sm">{t(connector.title)}</p>
          <p className="mt-1 text-sm">
            {held
              ? t("Connected as {account}.", { account: held.account ?? "" })
              : t(connector.summary)}
          </p>
          {!held || editing ? (
            <p className="mt-1 text-muted-foreground text-xs">
              {t(connector.whereToGet)}
            </p>
          ) : null}
        </div>
        {held && !editing ? (
          <div className="flex shrink-0 gap-2">
            <Button
              onClick={() => setEditing(true)}
              size="sm"
              variant="outline"
            >
              {t("Change")}
            </Button>
            <Button
              disabled={disconnect.isPending}
              onClick={() => disconnect.mutate()}
              size="sm"
              variant="ghost"
            >
              {t("Disconnect")}
            </Button>
          </div>
        ) : null}
      </div>
      {!held || editing ? (
        <form
          className="mt-4 grid grid-cols-1 gap-3 @min-[36rem]:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            connect.mutate(
              Object.fromEntries(
                Object.entries(form).filter(([, value]) => value.trim()),
              ),
              {
                onSuccess: () => {
                  setForm({});
                  setEditing(false);
                },
              },
            );
          }}
        >
          {connector.fields.map((field) => (
            <div className="flex flex-col gap-1" key={field.name}>
              <Label htmlFor={`${id}-${field.name}`}>{t(field.label)}</Label>
              <Input
                autoComplete={field.secret ? "new-password" : "off"}
                id={`${id}-${field.name}`}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    [field.name]: event.target.value,
                  }))
                }
                placeholder={field.placeholder}
                spellCheck={false}
                type={field.secret ? "password" : "text"}
                value={form[field.name] ?? ""}
              />
              {field.help ? (
                <p className="text-muted-foreground text-xs">{t(field.help)}</p>
              ) : null}
            </div>
          ))}
          <div className="flex items-end gap-2">
            <Button disabled={connect.isPending} size="sm" type="submit">
              {connect.isPending ? t("Checking…") : t("Connect")}
            </Button>
            {editing ? (
              <Button
                onClick={() => setEditing(false)}
                size="sm"
                type="button"
                variant="ghost"
              >
                {t("Cancel")}
              </Button>
            ) : null}
          </div>
          {connect.error ? (
            <p
              className="text-destructive text-sm @min-[36rem]:col-span-2"
              role="alert"
            >
              {connect.error.message}
            </p>
          ) : null}
        </form>
      ) : null}
      {disconnect.error ? (
        <p className="mt-2 text-destructive text-sm" role="alert">
          {disconnect.error.message}
        </p>
      ) : null}
    </div>
  );
}

export function BusinessConnectorsSection() {
  const t = useT();
  return (
    <section aria-label={t("Shop and delivery")} className="mt-8">
      <h2 className="px-2 font-medium text-muted-foreground text-xs">
        {t("Shop and delivery")}
      </h2>
      {BUSINESS_CONNECTORS.map((connector) => (
        <ConnectorCard connector={connector} key={connector.key} />
      ))}
    </section>
  );
}

export function BusinessFilesSection() {
  const t = useT();
  const id = useId();
  const files = useQuery(businessFilesQueryOptions());
  const upload = useMutation(uploadBusinessFileMutationOptions(queryClient));
  const remove = useMutation(removeBusinessFileMutationOptions(queryClient));
  const [name, setName] = useState("");
  const input = useRef<HTMLInputElement>(null);

  return (
    <section aria-label={t("Business data files")} className="mt-8">
      <h2 className="px-2 font-medium text-muted-foreground text-xs">
        {t("Business data files")}
      </h2>
      <div className="mt-3 rounded-lg border border-border p-4">
        <div className="flex items-start gap-3">
          <IconFileSpreadsheet
            aria-hidden="true"
            className="mt-0.5 size-5 shrink-0"
          />
          <p className="min-w-0 flex-1 text-sm">
            {t(
              "Exports from your ERP or any table you keep, as CSV or XLSX: for example Pylon's items, stock, sales or customer lists. Each has a short name; uploading again under the same name replaces it. Employees given this tool read rows exactly as written.",
            )}
          </p>
        </div>
        {files.data?.folder ? (
          <p className="mt-2 text-muted-foreground text-xs">
            {t(
              "Exports saved into {folder} are loaded here by themselves within a minute, named after the file (stock.xlsx becomes stock). A newer export replaces the older one.",
              { folder: files.data.folder },
            )}
          </p>
        ) : null}
        {(files.data?.files ?? []).map((file) => (
          <div
            className="mt-3 flex items-center justify-between gap-2 text-sm"
            key={file.name}
          >
            <span className="min-w-0 truncate">
              <strong>{file.name}</strong>:{" "}
              {t("{file}, {rows} rows, uploaded {when}", {
                file: file.fileName,
                rows: file.rows,
                when: new Date(file.uploadedAt).toLocaleDateString(
                  dateLocale(),
                ),
              })}
            </span>
            <Button
              aria-label={t("Remove {name}", { name: file.name })}
              disabled={remove.isPending}
              onClick={() => remove.mutate(file.name)}
              size="sm"
              variant="ghost"
            >
              <IconTrash className="size-4" />
            </Button>
          </div>
        ))}
        <div className="mt-4 flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-name`}>{t("Name")}</Label>
            <Input
              id={`${id}-name`}
              onChange={(event) => setName(event.target.value)}
              placeholder="stock"
              spellCheck={false}
              value={name}
            />
          </div>
          <input
            accept=".csv,.xlsx,.txt"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              upload.mutate(
                { name: name.trim().toLowerCase(), file },
                { onSuccess: () => setName("") },
              );
            }}
            ref={input}
            type="file"
          />
          <Button
            disabled={upload.isPending || !name.trim()}
            onClick={() => input.current?.click()}
            size="sm"
            variant="outline"
          >
            {upload.isPending ? t("Uploading…") : t("Choose file")}
          </Button>
        </div>
        {upload.error ? (
          <p className="mt-2 text-destructive text-sm" role="alert">
            {upload.error.message}
          </p>
        ) : null}
      </div>
    </section>
  );
}
