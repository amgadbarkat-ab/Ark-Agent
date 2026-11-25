import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { languageForApp, useT } from "./i18n";
import { asProblem, Failure, type Problem } from "./Problem";

/**
 * A staff computer joins the company's ArkAgent (Amgad, 24 Nov 2026, option A).
 *
 * The administrator switches on the office network in Settings, then Team, and gives each person
 * the join code it shows. Here the person pastes it; ArkAgent downloads only what it needs to reach
 * the company's computer, and opens there, where they sign in with their own sub-profile. Nothing
 * runs or is kept on this computer. Next time, it goes straight back (`saved`).
 */
export function JoinCompany({
  root,
  saved,
  onBack,
}: {
  root: string;
  /** The code kept from last time: joined again at once, without asking. */
  saved: string | null;
  /** Back to setting up ArkAgent on this computer. */
  onBack: () => void;
}) {
  const t = useT();
  const [code, setCode] = useState(saved ?? "");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const tried = useRef(false);

  const join = useCallback(
    async (value: string) => {
      setBusy(true);
      setProblem(null);
      try {
        await invoke("join_company", {
          root,
          code: value,
          language: languageForApp(),
        });
      } catch (error) {
        setProblem(asProblem(error));
      } finally {
        setBusy(false);
      }
    },
    [root],
  );

  useEffect(() => {
    if (saved && root && !tried.current) {
      tried.current = true;
      void join(saved);
    }
  }, [saved, root, join]);

  return (
    <main>
      <div className="sheet">
        <h1>{t("Join my company's ArkAgent")}</h1>
        <p className="lede">
          {t(
            "Your administrator finds the join code in ArkAgent, under Settings, then Team, once the office network is switched on. Everything stays on their computer: you sign in with your own sub-profile.",
          )}
        </p>
        <label className="field">
          <span>{t("Join code")}</span>
          <textarea
            autoComplete="off"
            disabled={busy}
            onChange={(event) => setCode(event.target.value)}
            rows={3}
            spellCheck={false}
            value={code}
          />
        </label>
        {busy ? (
          <p className="footnote">
            {t("Connecting to your company's ArkAgent…")}
          </p>
        ) : null}
        {problem ? <Failure problem={problem} /> : null}
        <div className="row">
          <button
            disabled={busy || code.trim().length === 0}
            onClick={() => void join(code)}
            type="button"
          >
            {problem && saved ? t("Try again") : t("Join")}
          </button>
          <button
            className="quiet"
            disabled={busy}
            onClick={() => {
              void invoke("leave_company").catch(() => undefined);
              onBack();
            }}
            type="button"
          >
            {t("Set up ArkAgent on this computer instead")}
          </button>
        </div>
      </div>
    </main>
  );
}
