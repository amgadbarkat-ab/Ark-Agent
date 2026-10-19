import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { isHttpEndpointUrl } from "./http-endpoint-url";
import { Mark } from "./Mark";

export type Harness = {
  id: string;
  name: string;
  summary: string;
  image: string | null;
  health_path: string | null;
  credential: "any-provider" | "anthropic" | "their-endpoint";
  maintainer: "first-party" | "partnership" | "community";
  mark: string | null;
  port: number | null;
};

export type HarnessChoice = {
  id: string;
  agentUrl?: string;
};

/** What ArkAgent sets up unless somebody says otherwise. David's call. */
export const DEFAULT_HARNESS = "langgraph";

/**
 * The frameworks that answer only on an Anthropic API key. Mirrors `harness::incompatible_with_model`, which
 * is what actually refuses; this copy lets the screen say so before anybody presses anything.
 */
const NEEDS_ANTHROPIC_KEY = new Set(["claude-agent-sdk"]);

export function needsAnthropicKey(id: string | undefined): boolean {
  return id !== undefined && NEEDS_ANTHROPIC_KEY.has(id);
}

/**
 * The agent framework, chosen on the same page as the AI.
 *
 * ONE CHOICE IS MADE FOR THE PERSON, and that is the point of this section rather than a limitation of it.
 * The rows are agent frameworks, and to anybody who is not a developer the difference between them is nil:
 * they take any model and answer the same questions. Asking a non-technical person to pick one is asking
 * them to make a decision they cannot inform, so the default is stated in one line and the list stays
 * behind a disclosure.
 *
 * It lives on the AI page, not on a page of its own, because the two answers depend on each other: the
 * Claude Agent SDK runs only on an Anthropic API key, so which frameworks can be picked follows from which
 * AI was. A row that cannot work with the AI chosen is shown, disabled, with the reason, and is never
 * offered as if it would.
 */
export function FrameworkChoice({
  chosen,
  onChoose,
  anthropicKey,
}: {
  chosen: HarnessChoice | null;
  onChoose: (choice: HarnessChoice) => void;
  /** Whether the AI chosen above is Anthropic, by API key. */
  anthropicKey: boolean;
}) {
  const [rows, setRows] = useState<Harness[]>([]);
  const [failure, setFailure] = useState("");
  // Open when the person has already chosen something other than the default, so coming back does not
  // hide the choice they made.
  const [open, setOpen] = useState(
    chosen !== null && chosen.id !== DEFAULT_HARNESS,
  );

  useEffect(() => {
    invoke<Harness[]>("harnesses")
      .then(setRows)
      .catch((error) => setFailure(String(error)));
  }, []);

  const chosenId = chosen?.id ?? DEFAULT_HARNESS;
  const picked = rows.find((row) => row.id === chosenId);
  const byoAgentUrl = chosenId === "byo-url" ? (chosen?.agentUrl ?? "") : "";
  const byoReady =
    (byoAgentUrl.trim().startsWith("http://") ||
      byoAgentUrl.trim().startsWith("https://")) &&
    isHttpEndpointUrl(byoAgentUrl);

  if (failure) {
    return (
      <div className="blocker" role="alert">
        <h2>The list of agent frameworks could not be read</h2>
        <p>{failure}</p>
      </div>
    );
  }

  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        {picked && picked.id !== DEFAULT_HARNESS
          ? `Agent framework: ${picked.name}`
          : "Agent framework: ArkAgent chooses (advanced)"}
      </summary>
      <p className="footnote" style={{ margin: "0.6rem 0 0" }}>
        ArkAgent uses LangGraph, which works with every AI, including the one on
        this computer. Change this only if you write code and need another
        framework.
      </p>
      <fieldset className="picker">
        <legend className="sr-only">Agent framework</legend>
        {rows.map((row) => {
          const blocked = row.credential === "anthropic" && !anthropicKey;
          return (
            <label
              key={row.id}
              className={`tile${chosenId === row.id ? " chosen" : ""}${blocked ? " unavailable" : ""}`}
            >
              <input
                type="radio"
                name="harness"
                className="tile-input"
                value={row.id}
                checked={chosenId === row.id}
                disabled={blocked}
                onChange={() =>
                  onChoose(
                    row.id === "byo-url"
                      ? { id: row.id, agentUrl: byoAgentUrl }
                      : { id: row.id },
                  )
                }
              />
              <Mark id={row.mark} name={row.name} />
              {/* The name is on every row, mark or no mark, so a person who does not recognise a
                  logo can still read it. */}
              <span className="tile-name">{row.name}</span>
              <span className="tile-summary">{row.summary}</span>
              {row.id === DEFAULT_HARNESS && (
                <span className="tile-note">Recommended</span>
              )}
              {row.credential === "anthropic" && (
                <span className="tile-note">
                  {blocked
                    ? "Needs Anthropic chosen above, with an API key"
                    : "Uses your Anthropic API key"}
                </span>
              )}
              {row.credential === "their-endpoint" && (
                <span className="tile-note">For developers</span>
              )}
            </label>
          );
        })}
      </fieldset>
      {chosenId === "byo-url" && (
        <div className="field" style={{ marginTop: "0.75rem" }}>
          <label htmlFor="agent-url">AG-UI endpoint</label>
          <input
            id="agent-url"
            value={byoAgentUrl}
            onChange={(event) =>
              onChoose({
                id: "byo-url",
                agentUrl: event.target.value,
              })
            }
            placeholder="https://your-agent.example/ag-ui"
            spellCheck={false}
            aria-invalid={byoAgentUrl !== "" && !byoReady}
          />
        </div>
      )}
    </details>
  );
}

/** Whether a framework choice can be started: the address row needs a valid address. */
export function frameworkReady(choice: HarnessChoice | null): boolean {
  if (choice?.id !== "byo-url") return true;
  const url = choice.agentUrl?.trim() ?? "";
  return (
    (url.startsWith("http://") || url.startsWith("https://")) &&
    isHttpEndpointUrl(url)
  );
}
