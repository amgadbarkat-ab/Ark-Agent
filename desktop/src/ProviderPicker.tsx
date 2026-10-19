import { invoke } from "@tauri-apps/api/core";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ExternalLink } from "./ExternalLink";
import { isHttpEndpointUrl } from "./http-endpoint-url";
import { LocalModelPanel } from "./LocalModelPanel";
import { Mark } from "./Mark";
import { asProblem, InlineFailure, type Problem } from "./Problem";

export type Login = "api-key" | "endpoint" | "oauth" | "managed";

export type Provider = {
  id: string;
  name: string;
  summary: string;
  logins: Login[];
  mark: string | null;
  caution: { says: string; reads_more_at: string } | null;
  /** Shown but not choosable yet, and the sentence saying why. */
  unavailable?: string | null;
};

/** What the flow carries forward once this screen is done. */
export type ModelChoice = {
  provider: string;
  login: Login;
  apiKey?: string;
  /** Explicit intent to try a saved value; only Start checks whether it is available. */
  saved?: boolean;
  baseUrl?: string;
  containerBaseUrl?: string;
  model?: string;
};

export type SavedConfiguration = {
  model?:
    | "open-ai-api-key"
    | "anthropic-api-key"
    | "compatible-endpoint"
    | "local-model"
    | "google-oauth"
    | "xai-oauth"
    | null;
  modelApiKeys?: Partial<
    Record<"openai" | "anthropic" | "compatible", boolean | null>
  >;
  modelSessions?: Partial<Record<"google" | "xai", boolean | null>>;
};

export type HeldConfiguration = {
  INTELLIGENCE_API_KEY?: string;
  INTELLIGENCE_API_URL?: string;
  INTELLIGENCE_GATEWAY_WS_URL?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OPENAI_CONTAINER_BASE_URL?: string;
  BOT_MODEL?: string;
  saved?: SavedConfiguration;
};

const endpointPresets: Record<
  string,
  { baseUrl: string; model: string; keyUrl: string }
> = {
  // https://ai.google.dev/gemini-api/docs/openai
  google: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    model: "gemini-3.8-flash",
    keyUrl: "https://aistudio.google.com/apikey",
  },
  // https://docs.x.ai/developers/model-capabilities/legacy/chat-completions
  xai: {
    baseUrl: "https://api.x.ai/v1",
    model: "grok-4.7",
    keyUrl: "https://console.x.ai/",
  },
};

