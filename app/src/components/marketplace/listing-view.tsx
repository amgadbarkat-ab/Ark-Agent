import {
  IconAlertTriangle,
  IconBook,
  IconBuildingStore,
  IconCheck,
  IconClock,
  IconFlag,
  IconTool,
  IconUser,
} from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { ReportDialog } from "@/components/marketplace/report-dialog";
import { ShareDialog } from "@/components/marketplace/share-dialog";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { sentenceNow, tNow, useT } from "@/lib/i18n";
import {
  installListingMutationOptions,
  withdrawListingMutationOptions,
} from "@/lib/marketplace/mutations";
import {
  CATEGORIES,
  isOfficialContent,
  type ListingDetail,
  type OfficialRole,
} from "@/lib/marketplace/queries";
import { queryClient } from "@/query-client";

const STATUS_WORDS: Record<string, string> = {
  pending: tNow("Waiting for review. Only you and our team can see it."),
  rejected: "Not approved.",
  removed: tNow("Taken down by our team."),
  published: tNow("Published. Everyone can read it."),
};

/**
 * A listing's page. An official digital employee can be installed; a shared coworker can only be
 * read, and the page says so in words rather than just leaving the button out.
 */
export function ListingView({
  backButton,
  listing,
}: {
  backButton: { label: string; linkProps: { to: "/agents" } };
  listing: ListingDetail;
}) {
  const t = useT();
  const content = listing.content;
  const official = isOfficialContent(content);
  const install = useMutation(installListingMutationOptions(queryClient));
  const withdraw = useMutation(withdrawListingMutationOptions(queryClient));
  const [reporting, setReporting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmingWithdraw, setConfirmingWithdraw] = useState(false);
  const category = CATEGORIES.find((c) => c.id === listing.category)?.name;

  return (
    <PageShell
      action={
        official ? (
          <Button
            disabled={install.isPending}
            onClick={() => install.mutate(listing.slug)}
            size="sm"
          >
            {install.isPending
              ? "Installing…"
              : listing.installedByMe
                ? t("Install another")
                : "Install"}
          </Button>
        ) : listing.mine ? null : (
          <Button onClick={() => setReporting(true)} size="sm" variant="ghost">
            <IconFlag />
            {t("Report")}
          </Button>
        )
      }
      backButton={backButton}
      description={sentenceNow(listing.summary)}
      title={sentenceNow(listing.title)}
    >
      {install.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {install.error.message}
        </p>
      ) : null}
      {install.data ? (
        <p className="mt-4 text-sm" role="status">
          {tNow("{name} is now one of your digital employees.", {
            name: install.data.name,
          })}{" "}
          <Link
            className="underline underline-offset-2"
            search={{ agent: install.data.agentId }}
            to="/agents"
          >
            {t("Open it")}
          </Link>
        </p>
      ) : null}

      {official ? null : (
        <PageSection>
          <PageRows>
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconBook />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{t("For reading only")}</ItemTitle>
                <ItemDescription className="line-clamp-none">
                  {t(
                    "This is a guide to how someone set up their digital employee. It cannot be installed, copied or exported, and it never runs on your account.",
                  )}
                </ItemDescription>
              </ItemContent>
            </Item>
          </PageRows>
        </PageSection>
      )}

      {/* Where it stands matters to its owner, and to staff for anything not yet public. */}
      {listing.status && (listing.mine || listing.status !== "published") ? (
        <PageSection title={t("Status")}>
          <PageRows>
            <Item size="sm">
              <ItemMedia variant="icon">
                {listing.status === "published" ? (
                  <IconCheck />
                ) : listing.status === "pending" ? (
                  <IconClock />
                ) : (
                  <IconAlertTriangle />
                )}
              </ItemMedia>
              <ItemContent>
                <ItemTitle className="capitalize">{listing.status}</ItemTitle>
                <ItemDescription className="line-clamp-none">
                  {STATUS_WORDS[listing.status]}
                  {listing.reviewNote ? ` ${listing.reviewNote}` : ""}
                </ItemDescription>
              </ItemContent>
              {listing.mine && listing.status !== "removed" ? (
                <ItemActions>
                  <Button
                    onClick={() => setEditing(true)}
                    size="sm"
                    variant="outline"
                  >
                    {t("Change")}
                  </Button>
                  <Button
                    onClick={() => setConfirmingWithdraw(true)}
                    size="sm"
                    variant="outline"
                  >
                    {t("Withdraw")}
                  </Button>
                </ItemActions>
              ) : null}
            </Item>
          </PageRows>
          {confirmingWithdraw ? (
            <div className="mt-3 flex items-center gap-2 text-sm">
              <span>{t("Withdraw this listing for good?")}</span>
              <Button
                onClick={() => setConfirmingWithdraw(false)}
                size="sm"
                variant="ghost"
              >
                {t("Keep it")}
              </Button>
              <Button
                disabled={withdraw.isPending}
                onClick={() =>
                  withdraw.mutate(listing.id, {
                    onSuccess: () => setConfirmingWithdraw(false),
                  })
                }
                size="sm"
                variant="destructive"
              >
                {withdraw.isPending ? "Withdrawing…" : "Withdraw"}
              </Button>
            </div>
          ) : null}
          {withdraw.error ? (
            <p className="mt-2 text-destructive text-sm" role="alert">
              {withdraw.error.message}
            </p>
          ) : null}
        </PageSection>
      ) : null}

      {listing.description ? (
        <PageSection title={t("About")}>
          <p className="mt-3 whitespace-pre-wrap text-pretty text-sm leading-relaxed">
            {sentenceNow(listing.description)}
          </p>
        </PageSection>
      ) : null}

      <PageSection
        title={official ? t("What you get") : t("How it is set up")}
        description={
          official
            ? t(
                "A digital employee of your own, private to you. It starts with this role and the skills below, and no tools; you decide what it may use.",
              )
            : undefined
        }
      >
        <PageRows>
          {official ? (
            <>
              <Detail label={t("Name")} value={content.install.name} />
              <Separator />
              <Detail
                label={t("Title")}
                value={sentenceNow(content.install.title)}
              />
              <Separator />
              <Detail
                label={t("Starts with this role")}
                value={sentenceNow(content.install.roleDescription)}
              />
              {content.suggestedTools.length > 0 ? (
                <>
                  <Separator />
                  <Detail
                    icon={<IconTool />}
                    label={t("Works best with")}
                    value={content.suggestedTools.join(", ")}
                  />
                </>
              ) : null}
            </>
          ) : (
            <>
              <Detail label={t("Role")} value={content.roleDescription} />
              {content.instructions ? (
                <>
                  <Separator />
                  <Detail
                    label={t("Instruction")}
                    value={content.instructions}
                  />
                </>
              ) : null}
              <Separator />
              <Detail
                icon={<IconTool />}
                label={t("Tools it could use")}
                value={
                  content.tools.length > 0 ? content.tools.join(", ") : "None"
                }
              />
            </>
          )}
        </PageRows>
      </PageSection>

      {official && content.role?.iam ? (
        <RoleSections role={content.role} />
      ) : null}

      <PageSection title={t("Details")}>
        <PageRows>
          <Item
            render={
              <Link
                params={{ id: listing.publisher.id }}
                to="/marketplace/publishers/$id"
              />
            }
            size="sm"
          >
            <ItemMedia variant="icon">
              {listing.publisher.official ? (
                <IconBuildingStore />
              ) : (
                <IconUser />
              )}
            </ItemMedia>
            <ItemContent>
              <ItemTitle>
                {listing.publisher.official
                  ? "Ark"
                  : listing.publisher.displayName}
              </ItemTitle>
              <ItemDescription>
                {[
                  category,
                  listing.tags.join(", "),
                  official ? `${listing.installCount} installed` : undefined,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </ItemDescription>
            </ItemContent>
          </Item>
        </PageRows>
      </PageSection>

      <ReportDialog
        onOpenChange={setReporting}
        open={reporting}
        slug={listing.slug}
      />
      {listing.mine ? (
        <ShareDialog
          listing={listing}
          onOpenChange={setEditing}
          open={editing}
        />
      ) : null}
    </PageShell>
  );
}

/** A labelled, read-only value. The text is the point, so it is not clipped. */
const bullets = (items: string[]) =>
  items.map((item) => `\u2022 ${item}`).join("\n");

/** What a role is, said the way it says it: who it is, who it works with, what it brings and what it asks for. */
function RoleSections({ role }: { role: OfficialRole }) {
  const t = useT();
  const requests = [
    ...role.connections.map((request) => ({
      label: request.app,
      why: request.why,
    })),
    ...role.mcpServers.map((request) => ({
      label: `${request.server} (server)`,
      why: request.why,
    })),
  ];
  return (
    <>
      <PageSection
        description={t("How it introduces itself, and what its work is.")}
        title={t("Who it is")}
      >
        <PageRows>
          <Detail
            label={t("Introduces itself as")}
            value={`I am ${role.iam}.`}
          />
          <Separator />
          <Detail label={t("Its work")} value={bullets(role.duties)} />
          <Separator />
          <Detail label={t("Works with")} value={bullets(role.worksWith)} />
          <Separator />
          <Detail label={t("Supported by")} value={bullets(role.supportedBy)} />
          <Separator />
          <Detail label={t("What it can do")} value={bullets(role.canDo)} />
        </PageRows>
      </PageSection>
      <PageSection
        description={t(
          "Added to your Skills page and switched on for it when you add it.",
        )}
        title={t("Skills it comes with")}
      >
        <PageRows>
          {role.skills.map((skill, index) => (
            <Fragment key={skill.slug}>
              <Detail
                label={`/${skill.slug}`}
                value={`${sentenceNow(skill.title)}. ${sentenceNow(skill.summary)}`}
              />
              {index !== role.skills.length - 1 && <Separator />}
            </Fragment>
          ))}
        </PageRows>
      </PageSection>
      <PageSection
        description={t(
          "Nothing is connected for you. It asks, and works only with what you allow.",
        )}
        title={t("What it will ask you to connect")}
      >
        <PageRows>
          {requests.map((request, index) => (
            <Fragment key={request.label}>
              <Detail
                icon={<IconTool />}
                label={sentenceNow(request.label)}
                value={sentenceNow(request.why)}
              />
              {index !== requests.length - 1 && <Separator />}
            </Fragment>
          ))}
        </PageRows>
      </PageSection>
    </>
  );
}

function Detail({
  icon,
  label,
  value,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <Item size="sm">
      {icon ? <ItemMedia variant="icon">{icon}</ItemMedia> : null}
      <ItemContent>
        <ItemTitle>{label}</ItemTitle>
        <ItemDescription className="line-clamp-none whitespace-pre-wrap">
          {value}
        </ItemDescription>
      </ItemContent>
    </Item>
  );
}
