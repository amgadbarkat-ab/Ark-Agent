import { createFileRoute } from "@tanstack/react-router";
import { Streamdown } from "streamdown";
import { privacyNotice } from "@/lib/generated/privacy-notice";
import { legalComponents } from "@/lib/legal-markdown";

/**
 * The privacy notice, public: a customer reads it before they sign up, and Google's sign-in consent
 * screen asks for its address. Outside the signed-in area on purpose.
 *
 * The text is docs/legal/privacy-notice.md, generated into the build, so the one file a lawyer edits
 * is the one people read. Its draft banner stays visible until it is removed from that file: a notice
 * that is still a draft must not look final.
 */
export const Route = createFileRoute("/privacy")({
  component: PrivacyNotice,
});

function PrivacyNotice() {
  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-12">
      <article className="text-sm">
        <Streamdown components={legalComponents}>{privacyNotice}</Streamdown>
      </article>
    </main>
  );
}