function endpointIdentity(baseUrl: string | undefined): string {
  if (!baseUrl) return "";
  try {
    return new URL(baseUrl.trim()).href.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function endpointProvider(baseUrl: string | undefined): string {
  return (
    Object.entries(endpointPresets).find(
      ([, preset]) =>
        endpointIdentity(preset.baseUrl) === endpointIdentity(baseUrl),
    )?.[0] ?? "openai-compatible"
  );
}

export function recordedModel(held: HeldConfiguration): ModelChoice | null {
  switch (held.saved?.model) {
    case "open-ai-api-key":
      return { provider: "openai", login: "api-key", saved: true };
    case "anthropic-api-key":
      return { provider: "anthropic", login: "api-key", saved: true };
    case "google-oauth":
    case "xai-oauth":
      return {
        provider: held.saved.model === "google-oauth" ? "google" : "xai",
        login: "oauth",
        saved: true,
        model: held.BOT_MODEL,
      };
    case "local-model":
      return { provider: "local", login: "managed" };
    case "compatible-endpoint":
      return {
        provider: "openai-compatible",
        login: "endpoint",
        baseUrl: held.OPENAI_BASE_URL,
        containerBaseUrl: held.OPENAI_CONTAINER_BASE_URL,
        model: held.BOT_MODEL,
        saved: held.saved.modelApiKeys?.compatible === true,
      };
    default:
      return null;
  }
}

/**
 * Connect a model.
 *
 * Ark never signs in to a chat subscription on a person's behalf: Anthropic does not allow it, and
 * OpenAI allows it in a paid app only through its own approved programme (docs/ark/04). So the ways
 * in are an API key, an endpoint (a local model, or any OpenAI-compatible server) and, for Google and
 * xAI, their own sign-in.
 */
export function ProviderPicker({
  chosen,
  held,
  root,
  onChoose,
  onBack,
  returning = false,
  busy: starting = false,
  advanced,
  canContinue = true,
}: {
  chosen: ModelChoice | null;
  /**
   * Credentials a previous run already wrote, by environment name.
   *
   * Used to fill the key field for whichever provider is chosen, so somebody who has set this up
   * before is not sent to find a key they already produced. Their own file, on their own machine.
   */
  held: HeldConfiguration;
  root: string;
  onChoose: (choice: ModelChoice) => void;
  onBack: () => void;
  returning?: boolean;
  busy?: boolean;
  /**
   * What goes under the AI choice on this same page: the agent framework and where ArkAgent is kept. Given
   * what is chosen so far, because which frameworks can work depends on it.
   */
  advanced?: (selection: {
    provider: string | null;
    login: Login | null;
  }) => ReactNode;
  /** False while something on this page, outside the AI choice, is not filled in yet. */
  canContinue?: boolean;
}) {
  const initialChoice = chosen ?? recordedModel(held);
  const [reuse, setReuse] = useState(
    initialChoice?.saved
      ? { provider: initialChoice.provider, login: initialChoice.login }
      : null,
  );
  const [rows, setRows] = useState<Provider[]>([]);
  const [open, setOpen] = useState<string | null>(
    initialChoice?.provider === "openai-compatible"
      ? endpointProvider(initialChoice.baseUrl)
      : (initialChoice?.provider ?? null),
  );
  const [login, setLogin] = useState<Login | null>(
    initialChoice?.login ?? null,
  );
  const [apiKey, setApiKey] = useState(initialChoice?.apiKey ?? "");
  const [baseUrl, setBaseUrl] = useState(initialChoice?.baseUrl ?? "");
  const [containerBaseUrl, setContainerBaseUrl] = useState(
    initialChoice?.containerBaseUrl ?? "",
  );
  const [model, setModel] = useState(initialChoice?.model ?? "");
  const [reuseEndpointKey, setReuseEndpointKey] = useState(
    initialChoice?.provider === "openai-compatible" &&
      initialChoice.saved === true,
  );
  /*
   * The sign-in, mid-flight.
   *
   * `url` present means the browser has been sent somewhere and the sign-in is waiting for the
   * person to approve it. Kept here rather than in the Rust side's head because the screen has to
   * show the link: an open that silently did nothing leaves somebody staring at a wait with no idea
   * where to go.
   */
  const [signInUrl, setSignInUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // There is a model this computer can run, and which one. The download itself happens during setup.
  const [localReady, setLocalReady] = useState(false);
  const [localModel, setLocalModel] = useState<string | null>(
    initialChoice?.provider === "local" ? (initialChoice.model ?? null) : null,
  );
  // A problem, not a string: a sign-in failure carries the underlying output, and
  // stringifying it printed "[object Object]" where the diagnosis should have been.
  const [failure, setFailure] = useState<Problem | null>(null);
  const openRef = useRef(open);
  const signInRunRef = useRef(0);
  const oauthAttempt = useRef<string | null>(null);
  const [oauthCode, setOauthCode] = useState<string | null>(null);
  const [oauthSignedIn, setOauthSignedIn] = useState<string | null>(
    initialChoice?.login === "oauth" && initialChoice.saved
      ? initialChoice.provider
      : null,
  );

  async function cancelOAuth() {
    signInRunRef.current += 1;
    const attemptId = oauthAttempt.current;
    oauthAttempt.current = null;
    setBusy(false);
    setSignInUrl(null);
    setOauthCode(null);
    if (attemptId) {
      try {
        await invoke("cancel_model_oauth", { attemptId });
      } catch (error) {
        setFailure(asProblem(error));
      }
    }
  }

  async function beginOAuth() {
    if (!row) return;
    const providerId = row.id;
    const run = ++signInRunRef.current;
    const current = () =>
      signInRunRef.current === run && openRef.current === providerId;
    setBusy(true);
    setFailure(null);
    setOauthSignedIn(null);
    try {
      const authorization = await invoke<{
        attemptId: string;
        url: string;
        userCode: string | null;
      }>("begin_model_oauth", { root: root.trim(), provider: providerId });
      if (!current()) {
        await invoke("cancel_model_oauth", {
          attemptId: authorization.attemptId,
        });
        return;
      }
      oauthAttempt.current = authorization.attemptId;
      setSignInUrl(authorization.url);
      setOauthCode(authorization.userCode);
      try {
        await invoke("plugin:opener|open_url", { url: authorization.url });
      } catch (error) {
        if (current()) setFailure(asProblem(error));
      }
      await invoke("finish_model_oauth", {
        attemptId: authorization.attemptId,
      });
      if (current()) {
        setOauthSignedIn(providerId);
        setSignInUrl(null);
        setOauthCode(null);
        setFailure(null);
      }
    } catch (error) {
      if (current()) {
        setFailure(asProblem(error));
        setSignInUrl(null);
        setOauthCode(null);
      }
    } finally {
      if (current()) {
        oauthAttempt.current = null;
        setBusy(false);
      }
    }
  }

  useEffect(
    () => () => {
      signInRunRef.current += 1;
      const attemptId = oauthAttempt.current;
      if (attemptId) {
        invoke("cancel_model_oauth", { attemptId }).catch(() => {
          console.error(
            "ArkAgent could not cancel the pending provider sign-in.",
          );
        });
      }
    },
    [],
  );

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    invoke<Provider[]>("providers")
      .then(setRows)
      .catch(() => undefined);
  }, []);

  const row = rows.find((r) => r.id === open) ?? null;
  const preset = row ? endpointPresets[row.id] : undefined;
  const savedApiKey =
    row?.id === "openai" || row?.id === "anthropic"
      ? held.saved?.modelApiKeys?.[row.id] === true ||
        (reuse?.provider === row.id && reuse.login === "api-key")
      : false;
  const savedEndpointKey =
    login === "endpoint" &&
    reuseEndpointKey &&
    held.saved?.modelApiKeys?.compatible === true &&
    baseUrl.trim() === held.OPENAI_BASE_URL?.trim();
  const containerBaseUrlIsValid =
    containerBaseUrl.trim().length === 0 || isHttpEndpointUrl(containerBaseUrl);

  // What "done" means differs by the way in, and each is checked before Continue lights up rather
  // than after a run fails with something unreadable.
  const ready =
    (login === "managed" && localReady) ||
    (login === "oauth" &&
      oauthSignedIn === row?.id &&
      model.trim().length > 0) ||
    (login === "api-key" && (apiKey.trim().length > 0 || savedApiKey)) ||
    /*
     * An endpoint needs an address and a model name. NOT A KEY: this row's own summary names
     * Ollama and vLLM, and neither has one, so requiring a key refused the two examples the screen
     * offers. The Rust side already treats it as optional and writes `OPENAI_API_KEY` only when it
     * is given.
     */
    (login === "endpoint" &&
      isHttpEndpointUrl(baseUrl) &&
      containerBaseUrlIsValid &&
      model.trim().length > 0 &&
      (!preset || apiKey.trim().length > 0 || savedEndpointKey));

  function continueWithChoice() {
    if (!row || !login || !ready) return;
    const trimmedApiKey = apiKey.trim();
    const trimmedBaseUrl = baseUrl.trim();
    const trimmedModel = model.trim();
    const trimmedContainerBaseUrl = containerBaseUrl.trim();
    onChoose({
      provider: login === "endpoint" ? "openai-compatible" : row.id,
      login,
      ...((login === "api-key" || login === "endpoint") && trimmedApiKey
        ? { apiKey: trimmedApiKey }
        : {}),
      ...(login === "oauth" ? { saved: true } : {}),
      ...((login === "api-key" && !trimmedApiKey && savedApiKey) ||
      (login === "endpoint" && !trimmedApiKey && savedEndpointKey)
        ? { saved: true }
        : {}),
      ...(login !== "oauth" && trimmedBaseUrl
        ? { baseUrl: trimmedBaseUrl }
        : {}),
      ...(login !== "oauth" && trimmedContainerBaseUrl
        ? { containerBaseUrl: trimmedContainerBaseUrl }
        : {}),
      ...(login === "managed" && localModel ? { model: localModel } : {}),
      ...(login !== "managed" && trimmedModel ? { model: trimmedModel } : {}),
    });
  }

  return (
    <div className="sheet">
      {!returning && <p className="steps-of">Step 1 of 2</p>}
      <h1>{returning ? "Refresh your AI connection" : "Connect your AI"}</h1>
      <p className="lede">
        Everything about the AI is on this page: where it comes from (a free
        model on this computer, ArkAgent's server, or your own key), and, under
        Advanced, which agent framework runs it.
      </p>

      <fieldset className="picker providers">
        <legend className="sr-only">Model provider</legend>
        {rows.map((r) => (
          <label
            key={r.id}
            className={`tile wide${open === r.id ? " chosen" : ""}${r.unavailable ? " unavailable" : ""}`}
          >
            <input
              type="radio"
              name="provider"
              className="tile-input"
              value={r.id}
              checked={open === r.id}
              disabled={Boolean(r.unavailable)}
              onChange={() => {
                if (oauthAttempt.current) void cancelOAuth();
                signInRunRef.current += 1;
                setOpen(r.id);
                // A failure belongs to the row that produced it. Left in place, a refused OpenAI
                // sign-in stayed on screen under the endpoint row's fields, where it read as a
                // complaint about the address just typed.
                setFailure(null);
                setSignInUrl(null);
                setBusy(false);
                setLogin(r.logins[0] ?? null);
                // Fill from what is already on this machine, if anything.
                const kept =
                  r.id === "openai"
                    ? held.OPENAI_API_KEY
                    : r.id === "anthropic"
                      ? held.ANTHROPIC_API_KEY
                      : undefined;
                setApiKey(kept ?? "");
                const nextPreset = endpointPresets[r.id];
                const restoreEndpoint =
                  r.id === "openai-compatible" ||
                  (nextPreset &&
                    endpointProvider(held.OPENAI_BASE_URL) === r.id);
                setReuseEndpointKey(
                  Boolean(restoreEndpoint) &&
                    held.saved?.modelApiKeys?.compatible === true,
                );
                if (restoreEndpoint && held.OPENAI_BASE_URL) {
                  setBaseUrl(held.OPENAI_BASE_URL);
                  setContainerBaseUrl(held.OPENAI_CONTAINER_BASE_URL ?? "");
                  setModel(held.BOT_MODEL ?? nextPreset?.model ?? "");
                } else {
                  setBaseUrl(nextPreset?.baseUrl ?? "");
                  setContainerBaseUrl("");
                  setModel(nextPreset?.model ?? "");
                }
              }}
            />
            <Mark id={r.mark} name={r.name} />
            <span className="tile-name">{r.name}</span>
            <span className="tile-summary">{r.summary}</span>
            {r.unavailable && (
              <span className="tile-note">{r.unavailable}</span>
            )}
          </label>
        ))}
      </fieldset>

      {row && (
        <div className="chosen-provider">
          {row.logins.length > 1 && (
            <div className="segmented" role="tablist">
              {row.logins.map((option) => (
                <button
                  type="button"
                  key={option}
                  role="tab"
                  aria-selected={login === option}
                  className={login === option ? "on" : ""}
                  onClick={() => {
                    if (login === "oauth" && option !== login)
                      void cancelOAuth();
                    setLogin(option);
                  }}
                >
                  {option === "oauth" ? "Sign in" : "Use an API key"}
                </button>
              ))}
            </div>
          )}

          {login === "managed" && (
            <LocalModelPanel
              root={root}
              chosen={localModel}
              onChoose={setLocalModel}
              onReady={setLocalReady}
            />
          )}

          {login === "oauth" && (
            <>
              <p className="footnote">
                {row.id === "google"
                  ? "Authorize Gemini API access using the configured Google Cloud project and its API quota."
                  : "Authorize ArkAgent to use models available to your xAI account."}
              </p>
              {oauthSignedIn === row.id ? (
                <p className="lede">Signed in to {row.name}.</p>
              ) : signInUrl ? (
                <>
                  <p role="status">
                    Waiting for you to approve sign-in in your browser.
                  </p>
                  {oauthCode && (
                    <p>
                      Verification code: <strong>{oauthCode}</strong>
                    </p>
                  )}
                  <ExternalLink href={signInUrl}>
                    Open sign-in page
                  </ExternalLink>
                  <button type="button" className="quiet" onClick={cancelOAuth}>
                    Cancel sign-in
                  </button>
                </>
              ) : null}
              {!busy && (
                <button type="button" onClick={beginOAuth}>
                  Sign in {oauthSignedIn === row.id ? "again " : ""}with{" "}
                  {row.name}
                </button>
              )}
              {busy && !signInUrl && <p role="status">Preparing sign-in…</p>}
              <div className="field">
                <label htmlFor="oauth-model">Model name</label>
                <input
                  id="oauth-model"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  spellCheck={false}
                />
              </div>
            </>
          )}

          {login === "api-key" && (
            <>
              {savedApiKey && !apiKey ? (
                <p className="lede">A saved {row.name} API key will be used.</p>
              ) : null}
              {!savedApiKey &&
                (row.id === "openai" || row.id === "anthropic") &&
                held.saved?.modelApiKeys?.[row.id] !== false && (
                  <button
                    type="button"
                    className="quiet"
                    onClick={() => {
                      setApiKey("");
                      setReuse({ provider: row.id, login: "api-key" });
                    }}
                  >
                    Use a saved {row.name} API key
                  </button>
                )}
              <div className="field">
                <label htmlFor="key">{row.name} API key</label>
                <input
                  id="key"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            </>
          )}

          {login === "endpoint" && (
            <>
              {savedEndpointKey && !apiKey && (
                <p className="lede">
                  A saved API key for this endpoint will be used.{" "}
                  {!preset && (
                    <button
                      type="button"
                      className="quiet"
                      onClick={() => setReuseEndpointKey(false)}
                    >
                      Continue without the saved key
                    </button>
                  )}
                </p>
              )}
              {!preset && (
                <>
                  <div className="field">
                    <label htmlFor="base">Base URL</label>
                    <input
                      id="base"
                      value={baseUrl}
                      onChange={(e) => {
                        const next = e.target.value;
                        setBaseUrl(next);
                        if (
                          held.OPENAI_CONTAINER_BASE_URL &&
                          containerBaseUrl.trim() ===
                            held.OPENAI_CONTAINER_BASE_URL.trim() &&
                          next.trim() !== held.OPENAI_BASE_URL?.trim()
                        ) {
                          setContainerBaseUrl("");
                        }
                      }}
                      placeholder="https://…/v1"
                      spellCheck={false}
                    />
                  </div>
                  <details className="field">
                    <summary>Advanced compatible endpoint options</summary>
                    <label htmlFor="container-base">
                      Container Base URL, if different
                    </label>
                    <input
                      id="container-base"
                      value={containerBaseUrl}
                      onChange={(e) => setContainerBaseUrl(e.target.value)}
                      placeholder="http://ollama:11434/v1"
                      spellCheck={false}
                    />
                    <p className="footnote">
                      Leave this empty unless containers need a different
                      address for a locally hosted model. Remote endpoints
                      usually use the same Base URL.
                    </p>
                  </details>
                </>
              )}
              <div className="field">
                <label htmlFor="model">Model name</label>
                <input
                  id="model"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="the name the endpoint knows it by"
                  spellCheck={false}
                />
              </div>
              <div className="field">
                <label htmlFor="ekey">
                  {preset
                    ? `${row.name} API key`
                    : "API key, if the endpoint needs one"}
                </label>
                <input
                  id="ekey"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              {preset && (
                <p className="footnote">
                  <ExternalLink key={preset.keyUrl} href={preset.keyUrl}>
                    Get a {row.name} API key
                  </ExternalLink>
                </p>
              )}
            </>
          )}

          {/* Said before it happens rather than diagnosed after the Bots stop answering. */}
          {failure && <InlineFailure problem={failure} />}

          {row.caution && (
            <p className="caution">
              {row.caution.says}{" "}
              <a
                href={row.caution.reads_more_at}
                target="_blank"
                rel="noreferrer"
              >
                What this means
              </a>
            </p>
          )}
        </div>
      )}

      {advanced?.({ provider: row?.id ?? null, login })}

      <div className="row">
        <button
          type="button"
          className="quiet"
          onClick={onBack}
          disabled={starting}
        >
          Back
        </button>
        <button
          type="button"
          disabled={starting || !row || !login || !ready || !canContinue}
          onClick={continueWithChoice}
        >
          Continue
        </button>
      </div>
    </div>
  );
}
