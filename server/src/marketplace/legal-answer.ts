import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@ag-ui/client";
import { catchError, defer, from, Observable, of, switchMap } from "rxjs";

/**
 * The line every Legal Helper answer opens and closes with, in the language of the answer.
 *
 * A fixed template the server adds, not words the model is asked to write. DT Lab (#109, v0.1.48) found
 * the model paraphrasing it in four runs out of four, and a paraphrase of a disclaimer is not the
 * disclaimer. The English is the wording the skills have always carried; the Greek follows the Greek
 * the role page already uses for "a draft for review by a qualified lawyer".
 */
export const LEGAL_DISCLAIMER = {
  en: "Draft for review by a qualified lawyer. Not legal advice.",
  el: "Προσχέδιο για έλεγχο από αρμόδιο δικηγόρο. Δεν αποτελεί νομική συμβουλή.",
} as const;

type Language = keyof typeof LEGAL_DISCLAIMER;
type Colour = "green" | "yellow" | "red";

const OVERALL_LABEL: Record<Language, string> = {
  en: "Overall rating",
  el: "Συνολική αξιολόγηση",
};
const COLOUR_WORD: Record<Language, Record<Colour, string>> = {
  en: { green: "Green", yellow: "Yellow", red: "Red" },
  el: { green: "Πράσινο", yellow: "Κίτρινο", red: "Κόκκινο" },
};
const RANK: Record<Colour, number> = { green: 0, yellow: 1, red: 2 };

const GREEK_LETTER = /[Ͱ-Ͽἀ-῿]/g;
const LATIN_LETTER = /[A-Za-z]/g;

/** Greek when the answer is mostly Greek letters; English otherwise, as the language rule says. */
function languageOf(text: string): Language {
  const greek = text.match(GREEK_LETTER)?.length ?? 0;
  const latin = text.match(LATIN_LETTER)?.length ?? 0;
  return greek > latin ? "el" : "en";
}

const COLOUR_TEST: Record<Colour, RegExp> = {
  green: /\bgreen\b|🟢|πράσιν/iu,
  yellow: /\b(yellow|amber)\b|🟡|🟠|κίτριν|πορτοκαλ/iu,
  red: /\bred\b|🔴|κόκκιν/iu,
};

function coloursIn(text: string): Colour[] {
  return (Object.keys(COLOUR_TEST) as Colour[]).filter((colour) =>
    COLOUR_TEST[colour].test(text),
  );
}

function worst(colours: readonly Colour[]): Colour | undefined {
  return [...colours].sort((a, b) => RANK[b] - RANK[a])[0];
}

/**
 * Whether one sentence is a copy of the disclaimer, exact or paraphrased.
 *
 * Narrow on purpose: it only ever looks at the first and last sentences of an answer, and a sentence
 * that names a colour ("Red: do not sign; your lawyer reviews it in full") is a rating, never a
 * disclaimer, so it is kept.
 */
