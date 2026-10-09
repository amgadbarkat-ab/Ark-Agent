import { createFileRoute } from "@tanstack/react-router";
import { Streamdown } from "streamdown";
import { termsOfService } from "@/lib/generated/terms";
import { legalComponents } from "@/lib/legal-markdown";

/**
 * The terms of service, public: a customer reads them before they sign up, and the payment provider
 * and the model providers' application forms ask for their address. Outside the signed-in area on
 * purpose.
 *
 * The text is docs/legal/terms-of-service.md, generated into the build, so the one file a lawyer edits
 * is the one people read. Its draft banner stays visible until it is removed from that file: terms
 * that are still a draft must not look final.
 */
export const Route = createFileRoute("/terms")({
  component: TermsOfService,
});

function TermsOfService() {
  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-12">
      <article className="text-sm">
        <Streamdown components={legalComponents}>{termsOfService}</Streamdown>
      </article>
    </main>
  );
}
