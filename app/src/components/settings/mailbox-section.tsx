/**
 * Your own mailbox over IMAP and SMTP (#109): Zoho Mail, cPanel hosting, or any provider that offers
 * both. On Settings, then Connect your Data.
 *
 * The password is typed into a masked field, sent once, tried against the mail server, and stored
 * encrypted on this computer only if the login works. It is never shown again. Every email a digital
 * employee wants to send, and every draft it wants to save, waits for you on an approval card.
 */
import { IconMail } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/lib/i18n";
import {
  connectMailboxMutationOptions,
  disconnectMailboxMutationOptions,
} from "@/lib/mailbox/mutations";
import { connectionsQueryOptions } from "@/lib/plugins/queries";
import { queryClient } from "@/query-client";

/** Starting values for the two providers the trials use. Every field stays editable. */
type ServerFields = {
  imapHost: string;
  imapPort: string;
  smtpHost: string;
  smtpPort: string;
};

const PRESETS: Record<"zoho" | "cpanel", ServerFields> = {
  zoho: {
    imapHost: "imap.zoho.eu",
    imapPort: "993",
    smtpHost: "smtp.zoho.eu",
    smtpPort: "465",
  },
  cpanel: { imapHost: "", imapPort: "993", smtpHost: "", smtpPort: "465" },
};

export function MailboxSection() {
  const t = useT();
  const id = useId();
  const connections = useQuery(connectionsQueryOptions());
  const connect = useMutation(connectMailboxMutationOptions(queryClient));
  const disconnect = useMutation(disconnectMailboxMutationOptions(queryClient));
  const [form, setForm] = useState<
    ServerFields & { user: string; password: string; fromAddress: string }
  >({
    ...PRESETS.zoho,
    user: "",
    password: "",
    fromAddress: "",
  });
  const [editing, setEditing] = useState(false);

  const held = connections.data?.connections.find(
    (row) => row.serverId === "mailbox",
  );
  const set = (field: keyof typeof form) => (value: string) =>
    setForm((current) => ({ ...current, [field]: value }));

  const field = (
    name: keyof typeof form,
    label: string,
    options: {
      type?: string;
      placeholder?: string;
      autoComplete?: string;
    } = {},
  ) => (
    <div className="flex flex-col gap-1">
      <Label htmlFor={`${id}-${name}`}>{label}</Label>
      <Input
        autoComplete={options.autoComplete ?? "off"}
        id={`${id}-${name}`}
        onChange={(event) => set(name)(event.target.value)}
        placeholder={options.placeholder}
        spellCheck={false}
        type={options.type ?? "text"}
        value={form[name]}
      />
    </div>
  );

  return (
    <section aria-label={t("Mailbox (IMAP/SMTP)")} className="mt-8">
      <h2 className="px-2 text-xs font-medium text-muted-foreground">
        {t("Mailbox (IMAP/SMTP)")}
      </h2>
      <div className="mt-3 rounded-lg border border-border p-4">
        <div className="flex items-start gap-3">
          <IconMail aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-sm">
              {held
                ? t("Connected as {account}.", {
                    account: held.account ?? "",
                  })
                : t(
                    "Your own mailbox at Zoho Mail, cPanel hosting or any provider with IMAP and SMTP.",
                  )}
            </p>
            <p className="mt-1 text-muted-foreground text-xs">
              {t(
                "Digital employees can read, search and draft. Every email they want to send, and every draft they want to save, waits for your approval. They cannot forward, delete or move mail.",
              )}
            </p>
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
                {
                  imapHost: form.imapHost.trim(),
                  imapPort: Number(form.imapPort),
                  smtpHost: form.smtpHost.trim(),
                  smtpPort: Number(form.smtpPort),
                  user: form.user.trim(),
                  password: form.password,
                  ...(form.fromAddress.trim()
                    ? { fromAddress: form.fromAddress.trim() }
                    : {}),
                },
                {
                  onSuccess: () => {
                    setForm((current) => ({ ...current, password: "" }));
                    setEditing(false);
                  },
                },
              );
            }}
          >
            <div className="flex gap-2 @min-[36rem]:col-span-2">
              <Button
                onClick={() => setForm((c) => ({ ...c, ...PRESETS.zoho }))}
                size="sm"
                type="button"
                variant="outline"
              >
                {t("Zoho Mail")}
              </Button>
              <Button
                onClick={() => setForm((c) => ({ ...c, ...PRESETS.cpanel }))}
                size="sm"
                type="button"
                variant="outline"
              >
                {t("cPanel hosting")}
              </Button>
            </div>
            {field("imapHost", t("Incoming server (IMAP)"), {
              placeholder: "mail.example.gr",
            })}
            {field("imapPort", t("IMAP port"), { placeholder: "993" })}
            {field("smtpHost", t("Outgoing server (SMTP)"), {
              placeholder: "mail.example.gr",
            })}
            {field("smtpPort", t("SMTP port"), { placeholder: "465" })}
            {field("user", t("User name (usually the email address)"), {
              autoComplete: "username",
            })}
            {field("password", t("Password or app password"), {
              type: "password",
              autoComplete: "new-password",
            })}
            {field("fromAddress", t("Send as (optional)"), {
              placeholder: "info@example.gr",
            })}
            <div className="flex items-end gap-2">
              <Button disabled={connect.isPending} size="sm" type="submit">
                {connect.isPending ? t("Checking…") : t("Connect mailbox")}
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
            <p className="text-muted-foreground text-xs @min-[36rem]:col-span-2">
              {t(
                "The login is tried first, and kept only if it works: encrypted, on this computer. With Zoho two-step sign-in, use an app password and switch IMAP on in Zoho's settings.",
              )}
            </p>
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
    </section>
  );
}