function isDisclaimer(sentence: string): boolean {
  const text = sentence.replace(/[*_`>#~]|⚠️?|ℹ️?/gu, "").trim();
  if (!text || text.length > 220) return false;
  if (coloursIn(text).length > 0) return false;
  if (/legal advice/i.test(text) || /νομικ\S*\s+συμβουλ/iu.test(text))
    return true;
  const draft = /\bdraft\b/i.test(text) || /σχέδιο/iu.test(text);
  const lawyer =
    /\b(lawyer|solicitor|attorney|counsel|advocate)s?\b/i.test(text) ||
    /δικηγόρ/iu.test(text);
  return draft && lawyer;
}

const SENTENCE = /[^.!?;]*[.!?;]+["')\]*_]*\s*|[^.!?;]+$/gu;

function isRule(line: string): boolean {
  return /^\s*([-*_]\s*){3,}$/.test(line);
}

/** One line without the disclaimer sentences at the chosen end. */
function trimSentences(line: string, end: "start" | "end"): string {
  const sentences = line.match(SENTENCE) ?? [];
  while (sentences.length > 0) {
    const edge = end === "start" ? sentences[0] : sentences.at(-1);
    if (edge === undefined || (edge.trim() && !isDisclaimer(edge))) break;
    if (end === "start") sentences.shift();
    else sentences.pop();
  }
  return sentences.join("").trim();
}

/** An answer without any copy of the disclaimer at either end, and without the rules around one. */
function withoutDisclaimers(text: string): string {
  const lines = text.split("\n");
  for (const end of ["start", "end"] as const) {
    for (;;) {
      const index = end === "start" ? 0 : lines.length - 1;
      const line = lines[index];
      if (line === undefined) break;
      if (!line.trim() || isRule(line)) {
        lines.splice(index, 1);
        continue;
      }
      const kept = trimSentences(line, end);
      if (kept === line.trim()) break;
      if (kept) {
        lines[index] = kept;
        break;
      }
      lines.splice(index, 1);
    }
  }
  return lines.join("\n").trim();
}

/** A clause's name that says it bans hiring or soliciting staff, which belongs in no NDA. */
const NO_HIRE =
  /non[-\s]?solicit|no[-\s]?hire|no[-\s]?poach|\bhir(e|ing)\b|recruit|πρόσληψ|προσέλκυσ|απόσπασ|απασχόλησ|(?<!\p{L})άγρα/iu;
/** Staff, in a clause's text: hiring someone else's staff is the clause, hiring in general may not be. */
const STAFF = /employee|staff|personnel|worker|εργαζόμεν|προσωπικ|υπάλληλ/iu;
/** What a row says when the clause is not there at all. */
const ABSENT =
  /\b(none|not present|absent|no such|not included|not found|n\/a)\b|δεν υπάρχει|δεν περιλαμβάν|δεν προβλέπ|καμία|κανένα/iu;
const COLOUR_ONLY =
  /green|yellow|amber|red|πράσιν\S*|κίτριν\S*|κόκκιν\S*|πορτοκαλ\S*|🟢|🟡|🟠|🔴|\bor\b|και|ή|[\s*_/\\\-–—,:.()+&]/giu;
const OVERALL =
  /^[^\p{L}]*(overall(\s+rating)?|συνολικ\S*(\s+αξιολόγηση)?|τελικ\S*\s+αξιολόγηση)[^.;\n]*[.;]?\s*/iu;
/** A line that starts a clause's part of a triage written as a list or under headings. */
const SECTION_START =
  /^\s*(#{1,6}\s|\d+[.)]\s|[-*+]\s|\*\*|(clause|άρθρο|όρος)\s*\d)/iu;

function isColourCell(cell: string): boolean {
  return (
    coloursIn(cell).length > 0 && cell.replace(COLOUR_ONLY, "").length === 0
  );
}

/** Whether a clause, from its name and its text, bans hiring or soliciting the other side's staff. */
function isNoHire(name: string, text = ""): boolean {
  if (NO_HIRE.test(name)) return true;
  return NO_HIRE.test(text) && STAFF.test(text);
}

/** One line with every colour in it made Red, in the words the line used. */
function madeRed(line: string, language: Language): string {
  return line
    .replace(/🟢|🟡|🟠/gu, "🔴")
    .replace(/\b(green|yellow|amber)\b/giu, COLOUR_WORD.en.red)
    .replace(/(πράσιν|κίτριν|πορτοκαλ)\p{L}*/giu, COLOUR_WORD.el.red)
    .replace(
      new RegExp(`(${COLOUR_WORD[language].red})(\\s*[/,]\\s*\\1)+`, "gu"),
      "$1",
    );
}

/**
 * An NDA triage with its rating made definite: a no-hire or non-solicit clause is Red wherever it is
 * rated, and the answer ends with exactly one overall rating, the worst colour in it.
 *
 * Code rather than only a stronger skill, because DT Lab saw both a no-hire clause rated Yellow and a
 * triage with no overall rating, and the skill already said what the right answer was. v0.1.49 forced
 * only a table row whose first cell named the clause; DT Lab (#109, 19 Nov) still saw Yellow for a 3-year
 * no-hire in English and a 2-year non-solicit in Greek. So the clause is found by its name in any cell
 * before the colour, or by its text (hiring plus staff) anywhere in the row, and in a triage written as a
 * list or under headings, by the line or the heading the colour sits under. An answer with no colour in
 * it is not a triage yet (it may be asking for the document) and is left as it is.
 */
function rated(text: string, language: Language): string {
  const found: Colour[] = [];
  const lines: string[] = [];
  let section = "";
  for (const line of text.split("\n")) {
    if (line.trim().startsWith("|")) {
      section = "";
      const cells = line
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|");
      const at = cells.findIndex((cell) => isColourCell(cell));
      const cell = cells[at];
      if (cell !== undefined) {
        let colour = worst(coloursIn(cell)) as Colour;
        const says = cells[at + 1] ?? "";
        const name = cells.slice(0, at).join(" ");
        const rest = cells.slice(at + 1).join(" ");
        if (colour !== "red" && isNoHire(name, rest) && !ABSENT.test(says)) {
          colour = "red";
          cells[at] = COLOUR_WORD[language].red;
          found.push(colour);
          lines.push(`| ${cells.map((c) => c.trim()).join(" | ")} |`);
          continue;
        }
        found.push(colour);
      }
      lines.push(line);
      continue;
    }
    const overall = line.match(OVERALL);
    if (overall && coloursIn(line).length > 0) {
      found.push(...coloursIn(overall[0]));
      const rest = line.slice(overall[0].length).trim();
      if (rest) lines.push(rest);
      continue;
    }
    if (SECTION_START.test(line)) section = line;
    const colours = coloursIn(line);
    if (
      colours.length > 0 &&
      !colours.every((colour) => colour === "red") &&
      (isNoHire(line, line) || (section !== line && isNoHire(section))) &&
      !ABSENT.test(line)
    ) {
      found.push("red");
      lines.push(madeRed(line, language));
      continue;
    }
    lines.push(line);
  }
  const overall = worst(found);
  if (!overall) return text;
  return `${lines.join("\n").trim()}\n\n**${OVERALL_LABEL[language]}: ${COLOUR_WORD[language][overall]}**`;
}

const TRIAGE_REQUEST =
  /legal-nda-triage|\bNDAs?\b|non-?disclosure|confidentiality agreement|εμπιστευτικότητ/iu;

function lastUserText(input: RunAgentInput): string {
  const message = [...input.messages]
    .reverse()
    .find((candidate) => candidate.role === "user");
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((part) =>
        typeof part === "object" && part && "text" in part
          ? String((part as { text: unknown }).text)
          : "",
      )
      .join(" ");
  return "";
}

type Said = { messageId: string; role: string; text: string };

/**
 * Reshapes one run's events so the answer opens and closes with the disclaimer.
 *
 * Each assistant message is held until it ends and is then sent whole, because the opening line must
 * replace whatever the model put first and the closing line must go on the last message of the run,
 * which is only known when the next event arrives. Tool calls and everything else pass through in
 * their order; a message that ended is sent before the event that follows it.
 */
class Shaper {
  private language: Language | undefined;
  private opened = false;
  private open: Said | undefined;
  private ended: Said | undefined;

  constructor(private readonly triage: boolean) {}

  feed(event: BaseEvent): BaseEvent[] {
    const e = event as BaseEvent & {
      messageId?: string;
      role?: string;
      delta?: string;
    };
    if (event.type === EventType.TEXT_MESSAGE_START) {
      if (e.role && e.role !== "assistant") return [event];
      this.open = {
        messageId: e.messageId ?? "",
        role: e.role ?? "assistant",
        text: "",
      };
      return [];
    }
    if (
      event.type === EventType.TEXT_MESSAGE_CONTENT &&
      this.open &&
      this.open.messageId === e.messageId
    ) {
      this.open.text += e.delta ?? "";
      return [];
    }
    if (
      event.type === EventType.TEXT_MESSAGE_END &&
      this.open &&
      this.open.messageId === e.messageId
    ) {
      const out = this.release(false);
      this.ended = this.open;
      this.open = undefined;
      return out;
    }
    if (
      event.type === EventType.RUN_FINISHED ||
      event.type === EventType.RUN_ERROR
    ) {
      return [...this.finish(), event];
    }
    return [...this.release(false), event];
  }

  /** What is still held, sent as the last of the run, with the closing line. */
  finish(): BaseEvent[] {
    if (this.open) {
      // A message that never ended is ended here, so it is not lost.
      const out = this.release(false);
      this.ended = this.open;
      this.open = undefined;
      return [...out, ...this.finish()];
    }
    if (this.ended) return this.release(true);
    if (!this.opened) return [];
    this.opened = false;
    return this.message(
      `legal-closing-${crypto.randomUUID()}`,
      "assistant",
      LEGAL_DISCLAIMER[this.language ?? "en"],
    );
  }

  private release(last: boolean): BaseEvent[] {
    const said = this.ended;
    if (!said) return [];
    this.ended = undefined;
    let body = withoutDisclaimers(said.text);
    this.language ??= languageOf(body || said.text);
    const language = this.language;
    if (this.triage) body = rated(body, language);
    const parts: string[] = [];
    if (!this.opened) {
      parts.push(LEGAL_DISCLAIMER[language]);
      this.opened = true;
    }
    if (body) parts.push(body);
    if (last && (body || parts.length === 0))
      parts.push(LEGAL_DISCLAIMER[language]);
    if (parts.length === 0) return [];
    // After `finish`, nothing more is closed: a later stray event cannot add a second closing line.
    if (last) this.opened = false;
    return this.message(said.messageId, said.role, parts.join("\n\n"));
  }

  private message(messageId: string, role: string, text: string): BaseEvent[] {
    return [
      { type: EventType.TEXT_MESSAGE_START, messageId, role } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta: text,
      } as BaseEvent,
      { type: EventType.TEXT_MESSAGE_END, messageId } as BaseEvent,
    ];
  }
}

/** The events of one run, reshaped for a Legal Helper. Exported for the agent below and its tests. */
export function shapeLegalRun(
  events: Observable<BaseEvent>,
  input: RunAgentInput,
): Observable<BaseEvent> {
  return new Observable<BaseEvent>((subscriber) => {
    const shaper = new Shaper(TRIAGE_REQUEST.test(lastUserText(input)));
    const subscription = events.subscribe({
      next: (event) => {
        for (const out of shaper.feed(event)) subscriber.next(out);
      },
      error: (error) => {
        for (const out of shaper.finish()) subscriber.next(out);
        subscriber.error(error);
      },
      complete: () => {
        for (const out of shaper.finish()) subscriber.next(out);
        subscriber.complete();
      },
    });
    return () => subscription.unsubscribe();
  });
}

/**
 * Stands in front of a digital employee and, when it is a Legal Helper, gives every answer the fixed
 * disclaimer at both ends and a definite NDA rating. Any other employee is passed through untouched.
 *
 * `isLegalHelper` is asked once per run. When it cannot answer, the answer is shaped anyway: a disclaimer
 * on an answer that did not need one costs a line, and a Legal Helper answer without one is the failure
 * this exists to prevent.
 */
export class LegalHelperAgent extends AbstractAgent {
  private inner: AbstractAgent;
  private isLegalHelper: () => Promise<boolean>;

  constructor(inner: AbstractAgent, isLegalHelper: () => Promise<boolean>) {
    super({ agentId: inner.agentId, description: inner.description });
    this.inner = inner;
    this.isLegalHelper = isLegalHelper;
  }

  getCapabilities() {
    return this.inner.getCapabilities?.() ?? Promise.resolve({});
  }

  clone(): LegalHelperAgent {
    const cloned = super.clone() as LegalHelperAgent;
    // The base clone copies only its own fields; the runtime clones before every run.
    cloned.inner = this.inner.clone();
    cloned.isLegalHelper = this.isLegalHelper;
    return cloned;
  }

  abortRun(): void {
    this.inner.abortRun();
    super.abortRun();
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return defer(() =>
      from(this.isLegalHelper()).pipe(catchError(() => of(true))),
    ).pipe(
      switchMap((legal) =>
        legal
          ? shapeLegalRun(this.inner.run(input), input)
          : this.inner.run(input),
      ),
    );
  }
}
