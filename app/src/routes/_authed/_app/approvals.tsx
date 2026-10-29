import { createFileRoute } from "@tanstack/react-router";
import { ApprovalsList } from "@/components/approvals/approvals-list";
import { PageShell } from "@/components/layout/page-shell";

/**
 * Everything that needs the person: a lead's request to change a colleague's work, a tool call or a
 * browser action held for their approval, and an approval card raised in a conversation. Nothing in
 * here has happened yet. Each is carried out when it is approved and not before, and lapses after a
 * week if nobody answers.
 */
export const Route = createFileRoute("/_authed/_app/approvals")({
  component: ApprovalsPage,
});

function ApprovalsPage() {
  return (
    <PageShell
      description="Everything your digital employees are waiting on you for. Nothing here has happened yet: it is carried out when you approve it, exactly as shown, and not before."
      title="Requests"
    >
      <ApprovalsList />
    </PageShell>
  );
}
