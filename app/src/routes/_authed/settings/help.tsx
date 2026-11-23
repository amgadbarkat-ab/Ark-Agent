import {
  IconChevronRight,
  IconClock,
  IconLifebuoy,
  IconMessage,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { dateLocale, tNow, useLanguage, useSentence, useT } from "@/lib/i18n";
import {
  previewSupportRequest,
  type SupportInput,
  sendSupportRequestMutationOptions,
} from "@/lib/support/mutations";
import {
  type SupportPayload,
  type SupportReplyCase,
  type SupportRequest,
  supportRepliesQueryOptions,
  supportStateQueryOptions,
} from "@/lib/support/queries";
import { queryClient } from "@/query-client";

/**
 * Settings, then Help & support (#149; Amgad, 18 Nov 2026: in-app support is BlackArk's only support
 * channel). The person writes what happened and may add diagnostics; before anything leaves this
 * computer they see exactly what will be sent; after sending they get BlackArk's case number. When
 * BlackArk cannot be reached, the request waits here and is sent again by itself.
 */
export const Route = createFileRoute("/_authed/settings/help")({
  component: HelpPage,
});

function when(iso: string): string {
  return new Date(iso).toLocaleString(dateLocale(), {
    dateStyle: "short",
    timeStyle: "short",
  });
}

function HelpPage() {
  const t = useT();
  const state = useQuery(supportStateQueryOptions());
  const [writing, setWriting] = useState(false);

  return (
    <PageShell
      description={t(
        "Write to BlackArk about a problem. You see exactly what will be sent before you send it.",
      )}
      title={t("Help & support")}
    >
      <PageSection title={t("Ask BlackArk")}>
        {state.isPending ? null : state.error || state.data === null ? (
          <p className="text-destructive text-sm" role="alert">
            {t("Help & support is not available here.")}
          </p>
        ) : !state.data.available ? (
          <PageEmpty>
            {t(
              "Help & support needs this computer to be activated with a BlackArk trial or licence first.",
            )}
          </PageEmpty>
        ) : (
          <PageRows>
            <Item
              render={<button onClick={() => setWriting(true)} type="button" />}
              size="sm"
            >
              <ItemMedia variant="icon">
                <IconLifebuoy />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{t("Write to BlackArk")}</ItemTitle>
                <ItemDescription>
                  {t(
                    "Describe the problem. You can add diagnostics: the app version, the system and recent errors. Never your conversations, mail, files or keys.",
                  )}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <IconChevronRight className="size-4 text-muted-foreground" />
              </ItemActions>
            </Item>
            <Separator />
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconClock />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{t("When BlackArk answers")}</ItemTitle>
                <ItemDescription className="line-clamp-none">
                  {t(
                    "Monday to Friday, 09:00 to 18:00, Athens time. During a trial: by the end of the next business day. With a paid plan: within 4 business hours when it stops your work, otherwise by the end of the next business day.",
                  )}
                </ItemDescription>
              </ItemContent>
            </Item>
          </PageRows>
        )}
      </PageSection>

      <PageSection title={t("Your requests")}>
        {state.isPending || !state.data ? null : state.data.requests.length ===
          0 ? (
          <PageEmpty>{t("You have not written to BlackArk yet.")}</PageEmpty>
        ) : (
          <PageRows>
            {state.data.requests.map((request, index) => (
              <RequestRow
                first={index === 0}
                key={request.id}
                request={request}
              />
            ))}
          </PageRows>
        )}
      </PageSection>
      {writing ? <WriteDialog onOpenChange={setWriting} /> : null}
      <Separator className="mt-12 opacity-0" />
    </PageShell>
  );
}

export function RequestRow({
  first,
  request,
}: {
  first: boolean;
  request: SupportRequest;
}) {
  const t = useT();
  const sentence = useSentence();
  const replies = useQuery({
    ...supportRepliesQueryOptions(),
    enabled: request.caseNumber !== null,
  });
  const answered = replies.data?.find((one) => one.case === request.caseNumber);
  const caseLabel = tNow("Case #{number}", { number: request.caseNumber ?? 0 });
  const status =
    request.status === "sent"
      ? answered &&
        (answered.status === "solved" || answered.status === "closed")
        ? `${caseLabel} · ${t("Solved")}`
        : answered && answered.replies.length > 0
          ? `${caseLabel} · ${t("BlackArk answered")}`
          : caseLabel
      : request.status === "queued"
        ? t("Waiting to be sent")
        : t("Not accepted");
  return (
    <>
      {first ? null : <Separator />}
      <Item size="sm">
        <ItemMedia variant="icon">
          <IconMessage />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{request.subject}</ItemTitle>
          <ItemDescription>
            {request.status === "queued" && request.lastError
              ? sentence(request.lastError)
              : when(request.sentAt ?? request.createdAt)}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <span className="text-muted-foreground text-sm">{status}</span>
        </ItemActions>
      </Item>
      {answered && answered.replies.length > 0 ? (
        <RepliesView replies={answered.replies} />
      ) : null}
    </>
  );
}

/** BlackArk's replies to one request: the customer's language, then the English copy below it. */
function RepliesView({ replies }: { replies: SupportReplyCase["replies"] }) {
  const t = useT();
  return (
    <ol aria-label={t("BlackArk's replies")} className="space-y-3 px-3 pb-3">
      {replies.map((reply) => (
        <li
          className="rounded-md border-l-2 border-primary bg-muted/40 px-3 py-2 text-sm"
          key={reply.at}
        >
          <p className="text-muted-foreground text-xs">
            {t("BlackArk replied")} · {when(reply.at)}
          </p>
          <p
            className="mt-1 whitespace-pre-wrap break-words"
            lang={reply.language}
          >
            {reply.text}
          </p>
          {reply.english ? (
            <p
              className="mt-2 whitespace-pre-wrap break-words text-muted-foreground"
              lang="en"
            >
              {reply.english}
            </p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/** Everything that would be sent, field by field, as the person reads it before sending. */
function PayloadView({ payload }: { payload: SupportPayload }) {
  const t = useT();
  const unverified = payload.proof === null;
  const rows: Array<[string, string]> = [
    [t("Subject"), payload.subject],
    [t("What happened"), payload.message],
    [t("It stops our work"), payload.urgent ? t("Yes") : t("No")],
    [t("Language"), payload.language === "el" ? "Ελληνικά" : "English"],
    [
      t("Customer"),
      unverified ? t("Not known yet: not activated") : payload.customerId,
    ],
    ...(unverified
      ? ([[t("Your email"), payload.contactEmail ?? t("None given")]] as Array<
          [string, string]
        >)
      : []),
    [t("This computer's random id"), payload.installId],
    [t("App version"), payload.appVersion],
  ];
  const proof =
    payload.proof === null
      ? null
      : payload.proof.kind === "profile"
        ? `${payload.proof.profile}.${payload.proof.signature}`
        : `${payload.proof.payload}.${payload.proof.signature}`;
  return (
    <div className="space-y-3 text-sm">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        {rows.map(([label, value]) => (
          <div className="contents" key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="whitespace-pre-wrap break-words">{value}</dd>
          </div>
        ))}
      </dl>
      {payload.diagnostics ? (
        <div>
          <p className="font-medium">{t("Diagnostics")}</p>
          <p className="text-muted-foreground">
            {payload.diagnostics.os} · {payload.diagnostics.appVersion}
          </p>
          {payload.diagnostics.logs.length === 0 ? (
            <p className="text-muted-foreground">
              {t("No recent errors on this computer.")}
            </p>
          ) : (
            <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted p-2 text-xs">
              {payload.diagnostics.logs.join("\n")}
            </pre>
          )}
        </div>
      ) : (
        <p className="text-muted-foreground">{t("No diagnostics.")}</p>
      )}
      {payload.proof === null || proof === null ? (
        <p className="text-muted-foreground">
          {t(
            "This computer is not activated yet, so nothing proves to BlackArk whose it is. BlackArk sees this request as unverified.",
          )}
        </p>
      ) : (
        <details>
          <summary className="cursor-pointer">
            {payload.proof.kind === "profile"
              ? t("BlackArk's signed trial file, as BlackArk issued it")
              : t(
                  "BlackArk's signed activation code or licence key, as BlackArk issued it",
                )}
          </summary>
          <p className="mt-1 text-muted-foreground">
            {t(
              "It proves to BlackArk that this request comes from your computer. Nothing in it was written by you.",
            )}
          </p>
          <pre className="mt-1 max-h-32 overflow-auto break-all rounded bg-muted p-2 text-xs whitespace-pre-wrap">
            {proof}
          </pre>
        </details>
      )}
    </div>
  );
}

/**
 * Writing to BlackArk, read before it is sent. `unverified`: this computer is not activated yet
 * (Amgad, 23 Nov 2026), so the person may give an email address for the answer.
 */
export function WriteDialog({
  onOpenChange,
  unverified = false,
}: {
  onOpenChange: (open: boolean) => void;
  unverified?: boolean;
}) {
  const t = useT();
  const language = useLanguage();
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [urgent, setUrgent] = useState(false);
  const [contactEmail, setContactEmail] = useState("");
  const [diagnostics, setDiagnostics] = useState(false);
  const [preview, setPreview] = useState<SupportPayload | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const send = useMutation(sendSupportRequestMutationOptions(queryClient));

  const input: SupportInput = {
    subject,
    message,
    urgent,
    includeDiagnostics: diagnostics,
    language,
    ...(unverified ? { contactEmail: contactEmail.trim() } : {}),
  };
  const emailOk =
    !unverified ||
    contactEmail.trim() === "" ||
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail.trim());
  const ready =
    subject.trim().length >= 3 && message.trim().length >= 10 && emailOk;
  const done = send.data;

  return (
    <Dialog onOpenChange={onOpenChange} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {done
              ? t("Sent to BlackArk")
              : preview
                ? t("This is what will be sent")
                : t("Write to BlackArk")}
          </DialogTitle>
          <DialogDescription>
            {done
              ? done.status === "sent"
                ? tNow(
                    "Your case number is #{number}. BlackArk answers in Help & support's hours.",
                    {
                      number: done.caseNumber ?? 0,
                    },
                  )
                : t(
                    "BlackArk could not be reached just now. Your request is kept on this computer and sent again by itself.",
                  )
              : preview
                ? t("Read it through. Nothing has left this computer yet.")
                : t("Say what happened and what you expected instead.")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 overflow-y-auto">
          {done ? null : preview ? (
            <PayloadView payload={preview} />
          ) : (
            <div className="space-y-4">
              <Field>
                <FieldLabel htmlFor="support-subject">
                  {t("Subject")}
                </FieldLabel>
                <Input
                  id="support-subject"
                  maxLength={200}
                  onChange={(event) => setSubject(event.target.value)}
                  value={subject}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="support-message">
                  {t("What happened")}
                </FieldLabel>
                <Textarea
                  id="support-message"
                  maxLength={8000}
                  onChange={(event) => setMessage(event.target.value)}
                  rows={6}
                  value={message}
                />
              </Field>
              {unverified ? (
                <Field>
                  <FieldLabel htmlFor="support-email">
                    {t("Your email (optional)")}
                  </FieldLabel>
                  <Input
                    aria-invalid={!emailOk}
                    autoComplete="email"
                    id="support-email"
                    maxLength={254}
                    onChange={(event) => setContactEmail(event.target.value)}
                    type="email"
                    value={contactEmail}
                  />
                  <p className="text-muted-foreground text-sm">
                    {t(
                      "This computer is not activated yet, so BlackArk cannot tell whose it is. Give an email address if you want BlackArk to answer you by email.",
                    )}
                  </p>
                </Field>
              ) : null}
              <div className="flex items-center gap-2">
                <Checkbox
                  checked={urgent}
                  id="support-urgent"
                  onCheckedChange={(checked) => setUrgent(checked === true)}
                />
                <label className="text-sm" htmlFor="support-urgent">
                  {t("It stops our work")}
                </label>
              </div>
              <div className="flex items-start gap-2">
                <Checkbox
                  checked={diagnostics}
                  id="support-diagnostics"
                  onCheckedChange={(checked) =>
                    setDiagnostics(checked === true)
                  }
                />
                <label className="text-sm" htmlFor="support-diagnostics">
                  {t(
                    "Include diagnostics: the app version, the system and recent errors, with names, addresses, numbers and keys removed. Never conversations, mail, files or keys.",
                  )}
                </label>
              </div>
            </div>
          )}
          {(previewError ?? send.error) ? (
            <p className="mt-4 text-destructive text-sm" role="alert">
              {previewError ?? send.error?.message}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          {done ? (
            <Button onClick={() => onOpenChange(false)} size="sm" type="button">
              {t("Close")}
            </Button>
          ) : preview ? (
            <>
              <Button
                onClick={() => setPreview(null)}
                size="sm"
                type="button"
                variant="ghost"
              >
                {t("Back")}
              </Button>
              <Button
                disabled={send.isPending}
                onClick={() =>
                  send.mutate({ ...input, previewId: preview.requestId })
                }
                size="sm"
                type="button"
              >
                {send.isPending ? tNow("Sending…") : t("Send to BlackArk")}
              </Button>
            </>
          ) : (
            <>
              <Button
                onClick={() => onOpenChange(false)}
                size="sm"
                type="button"
                variant="ghost"
              >
                {t("Cancel")}
              </Button>
              <Button
                disabled={!ready || checking}
                onClick={() => {
                  setChecking(true);
                  setPreviewError(null);
                  previewSupportRequest(input)
                    .then(setPreview, (error: Error) =>
                      setPreviewError(error.message),
                    )
                    .finally(() => setChecking(false));
                }}
                size="sm"
                type="button"
              >
                {t("See what will be sent")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
