import {
  IconArrowLeft,
  IconCpu,
  IconCreditCard,
  IconLayoutGrid,
  IconPhone,
  IconPlug,
  IconSettings,
  IconShieldLock,
} from "@tabler/icons-react";
import { Link, type LinkOptions } from "@tanstack/react-router";
import type * as React from "react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { tNow, useT } from "@/lib/i18n";

const appLinkOptions = { to: "/" } satisfies LinkOptions;

const ITEMS: {
  /**
   * Whether this entry lights only on its own route.
   *
   * On for an entry whose path is a prefix of another's, which is the only reason to want it. Off
   * everywhere else, so an entry stays lit on the pages beneath it.
   */
  exact?: boolean;
  icon: React.ComponentType<{ className?: string }>;
  linkOptions: LinkOptions;
  title: string;
}[] = [
  {
    title: tNow("General"),
    icon: IconSettings,
    /* `/settings` prefixes every other route here, and would otherwise light up on all of them. */
    exact: true,
    linkOptions: { to: "/settings" },
  },
  {
    /* Where the model behind every coworker comes from: on this computer, free, or your own key. */
    title: tNow("Models"),
    icon: IconCpu,
    linkOptions: { to: "/settings/models" },
  },
  {
    /* What is bought, and how many coworkers it lets work at once. */
    title: tNow("Plan"),
    icon: IconCreditCard,
    linkOptions: { to: "/settings/plan" },
  },
  {
    /* A copy of what is held about you, and a way to have it removed. */
    title: tNow("Your data"),
    icon: IconShieldLock,
    linkOptions: { to: "/settings/privacy" },
  },
  {
    /*
     * The same subject as Admin's Plugins, from the other side: there an administrator decides what
     * this deployment may reach at all, here you decide what it may reach as you.
     */
    title: tNow("Connect your Data"),
    icon: IconPlug,
    linkOptions: { to: "/settings/connected-accounts" },
  },
  {
    /* Being rung about a request that waits for you (P2 idea 10); off unless a deployment offers it. */
    title: tNow("Phone approval"),
    icon: IconPhone,
    linkOptions: { to: "/settings/phone-approval" },
  },
  {
    /* The same mark Admin gives UI Components. It is the same subject seen from the other side. */
    title: tNow("Components gallery"),
    icon: IconLayoutGrid,
    linkOptions: { to: "/settings/components-gallery" },
  },
];

export function SettingsSidebar({
  ...props
}: React.ComponentProps<typeof Sidebar>) {
  const t = useT();
  return (
    <Sidebar {...props}>
      {/* Matched to the app sidebar's header, as Admin's is. See admin-sidebar.tsx. */}
      <SidebarHeader className="h-12 p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={(props) => (
                <Link {...appLinkOptions} {...props}>
                  <IconArrowLeft className="mr-2 h-4 w-4" />
                  {t("Back to app")}
                </Link>
              )}
            />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {/*
         * Group outside menu, as Admin has it. The other way round nests a list item inside a div
         * inside the `ul`, which is not markup a list is allowed to be made of.
         */}
        <SidebarGroup>
          <SidebarMenu className="gap-px">
            {ITEMS.map((option) => (
              <SidebarMenuItem key={option.title}>
                <SidebarMenuButton
                  render={(props) => (
                    <Link
                      {...option.linkOptions}
                      activeOptions={{ exact: option.exact ?? false }}
                      activeProps={{ className: "bg-foreground/5" }}
                      {...props}
                    >
                      <option.icon className="mr-2 h-4 w-4" />
                      {option.title}
                    </Link>
                  )}
                />
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}
