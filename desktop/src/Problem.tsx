import { ExternalLink } from "./ExternalLink";
import { sentenceNow, useT } from "./i18n";

/**
 * A failure, in both registers, wherever one happens.
 *
 * ONE IMPLEMENTATION, because there is one rule and every screen owes it: the sentence is the
 * headline and the real output lives behind a disclosure. A second copy is how one screen ends up
 * showing an engine dump as its title, and how another ends up rendering `[object Object]` because
 * it stringified a failure that was never a string.
 */
export type Problem = {
  said: string;
  detail?: string | null;
  connection?: "model" | null;
  database_reset?: string | null;
};

/** Anything thrown, as a problem. A bare string keeps working and reads as it always did. */
export function asProblem(thrown: unknown): Problem {
  if (thrown && typeof thrown === "object" && "said" in thrown) {
    return thrown as Problem;
  }
  return { said: String(thrown) };
}

function SetupHelp() {
  const t = useT();
  /*
   * A support page of Ark's own, once there is one.
   *
   * A build chooses it (`VITE_OPENBOT_SUPPORT_URL`) and never prefills it with error data. Without
   * one there is no link at all: this used to point at CopilotKit's issue tracker, which is not
   * where an Ark customer's problem belongs and not somewhere to send their output.
   */
  const url = import.meta.env.VITE_OPENBOT_SUPPORT_URL?.trim();
  if (!url) return null;
  return (
    <ExternalLink className="setup-help" href={url}>
      {t("Get setup help")}
    </ExternalLink>
  );
}

export function Failure({ problem }: { problem: Problem }) {
  const t = useT();
  return (
    <div className="blocker" role="alert">
      <h2>{t("That did not finish")}</h2>
      <p>{sentenceNow(problem.said)}</p>
      {/* The real output, kept but not the headline. Whoever is debugging opens this; the person
          reading the sentence above never has to. */}
      {problem.detail && (
        <details className="detail-of">
          <summary>{t("Technical details")}</summary>
          <pre>{problem.detail}</pre>
        </details>
      )}
      <SetupHelp />
    </div>
  );
}

/**
 * The same two registers where a whole panel would be too much.
 *
 * Used inside the provider rows, which are small and already have a heading. The sentence reads as
 * a caution and the output is still one click away, so a sign-in that fails inside a card is no
 * less diagnosable than one that fails on its own screen.
 */
export function InlineFailure({ problem }: { problem: Problem }) {
  const t = useT();
  return (
    <div role="alert">
      <p className="caution">{sentenceNow(problem.said)}</p>
      {problem.detail && (
        <details className="detail-of">
          <summary>{t("Technical details")}</summary>
          <pre>{problem.detail}</pre>
        </details>
      )}
      <SetupHelp />
    </div>
  );
}
