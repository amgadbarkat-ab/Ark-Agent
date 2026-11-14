import {
  createElement,
  Fragment,
  type ReactNode,
  useCallback,
  useSyncExternalStore,
} from "react";
import {
  translateSentence,
  translateText,
} from "../../../shared/i18n/translate";

/**
 * The app's own words in the person's language (DT Lab, #83: "App UI is English only").
 *
 * THE WHOLE APP (MD order, 13 Nov 2026, #108). Two ways in, one table of Greek behind both:
 *  - `t("Save changes")`: the English itself is the key, looked up in shared/i18n. This is how every
 *    screen is written now; see shared/i18n/translate.ts for why.
 *  - `t("sidebar.search")`: the first keys, from before, kept so nothing that used them moves.
 * A sentence that arrives whole (a server error) goes through `translateSentence`, which `client`
 * applies to every error it raises.
 *
 * Chosen per device under Settings, then General, and kept in this browser's storage. English
 * unless chosen: a person who did not ask should not find the buttons moved.
 */
export type Language = "en" | "el";

const STORAGE_KEY = "arkagent.language";
const CHANGED = "arkagent:language";

const EN = {
  "sidebar.search": "Search...",
  "sidebar.skills": "Skills",
  "sidebar.team": "Digital Team",
  "sidebar.requests": "Requests",
  "sidebar.needsYou": "Needs you",
  "sidebar.noChannels": "You don't have channels yet",
  "sidebar.noMatch": "No channels match your search",
  "composer.placeholder": "Ask anything",
  "requests.waiting": "Waiting for you",
  "requests.approved": "Approved",
  "requests.declined": "Declined",
  "requests.expired": "Expired",
  "requests.failed": "Approved, but it could not be carried out",
  "requests.kind.tool": "Wants to use a tool",
  "requests.kind.computer": "Wants to act in its browser",
  "requests.kind.card": "Asked you in a conversation",
  "requests.kind.colleague": "Wants to change a colleague's work",
  "requests.approve": "Approve",
  "requests.decline": "Decline",
  "requests.asked": "asked",
  "requests.open": "Open the conversation",
  "requests.nothing": "Nothing is waiting for you",
  "requests.earlier": "Show earlier requests",
  "requests.onlyWaiting": "Show only what is waiting",
  "requests.here": "Waiting for your approval",
  "card.summarise": "Summarise",
  "card.open": "Open",
  "card.useFile": "Use this file",
  "card.join": "Join",
  "card.more": "Show {n} more",
  "card.unread": "Unread",
  "group.new": "New group",
  "group.description":
    "Name it and choose who is in it. The first one you pick leads and asks the others when the work is theirs.",
  "group.name": "Group name",
  "group.members": "Members",
  "group.leads": "Leads",
  "group.tooFew": "A group needs at least two digital employees.",
  "group.start": "Start group",
  "group.starting": "Starting…",
  "common.cancel": "Cancel",
  "settings.language": "Language",
  "settings.languageHint":
    "Every screen, message and notification. Your digital employees answer in the language you write to them in.",
} as const;

export type MessageKey = keyof typeof EN;

const EL: Partial<Record<MessageKey, string>> = {
  "sidebar.search": "Αναζήτηση...",
  "sidebar.skills": "Δεξιότητες",
  "sidebar.team": "Ψηφιακή ομάδα",
  "sidebar.requests": "Αιτήματα",
  "sidebar.needsYou": "Σας περιμένουν",
  "sidebar.noChannels": "Δεν έχετε ακόμη συνομιλίες",
  "sidebar.noMatch": "Καμία συνομιλία δεν ταιριάζει με την αναζήτηση",
  "composer.placeholder": "Ρωτήστε οτιδήποτε",
  "requests.waiting": "Περιμένει εσάς",
  "requests.approved": "Εγκρίθηκε",
  "requests.declined": "Απορρίφθηκε",
  "requests.expired": "Έληξε",
  "requests.failed": "Εγκρίθηκε, αλλά δεν ολοκληρώθηκε",
  "requests.kind.tool": "Θέλει να χρησιμοποιήσει ένα εργαλείο",
  "requests.kind.computer": "Θέλει να ενεργήσει στον περιηγητή του",
  "requests.kind.card": "Σας ρώτησε σε μια συνομιλία",
  "requests.kind.colleague": "Θέλει να αλλάξει τη δουλειά ενός συναδέλφου",
  "requests.approve": "Έγκριση",
  "requests.decline": "Απόρριψη",
  "requests.asked": "ζητήθηκε",
  "requests.open": "Άνοιγμα της συνομιλίας",
  "requests.nothing": "Τίποτα δεν σας περιμένει",
  "requests.earlier": "Προηγούμενα αιτήματα",
  "requests.onlyWaiting": "Μόνο όσα περιμένουν",
  "requests.here": "Περιμένει την έγκρισή σας",
  "card.summarise": "Σύνοψη",
  "card.open": "Άνοιγμα",
  "card.useFile": "Χρήση αρχείου",
  "card.join": "Συμμετοχή",
  "card.more": "Άλλα {n}",
  "card.unread": "Μη αναγνωσμένο",
  "group.new": "Νέα ομάδα",
  "group.description":
    "Δώστε όνομα και διαλέξτε ποιοι συμμετέχουν. Ο πρώτος που επιλέγετε ηγείται και ζητά από τους άλλους όταν η δουλειά είναι δική τους.",
  "group.name": "Όνομα ομάδας",
  "group.members": "Μέλη",
  "group.leads": "Ηγείται",
  "group.tooFew": "Μια ομάδα χρειάζεται τουλάχιστον δύο ψηφιακούς υπαλλήλους.",
  "group.start": "Έναρξη ομάδας",
  "group.starting": "Έναρξη…",
  "common.cancel": "Άκυρο",
  "settings.language": "Γλώσσα",
  "settings.languageHint":
    "Κάθε οθόνη, μήνυμα και ειδοποίηση. Οι ψηφιακοί σας υπάλληλοι απαντούν στη γλώσσα που τους γράφετε.",
};

