import { invoke } from "@tauri-apps/api/core";
import { useRef, useState } from "react";
import { sentenceNow, useT } from "./i18n";

/**
 * "Import trial profile" (#109): on every step of the setup window, beside EN / ΕΛ, for the person
 * setting up a customer's trial. The file is kept on this computer and handed to ArkAgent when its
 * app opens; ArkAgent checks BlackArk's signature then, and says so if it refuses.
 */
export function TrialImport() {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);

  return (
    <div className="trial-import">
      <input
        accept=".arktrial,application/json"
        aria-hidden="true"
        className="sr-only"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          try {
            await invoke("save_trial_profile", { text: await file.text() });
            setSaid({
              ok: true,
              text: t(
                "Trial profile ready. It is imported when ArkAgent opens.",
              ),
            });
          } catch (error) {
            const reason =
              (error as { said?: string } | null)?.said ??
              t("This file is not a trial profile.");
            setSaid({ ok: false, text: sentenceNow(reason) });
          }
        }}
        ref={input}
        tabIndex={-1}
        type="file"
      />
      <button
        className="quiet"
        onClick={() => input.current?.click()}
        type="button"
      >
        {t("Import trial profile")}
      </button>
      {said ? (
        <p
          className={said.ok ? "trial-import-ok" : "trial-import-error"}
          role={said.ok ? "status" : "alert"}
        >
          {said.text}
        </p>
      ) : null}
    </div>
  );
}
