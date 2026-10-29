/**
 * Read aloud: which of a digital employee's messages may be turned into speech, and as what.
 *
 * Shared because the browser and the server must reach the same verdict. The browser only offers the
 * control on a message this says yes to, and the server says it again on the text it loaded itself,
 * because the server is the one that decides what leaves for the speech endpoint.
 */

/**
 * The languages Read aloud speaks. A language is only spoken when the deployment also names a voice
 * for it, so this list is the ceiling rather than the promise.
 *
 * Greek is deliberately absent. The model this was approved with reads Greek letters out as their
 * English names ("alpha", "beta") rather than speaking Greek, so a Greek message is refused before
 * anything is sent. Adding a model that speaks Greek means adding "el" here, a script for it below and
 * a voice setting on the server — the route and the browser follow from this list.
 */
export const SPEECH_LANGUAGES = ["ar", "en"] as const;
export type SpeechLanguage = (typeof SPEECH_LANGUAGES)[number];

/** The most text one request may speak, counted after the markdown is taken out. */
export const MAX_SPEECH_CHARACTERS = 4000;

/** How long the server waits for the speech endpoint before giving up on one message. */
export const SPEECH_TIMEOUT_MS = 60_000;

export type SpeechVerdict =
  | { ok: true; language: SpeechLanguage; text: string }
  | { ok: false; reason: "empty" | "language" | "length" };

/**
 * Whether a message can be read aloud, and the words that would be spoken.
 *
 * The language comes from the letters themselves, never from a guess about the words: Arabic script
 * is Arabic, Latin script is English, and a single letter of any other script (Greek above all)
 * refuses the whole message. A message mixing Arabic and Latin is spoken in whichever has more
 * letters, because an Arabic answer naming an English product is still an Arabic answer.
 */
export function speechVerdict(message: string): SpeechVerdict {
  const text = speakableText(message);
  if (!text) return { ok: false, reason: "empty" };
  let arabic = 0;
  let latin = 0;
  for (const letter of text.matchAll(/\p{L}/gu)) {
    if (ARABIC.test(letter[0])) arabic += 1;
    else if (LATIN.test(letter[0])) latin += 1;
    // Any other script, Greek included, is a language this cannot speak. Refused, never sent.
    else return { ok: false, reason: "language" };
  }
  if (arabic === 0 && latin === 0) return { ok: false, reason: "empty" };
  if (text.length > MAX_SPEECH_CHARACTERS)
    return { ok: false, reason: "length" };
  return { ok: true, language: arabic >= latin ? "ar" : "en", text };
}

const ARABIC = /\p{Script=Arabic}/u;
const LATIN = /\p{Script=Latin}/u;

/**
 * The words of a markdown message, without the markup a voice would otherwise read out.
 *
 * Code blocks go entirely: nobody wants a function read to them, and their identifiers would also
 * skew the language count of an Arabic answer towards English. Links keep their words and lose their
 * address, and the punctuation markdown uses for emphasis, headings, quotes and tables is dropped.
 */
export function speakableText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/~~~[\s\S]*?(~~~|$)/g, " ")
    .replace(/<[^>\n]+>/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^\s{0,3}(#{1,6}|>+|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/[`*_~|#>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