const TABLES: Record<Language, Partial<Record<MessageKey, string>>> = {
  en: EN,
  el: EL,
};

export function storedLanguage(): Language {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === "el" ? "el" : "en";
  } catch {
    return "en";
  }
}

/**
 * Where the service worker reads the language, because it cannot read `localStorage`: a push
 * notification arrives with no page open, and is shown in the language chosen here (public/sw.js).
 */
const SHARED_LANGUAGE = "/__ark/language";

function shareLanguage(language: Language) {
  try {
    void globalThis.caches
      ?.open("ark-settings")
      .then((cache) => cache.put(SHARED_LANGUAGE, new Response(language)))
      .catch(() => {});
  } catch {
    // No Cache Storage (a private window, a test): notifications stay in English.
  }
}

/**
 * The desktop setup window asks for a language before the app exists, and opens the app with
 * `?lang=el` (desktop/src-tauri `with_language`). Taken only when nothing is stored yet, so a
 * later switch in Settings is not undone by the next start; then removed from the address.
 */
function languageFromAddress() {
  try {
    const url = new URL(globalThis.location?.href ?? "");
    const asked = url.searchParams.get("lang");
    if (asked !== "el" && asked !== "en") return;
    if (globalThis.localStorage?.getItem(STORAGE_KEY) === null) {
      globalThis.localStorage?.setItem(STORAGE_KEY, asked);
    }
    url.searchParams.delete("lang");
    globalThis.history?.replaceState(globalThis.history.state, "", url.href);
  } catch {
    // No address (a test) or no storage: the stored choice, or English, stands.
  }
}

languageFromAddress();
shareLanguage(storedLanguage());
// Screen readers and hyphenation read the page language from here.
if (typeof document !== "undefined")
  document.documentElement.lang = storedLanguage();

export function setLanguage(language: Language) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, language);
  } catch {
    // A browser that keeps nothing still changes for this session.
  }
  shareLanguage(language);
  globalThis.dispatchEvent?.(new Event(CHANGED));
  if (typeof document !== "undefined") document.documentElement.lang = language;
}

/**
 * Change the language from the Settings switch: remembered, then the app is drawn again from the
 * start, so every screen, every label kept in a constant and every message already on screen is in
 * the new language at once (#108). A reload is about a second, and nothing typed is lost that a
 * page change would not lose.
 */
export function switchLanguage(language: Language) {
  if (language === storedLanguage()) return;
  setLanguage(language);
  globalThis.location?.reload();
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

/** The word for `key` in `language`, with `{n}` and the like filled in. English when missing. */
export function translate(
  language: Language,
  key: MessageKey,
  values: Record<string, string | number> = {},
): string {
  const text = TABLES[language][key] ?? EN[key];
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole,
  );
}

/** An English text, or one of the first keys, in `language`. */
export function translateAny(
  language: Language,
  text: MessageKey | (string & {}),
  values?: Record<string, string | number>,
): string {
  return text in EN
    ? translate(language, text as MessageKey, values)
    : translateText(language, text, values);
}

export function useT() {
  const language = useLanguage();
  // The same function for as long as the language is, so it can sit in a hook's dependencies.
  return useCallback(
    (
      text: MessageKey | (string & {}),
      values?: Record<string, string | number>,
    ) => translateAny(language, text, values),
    [language],
  );
}

/**
 * For code that is not a component (a mutation's error, a toast): the text in the language chosen
 * right now. A component should use `useT`, which also redraws when the language changes.
 */
export function tNow(
  text: MessageKey | (string & {}),
  values?: Record<string, string | number>,
): string {
  return translateAny(storedLanguage(), text, values);
}

/**
 * The locale dates and numbers are written in: Greek ("14/11/2026", "Νοέμβριος 2026") when Greek is
 * chosen, otherwise the browser's own. Pass it wherever a date is turned into text.
 */
export function dateLocale(): string | undefined {
  return storedLanguage() === "el" ? "el-GR" : undefined;
}

/** A whole sentence from elsewhere (the server, a runtime), in the language chosen right now. */
export function sentenceNow<T extends string | null | undefined>(
  sentence: T,
): T extends string ? string : T {
  type Out = T extends string ? string : T;
  if (typeof sentence !== "string") return sentence as Out;
  return translateSentence(storedLanguage(), sentence) as Out;
}

/** The same, redrawing when the language changes. */
export function useSentence() {
  const language = useLanguage();
  return (sentence: string) => translateSentence(language, sentence);
}

/**
 * A sentence with things in it that are not text (a link, a code chip, a name in bold), translated
 * as ONE sentence and then filled in: `tx("Changes apply the next time {command} is used.",
 * { command: <code>/standup</code> })`. Greek word order differs from English, so a sentence must
 * never be glued together from English pieces.
 */
export function useTx() {
  const t = useT();
  return useCallback(
    (text: string, nodes: Record<string, ReactNode>): ReactNode => {
      const parts = t(text).split(/\{(\w+)\}/);
      return createElement(
        Fragment,
        null,
        ...parts.map((part, index) =>
          index % 2 === 1
            ? createElement(
                Fragment,
                { key: index },
                nodes[part] ?? `{${part}}`,
              )
            : part,
        ),
      );
    },
    [t],
  );
}

/** `useTx` without the hook, for a component that already redraws on a language change. */
export function txNow(
  text: string,
  nodes: Record<string, ReactNode>,
): ReactNode {
  const parts = tNow(text).split(/\{(\w+)\}/);
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
