/**
 * The setup window in English or Greek (#108). The same table as the app (shared/i18n): a sentence
 * translated once reads the same in the setup window and in the app.
 *
 * The window asks before anything else, on its first screen, and starts from the computer's own
 * language. Switching reloads the window, so text worked out outside a component (`tNow`) is never
 * left in the old language. The choice is handed to the app when it opens (`languageForApp`), and
 * the app keeps its own choice from then on.
 *
 * What the engine says (a `Problem`, a progress step) arrives as English sentences and is shown
 * through `sentenceNow`, so the Rust side stays one language and the Greek lives in one place.
 */
import {
  createElement,
  Fragment,
  type ReactNode,
  useCallback,
  useSyncExternalStore,
} from "react";
import {
  type Language,
  translateSentence,
  translateText,
} from "../../shared/i18n/translate";

export type { Language };

const STORAGE_KEY = "arkagent.setup.language";
const CHANGED = "arkagent:setup-language";

/** Greek when the computer is set to Greek and nothing was chosen here yet. */
function fromComputer(): Language {
  try {
    const languages = globalThis.navigator?.languages ?? [
      globalThis.navigator?.language,
    ];
    return languages.some((code) => /^el\b/i.test(code ?? "")) ? "el" : "en";
  } catch {
    return "en";
  }
}

export function storedLanguage(): Language {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (stored === "el" || stored === "en") return stored;
  } catch {
    // Fall through to the computer's language.
  }
  return fromComputer();
}

/** Whether the person chose here, rather than it being guessed from the computer. */
export function languageWasChosen(): boolean {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

/** Stores the choice and redraws the window in it. */
export function switchLanguage(language: Language) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, language);
  } catch {
    // A webview that keeps nothing still changes for this session.
  }
  globalThis.dispatchEvent?.(new Event(CHANGED));
  if (typeof document !== "undefined") document.documentElement.lang = language;
  globalThis.location?.reload();
}

if (typeof document !== "undefined")
  document.documentElement.lang = storedLanguage();

/** For `show_openbot`: the language the app should open in. */
export function languageForApp(): Language {
  return storedLanguage();
}

function subscribe(changed: () => void) {
  globalThis.addEventListener?.(CHANGED, changed);
  globalThis.addEventListener?.("storage", changed);
  return () => {
    globalThis.removeEventListener?.(CHANGED, changed);
    globalThis.removeEventListener?.("storage", changed);
  };
}

export function useLanguage(): Language {
  return useSyncExternalStore(subscribe, storedLanguage, () => "en");
}

/** `t("Start ArkAgent")`, `t("{count} left", { count })`: the text in the chosen language. */
export function useT() {
  const language = useLanguage();
  return useCallback(
    (text: string, values?: Record<string, string | number>) =>
      translateText(language, text, values),
    [language],
  );
}

/** For code outside a component: the text in the language chosen right now. */
export function tNow(
  text: string,
  values?: Record<string, string | number>,
): string {
  return translateText(storedLanguage(), text, values);
}

/** A sentence from the engine, in the language chosen right now. */
export function sentenceNow<T extends string | null | undefined>(
  sentence: T,
): T extends string ? string : T {
  type Out = T extends string ? string : T;
  if (typeof sentence !== "string") return sentence as Out;
  return translateSentence(storedLanguage(), sentence) as Out;
}

function fillNodes(text: string, nodes: Record<string, ReactNode>): ReactNode {
  const parts = text.split(/\{(\w+)\}/);
  return createElement(
    Fragment,
    null,
    ...parts.map((part, index) =>
      index % 2 === 1
        ? createElement(Fragment, { key: index }, nodes[part] ?? `{${part}}`)
        : part,
    ),
  );
}

/** A sentence with a link or a name in bold in it, translated whole and then filled in. */
export function useTx() {
  const t = useT();
  return useCallback(
    (text: string, nodes: Record<string, ReactNode>): ReactNode =>
      fillNodes(t(text), nodes),
    [t],
  );
}

export function txNow(
  text: string,
  nodes: Record<string, ReactNode>,
): ReactNode {
  return fillNodes(tNow(text), nodes);
}
