import {
  IconBuildingBank,
  IconBuildingStore,
  IconChevronRight,
  IconCloud,
  IconCode,
  IconCreditCard,
  IconDeviceDesktop,
  IconFileText,
  IconKey,
  IconLayoutGrid,
  IconListDetails,
  IconPuzzle,
  IconShieldCheck,
  IconUsers,
} from "@tabler/icons-react";
import {
  createFileRoute,
  Link,
  type LinkOptions,
} from "@tanstack/react-router";
import { AdminOverview } from "@/components/admin/overview";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { tNow, useT } from "@/lib/i18n";

export const Route = createFileRoute("/_authed/admin/")({
  component: RouteComponent,
});

/**
 * Grouped by what the decision is about rather than by how the code is organised.
 *
 * "What Bots can reach" is the group an administrator arrives worrying about, so it goes first.
 * Everything in it either grants a capability or fences one in.
 */
const SECTIONS: {
  title: string;
  description: string;
  items: {
    description: string;
    icon: React.ComponentType<{ className?: string }>;
    linkOptions: LinkOptions;
    title: string;
  }[];
}[] = [
  {
    title: tNow("What digital employees can reach"),
    description: tNow(
      "Everything a digital employee can touch outside this app, and the limits on it.",
    ),
    items: [
      {
        title: tNow("Credentials"),
        description: tNow("Keys and tokens held for this deployment."),
        icon: IconKey,
        linkOptions: { to: "/admin/credentials" },
      },
      {
        title: tNow("Boundaries"),
        description: tNow(
          "Rules that decide what a digital employee may never do.",
        ),
        icon: IconShieldCheck,
        linkOptions: { to: "/admin/boundaries" },
      },
      {
        title: tNow("Computers"),
        description: tNow("The machines digital employees run their tools on."),
        icon: IconDeviceDesktop,
        linkOptions: { to: "/admin/computers" },
      },
    ],
  },
  {
    title: tNow("What digital employees can do"),
    description: tNow(
      "Capabilities and interface pieces available across digital employees.",
    ),
    items: [
      {
        title: tNow("Plugins"),
        description: tNow(
          "The services this deployment can reach, and which digital employees may.",
        ),
        icon: IconPuzzle,
        linkOptions: { to: "/admin/plugins" },
      },
      {
        title: tNow("Skills"),
        description: tNow(
          "Named instructions anybody can invoke with a slash.",
        ),
        icon: IconFileText,
        linkOptions: { to: "/admin/skills" },
      },
      {
        title: "UI Components",
        description: tNow(
          "Custom pieces a digital employee can draw in a conversation.",
        ),
        icon: IconLayoutGrid,
        linkOptions: { to: "/admin/components" },
      },
      {
        title: tNow("Playground"),
        description: tNow("Write a component and watch it render as you type."),
        icon: IconCode,
        linkOptions: { to: "/admin/playground" },
      },
    ],
  },
  {
    title: tNow("Who can get in"),
    description: "",
    items: [
      {
        title: tNow("People"),
        description: tNow(
          "Everybody who has signed in, who administers this deployment, and whose access has been removed.",
        ),
        icon: IconUsers,
        linkOptions: { to: "/admin/people" },
      },
      {
        title: tNow("Accounts"),
        description: tNow(
          "Every customer account: its plan, how much is in use, and whether it may run.",
        ),
        icon: IconCreditCard,
        linkOptions: { to: "/admin/accounts" },
      },
      {
        title: tNow("Cloud costs"),
        description: tNow(
          "What running in Ark's cloud costs us, what it is priced at, and what was charged.",
        ),
        icon: IconCloud,
        linkOptions: { to: "/admin/cloud" },
      },
      {
        title: tNow("Marketplace"),
        description: tNow(
          "Shared digital employees waiting for review, and the ones people have reported.",
        ),
        icon: IconBuildingStore,
        linkOptions: { to: "/admin/marketplace" },
      },
      {
        title: tNow("Identity providers"),
        description: tNow(
          "A company's own SAML or OpenID Connect provider, routed by email domain.",
        ),
        icon: IconBuildingBank,
        linkOptions: { to: "/admin/identity-providers" },
      },
    ],
  },
  {
    title: tNow("What happened"),
    description: "",
    items: [
      {
        title: tNow("Audit"),
        description: tNow(
          "Every action taken in this deployment, and by whom.",
        ),
        icon: IconListDetails,
        linkOptions: { to: "/admin/audit" },
      },
    ],
  },
];

function RouteComponent() {
  const t = useT();
  return (
    <PageShell
      description={t(
        "What needs you, how the service is doing, and the settings that apply to everybody in this deployment. Anything here affects every person and every digital employee, which is what separates it from your own preferences.",
      )}
      title={t("Admin")}
    >
      <AdminOverview />
      {SECTIONS.map((section) => (
        <PageSection
          description={section.description || undefined}
          key={section.title}
          title={section.title}
        >
          <PageRows>
            {section.items.map((item, index) => (
              <StaggerItem index={index} key={item.title}>
                {/*
                 * The whole row is the link, not a chevron somebody has to aim at: every row here
                 * goes exactly one place, so there is nothing else the row could mean.
                 */}
                <Item
                  render={(props) => <Link {...item.linkOptions} {...props} />}
                  size="sm"
                >
                  <ItemMedia>
                    <item.icon className="size-4 text-muted-foreground" />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{item.title}</ItemTitle>
                    <ItemDescription>{item.description}</ItemDescription>
                  </ItemContent>
                  <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </Item>
                {index !== section.items.length - 1 && <Separator />}
              </StaggerItem>
            ))}
          </PageRows>
        </PageSection>
      ))}
    </PageShell>
  );
}
