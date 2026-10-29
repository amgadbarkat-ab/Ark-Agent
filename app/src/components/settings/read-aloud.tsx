import { useQuery } from "@tanstack/react-query";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { queryClient } from "@/query-client";

const LANGUAGE_NAMES = { ar: "Arabic", en: "English" } as const;

/**
 * What Read aloud does here, and whose model speaks.
 *
 * Read-only: the deployment turns it on, not the person, so there is nothing to switch. It is also
 * the one place the app lists the speech model's credit, which its licence asks to be shown; the
 * words come from the server's configuration, so another engine brings its own.
 */
export function ReadAloudSetting() {
  const { data } = useQuery(deploymentCapabilitiesQueryOptions(), queryClient);
  const readAloud = data?.readAloud;
  if (!readAloud) return null;
  const languages = readAloud.languages
    .map((language) => LANGUAGE_NAMES[language])
    .join(" and ");
  return (
    <PageSection title="Read aloud">
      <PageRows>
        <Item size="sm">
          <ItemContent>
            <ItemTitle>Synthetic voice</ItemTitle>
            <ItemDescription>
              Your digital employees' answers in {languages} can be read aloud
              in a synthetic voice: choose Read aloud under an answer. Other
              languages are not read aloud.
              {readAloud.attribution ? (
                <span className="mt-1 block">{readAloud.attribution}</span>
              ) : null}
            </ItemDescription>
          </ItemContent>
        </Item>
      </PageRows>
    </PageSection>
  );
}
