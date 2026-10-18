import { createFileRoute } from "@tanstack/react-router";
import { ApprovalsList } from "@/components/approvals/approvals-list";
import { PageShell } from "@/components/layout/page-shell";

/**
 * Requests from a person's digital employees to change a colleague's work: its routines, its
 * instructions. Nothing in here has happened yet. Each request is applied when it is approved and not
 * before, and lapses after a week if nobody answers.
 */
export const Route = createFileRoute("/_authed/_app/approvals")({
  component: ApprovalsPage,
});

function ApprovalsPage() {
  return (
    <PageShell
      description="What your digital employees have asked to change about a colleague's work. Nothing here has happened yet: it is applied when you approve it, and not before."
      title="Requests"
    >
      <ApprovalsList />
    </PageShell>
  );
}
