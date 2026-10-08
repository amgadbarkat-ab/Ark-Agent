import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
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
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  type Finding,
  savePublisherMutationOptions,
  shareCoworkerMutationOptions,
  updateListingMutationOptions,
} from "@/lib/marketplace/mutations";
import {
  CATEGORIES,
  LIMITS,
  type ListingDetail,
  myListingsQueryOptions,
} from "@/lib/marketplace/queries";
import { queryClient } from "@/query-client";

/**
 * Put a coworker in the marketplace as a guide, or change one already there.
 *
 * What readers get is the coworker's words and the names of its tools, copied at this moment. They
 * cannot install it, copy it or export it, and it never runs on their account. The dialog says so,
 * because the thing a person most needs to know before sharing is what strangers will be able to do
 * with it.
 */
export function ShareDialog({
  agent,
  listing,
  onOpenChange,
  open,
}: {
  /** The coworker being shared. Absent, the person picks one of their own. */
  agent?: { id: string; name: string; title: string };
  /** The listing being changed. Absent means a new one. */
  listing?: ListingDetail;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        {/* Mounted only while open, so each opening starts from a clean form. */}
        {open ? (
          <ShareForm
            agent={agent}
            key={listing?.id ?? agent?.id ?? "new"}
            listing={listing}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ShareForm({
  agent,
  listing,
  onDone,
}: {
  agent?: { id: string; name: string; title: string };
  listing?: ListingDetail;
  onDone: () => void;
}) {
  const editing = listing !== undefined;
  const mine = useQuery(myListingsQueryOptions());
  const roster = useQuery({
    ...agentListQueryOptions(),
    enabled: !editing && agent === undefined,
  });
  const choices = (roster.data ?? []).filter(
    (candidate) => candidate.mine && !candidate.systemOwned,
  );

  const [agentId, setAgentId] = useState(agent?.id ?? "");
  const [publisherName, setPublisherName] = useState("");
  const [title, setTitle] = useState(listing?.title ?? agent?.title ?? "");
  const [summary, setSummary] = useState(listing?.summary ?? "");
  const [category, setCategory] = useState(listing?.category ?? "other");
  const [tags, setTags] = useState(listing?.tags.join(", ") ?? "");
  const [description, setDescription] = useState(listing?.description ?? "");
  const [confirmed, setConfirmed] = useState(false);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const savePublisher = useMutation(savePublisherMutationOptions(queryClient));
  const share = useMutation(shareCoworkerMutationOptions(queryClient));
  const update = useMutation(updateListingMutationOptions(queryClient));

  const hasName = Boolean(mine.data?.publisher);
  const needsName = mine.data !== undefined && !hasName;
  const hasSecret = findings.some((finding) => finding.secret);
  const needsConfirmation = findings.length > 0 && !hasSecret;
  const busy = savePublisher.isPending || share.isPending || update.isPending;
  const failure = (savePublisher.error ?? share.error ?? update.error)?.message;
  const complete =
    title.trim() !== "" &&
    summary.trim() !== "" &&
    (editing || agentId !== "") &&
    (!needsName || publisherName.trim() !== "") &&
    (!needsConfirmation || confirmed);

  async function send() {
    setRefusal(null);
    const input = {
      title,
      summary,
      category,
      tags: tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
      description,
      confirmedNoPrivateData: confirmed,
    };
    if (needsName) {
      await savePublisher.mutateAsync({
        displayName: publisherName,
        bio: "",
      });
    }
    const result = listing
      ? await update.mutateAsync({ id: listing.id, input })
      : await share.mutateAsync({ ...input, agentId });
    if (result.ok) {
      setSent(true);
      return;
    }
    setFindings(result.findings);
    setRefusal(result.error);
    setConfirmed(false);
  }

  if (sent) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Sent for review</DialogTitle>
          <DialogDescription>
            Our team reads every shared coworker before anyone else can see it.
            You can follow it, change it or withdraw it from your shared
            coworkers.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="mt-4">
          <Button onClick={onDone} size="sm" variant="ghost">
            Close
          </Button>
          <Button
            render={(props) => <Link to="/marketplace/mine" {...props} />}
            size="sm"
          >
            See my shared coworkers
          </Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void send().catch(() => undefined);
      }}
    >
      <DialogHeader>
        <DialogTitle>
          {editing
            ? "Change what you shared"
            : agent
              ? `Share ${agent.name}`
              : "Share a coworker"}
        </DialogTitle>
        <DialogDescription>
          People can read how it is set up: its role, its instruction and the
          names of its tools. They cannot install it, copy it or export it, and
          it never runs on their account. Its address and keys are never shown.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="mt-4 overflow-y-auto">
        <FieldGroup>
          {editing || agent ? null : (
            <Field>
              <FieldLabel htmlFor="share-coworker">Which coworker</FieldLabel>
              <Select
                onValueChange={(value) => {
                  const chosen = choices.find((c) => c.id === value);
                  setAgentId(String(value));
                  if (chosen && !title) setTitle(chosen.title);
                }}
                value={agentId}
              >
                <SelectTrigger id="share-coworker">
                  <SelectValue placeholder="Choose one of yours">
                    {choices.find((c) => c.id === agentId)?.name}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {choices.map((choice) => (
                    <SelectItem key={choice.id} value={choice.id}>
                      {choice.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}

          {needsName ? (
            <Field>
              <FieldLabel htmlFor="share-publisher">
                Your name in the marketplace
              </FieldLabel>
              <Input
                autoComplete="off"
                id="share-publisher"
                maxLength={LIMITS.displayName}
                onChange={(event) => setPublisherName(event.target.value)}
                placeholder="A name or a team"
                value={publisherName}
              />
              <FieldDescription>
                Shown on everything you share. Not your email address.
              </FieldDescription>
            </Field>
          ) : null}

          <Field>
            <FieldLabel htmlFor="share-title">Title</FieldLabel>
            <Input
              id="share-title"
              maxLength={LIMITS.title}
              onChange={(event) => setTitle(event.target.value)}
              value={title}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="share-summary">
              One line about what it does
            </FieldLabel>
            <Input
              id="share-summary"
              maxLength={LIMITS.summary}
              onChange={(event) => setSummary(event.target.value)}
              value={summary}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="share-category">Category</FieldLabel>
            <Select
              onValueChange={(value) => setCategory(String(value))}
              value={category}
            >
              <SelectTrigger id="share-category">
                <SelectValue>
                  {CATEGORIES.find((c) => c.id === category)?.name}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {CATEGORIES.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="share-tags">Tags</FieldLabel>
            <Input
              id="share-tags"
              onChange={(event) => setTags(event.target.value)}
              placeholder="analysis, reports"
              value={tags}
            />
            <FieldDescription>
              Up to {LIMITS.tags}, separated by commas.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="share-description">
              How you use it and what to watch for
            </FieldLabel>
            <Textarea
              id="share-description"
              maxLength={LIMITS.description}
              onChange={(event) => setDescription(event.target.value)}
              rows={5}
              value={description}
            />
            <FieldDescription>Plain text.</FieldDescription>
          </Field>
        </FieldGroup>

        {findings.length > 0 ? (
          <div className="mt-4 space-y-2 text-sm" role="alert">
            <p className={hasSecret ? "text-destructive" : undefined}>
              {refusal}
            </p>
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              {findings.map((finding) => (
                <li key={`${finding.field}-${finding.line}-${finding.kind}`}>
                  {finding.message}
                </li>
              ))}
            </ul>
            {hasSecret ? (
              <p className="text-muted-foreground">
                Fix these in the coworker itself, then share it again. The
                listing is a copy, so changing the coworker changes what is
                shared only when you share it again.
              </p>
            ) : (
              <div className="flex items-start gap-2">
                <Checkbox
                  checked={confirmed}
                  id="share-confirm"
                  onCheckedChange={(next) => setConfirmed(next === true)}
                />
                <label htmlFor="share-confirm">
                  I have read these and nothing here is private or belongs to
                  somebody else.
                </label>
              </div>
            )}
          </div>
        ) : null}

        {failure ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {failure}
          </p>
        ) : null}
      </DialogBody>
      <DialogFooter className="mt-4">
        <Button onClick={onDone} size="sm" type="button" variant="ghost">
          Cancel
        </Button>
        <Button disabled={busy || !complete} size="sm" type="submit">
          {busy ? "Sending…" : editing ? "Send for review" : "Share"}
        </Button>
      </DialogFooter>
    </form>
  );
}
