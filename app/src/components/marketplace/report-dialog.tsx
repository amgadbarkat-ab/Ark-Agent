import { useMutation } from "@tanstack/react-query";
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
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { reportListingMutationOptions } from "@/lib/marketplace/mutations";
import { LIMITS, REPORT_REASONS } from "@/lib/marketplace/queries";

/** Tell our team a shared coworker should not be here. One report each; they are read by a person. */
export function ReportDialog({
  onOpenChange,
  open,
  slug,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  slug: string;
}) {
  const [reason, setReason] = useState("");
  const [details, setDetails] = useState("");
  const report = useMutation(reportListingMutationOptions());

  function close(next: boolean) {
    onOpenChange(next);
    if (!next) {
      setReason("");
      setDetails("");
      report.reset();
    }
  }

  return (
    <Dialog onOpenChange={close} open={open}>
      <DialogContent>
        {report.isSuccess ? (
          <>
            <DialogHeader>
              <DialogTitle>Thank you</DialogTitle>
              <DialogDescription>
                Our team will look at it. You do not need to do anything else.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="mt-4">
              <Button onClick={() => close(false)} size="sm">
                Close
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              report.mutate({ slug, reason, details });
            }}
          >
            <DialogHeader>
              <DialogTitle>Report this listing</DialogTitle>
              <DialogDescription>
                Tell us what is wrong. Each person can report a listing once,
                and a person on our team reads it.
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="mt-4 overflow-y-auto">
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="report-reason">What is wrong</FieldLabel>
                  <Select
                    onValueChange={(value) => setReason(String(value))}
                    value={reason}
                  >
                    <SelectTrigger id="report-reason">
                      <SelectValue placeholder="Choose a reason">
                        {REPORT_REASONS.find((r) => r.id === reason)?.name}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {REPORT_REASONS.map((r) => (
                        <SelectItem key={r.id} value={r.id}>
                          {r.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="report-details">
                    Anything we should know (optional)
                  </FieldLabel>
                  <Textarea
                    id="report-details"
                    maxLength={LIMITS.reportDetails}
                    onChange={(event) => setDetails(event.target.value)}
                    rows={4}
                    value={details}
                  />
                </Field>
              </FieldGroup>
              {report.error ? (
                <p className="mt-4 text-destructive text-sm" role="alert">
                  {report.error.message}
                </p>
              ) : null}
            </DialogBody>
            <DialogFooter className="mt-4">
              <Button
                onClick={() => close(false)}
                size="sm"
                type="button"
                variant="ghost"
              >
                Cancel
              </Button>
              <Button
                disabled={report.isPending || reason === ""}
                size="sm"
                type="submit"
              >
                {report.isPending ? "Sending…" : "Send report"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
