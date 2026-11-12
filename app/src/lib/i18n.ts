import { useSyncExternalStore } from "react";

/**
 * The app's own words in the person's language (DT Lab, #83: "App UI is English only").
 *
 * STARTED WITH WHAT A PERSON USES ALL DAY: the sidebar, the message box, the conversation's waiting
 * requests, Requests, the cards a connector draws, and naming a group. Every other screen is still
 * English, and moves over a screen at a time; a word missing here falls back to English rather
 * than to its key.
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
    "The sidebar, the message box, requests and cards. Other screens follow.",
} as const;

export type MessageKey = keyof typeof EN;

const EL: Partial<Record<MessageKey, string>> = {
  "sidebar.search": "Αναζήτηση...",
  "sidebar.skills": "Δεξιότητες",
  "sidebar.team": "Ψηφιακή ομάδα",
  "sidebar.requests": "Αιτήματα",
  "sidebar.needsYou": "Σας περιμένουν",
  "sidebar.noChannels": "Δεν έχετε ακόμη συζητήσεις",
  "sidebar.noMatch": "Καμία συζήτηση δεν ταιριάζει με την αναζήτηση",
  "composer.placeholder": "Ρωτήστε οτιδήποτε",
  "requests.waiting": "Περιμένει εσάς",
  "requests.approved": "Εγκρίθηκε",
  "requests.declined": "Απορρίφθηκε",
  "requests.expired": "Έληξε",
  "requests.failed": "Εγκρίθηκε, αλλά δεν ολοκληρώθηκε",
  "requests.kind.tool": "Θέλει να χρησιμοποιήσει ένα εργαλείο",
  "requests.kind.computer": "Θέλει να ενεργήσει στον περιηγητή του",
  "requests.kind.card": "Σας ρώτησε σε μια συζήτηση",
  "requests.kind.colleague": "Θέλει να αλλάξει τη δουλειά ενός συναδέλφου",
  "requests.approve": "Έγκριση",
  "requests.decline": "Απόρριψη",
  "requests.asked": "ζητήθηκε",
  "requests.open": "Άνοιγμα της συζήτησης",
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
    "Η πλαϊνή στήλη, το πλαίσιο μηνύματος, τα αιτήματα και οι κάρτες. Οι άλλες οθόνες ακολουθούν.",
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

export function setLanguage(language: Language) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, language);
  } catch {
    // A browser that keeps nothing still changes for this session.
  }
  globalThis.dispatchEvent?.(new Event(CHANGED));
  if (typeof document !== "undefined") document.documentElement.lang = language;
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

export function useT() {
  const language = useLanguage();
  return (key: MessageKey, values?: Record<string, string | number>) =>
    translate(language, key, values);
}
