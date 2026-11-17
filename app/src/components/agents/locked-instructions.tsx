import { useState } from "react";
import { Button } from "@/components/ui/button";
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
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Textarea } from "@/components/ui/textarea";
import { useSentence, useT } from "@/lib/i18n";
import { downloadProposalFile, proposalFile } from "@/lib/trial/proposal";
import {
  PROPOSAL_MAX_INSTRUCTION,
  PROPOSAL_MAX_REASON,
} from "../../../../shared/instruction-proposal";

/**
 * A trial employee's standing instruction, read-only (#116, item 2).
 *
 * On a trial install the instruction of every employee from the signed profile is BlackArk's: it is
 * tested against the employee's cases before it reaches a customer, and changes only with a newer
 * signed profile. So it is shown, not edited, and an administrator gets "Propose a change", which
 * makes a file to send to BlackArk and changes nothing here.
 */
export function LockedInstructionsItem({
  employee,
  current,
  appVersion,
  canPropose,
}: {
  /** `key` is the employee's key in the signed profile, which is how BlackArk knows it. */
  employee: { key: string; name: string };
  /** What it runs on now. */
  current: string;
  appVersion: string;
  /** Administrators only. */
  canPropose: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <Item variant="muted">
      <ItemContent>
        <ItemTitle>{t("Instructions")}</ItemTitle>
        <ItemDescription className="line-clamp-none">
          {t(
            "Set by BlackArk in the signed trial profile, so it cannot be edited here. It changes only when BlackArk sends a new profile.",
          )}
        </ItemDescription>
        <p className="line-clamp-4 whitespace-pre-wrap text-sm text-muted-foreground">
          {current}
        </p>
      </ItemContent>
      {canPropose ? (
        <ItemActions>
          <Button onClick={() => setOpen(true)} size="sm" variant="outline">
            {t("Propose a change")}
          </Button>
        </ItemActions>
      ) : null}
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent>
          {/* Mounted only while open, so each opening starts from the current text. */}
          {open ? (
            <ProposeChangeForm
              appVersion={appVersion}
              current={current}
              employee={employee}
              onDone={() => setOpen(false)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </Item>
  );
}

function ProposeChangeForm({
  employee,
  current,
  appVersion,
  onDone,
}: {
  employee: { key: string; name: string };
  current: string;
  appVersion: string;
  onDone: () => void;
}) {
  const t = useT();
  const sentence = useSentence();
  const [proposed, setProposed] = useState(current);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);

  const complete =
    proposed.trim() !== "" &&
    proposed.trim() !== current.trim() &&
    reason.trim() !== "";

  /** The file, or null with the reason on screen. */
  function file() {
    setError(null);
    try {
      return proposalFile({
        employee: { id: employee.key, name: employee.name },
        current,
        proposed,
        reason,
        appVersion,
      });
    } catch (failure) {
      setError(
        failure instanceof Error
          ? sentence(failure.message)
          : t("Could not make the file."),
      );
      return null;
    }
  }

  if (saved) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>{t("The file is ready")}</DialogTitle>
          <DialogDescription>
            {t(
              "Send it to BlackArk. Nothing on this computer has changed: the new instruction arrives with a new signed trial profile, once BlackArk has tested it.",
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="mt-4">
          <Button onClick={onDone} size="sm">
            {t("Close")}
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
        const made = file();
        if (!made) return;
        downloadProposalFile(made);
        setSaved(true);
      }}
    >
      <DialogHeader>
        <DialogTitle>{t("Propose a change")}</DialogTitle>
        <DialogDescription>
          {t(
            "For {name}. Write the instruction you want instead and say why. This makes a file to send to BlackArk; nothing on this computer changes until BlackArk sends a new signed trial profile.",
            { name: employee.name },
          )}
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="mt-4 overflow-y-auto">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="proposal-current">
              {t("Current instruction")}
            </FieldLabel>
            <Textarea id="proposal-current" readOnly rows={4} value={current} />
          </Field>
          <Field>
            <FieldLabel htmlFor="proposal-new">
              {t("Proposed instruction")}
            </FieldLabel>
            <Textarea
              id="proposal-new"
              maxLength={PROPOSAL_MAX_INSTRUCTION}
              onChange={(event) => {
                setProposed(event.target.value);
                setCopied(false);
              }}
              rows={8}
              value={proposed}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="proposal-reason">{t("Why")}</FieldLabel>
            <Textarea
              id="proposal-reason"
              maxLength={PROPOSAL_MAX_REASON}
              onChange={(event) => {
                setReason(event.target.value);
                setCopied(false);
              }}
              rows={3}
              value={reason}
            />
            <FieldDescription>
              {t(
                "BlackArk reads this when it tests the change. The file holds only this employee's name, its instruction, your text and this reason: no conversations, mail or files.",
              )}
            </FieldDescription>
          </Field>
        </FieldGroup>
        {error ? (
          <p className="mt-3 text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </DialogBody>
      <DialogFooter className="mt-4">
        <Button onClick={onDone} size="sm" type="button" variant="ghost">
          {t("Cancel")}
        </Button>
        <Button
          disabled={!complete}
          onClick={() => {
            const made = file();
            if (!made) return;
            const refused = () =>
              setError(t("Could not copy. Download the file instead."));
            if (!navigator.clipboard) {
              refused();
              return;
            }
            void navigator.clipboard
              .writeText(made.text)
              .then(() => setCopied(true), refused);
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          {copied ? t("Copied") : t("Copy")}
        </Button>
        <Button disabled={!complete} size="sm" type="submit">
          {t("Download the file")}
        </Button>
      </DialogFooter>
    </form>
  );
}
