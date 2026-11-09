/**
 * A digital employee's answer, tidied for the screen before it is drawn as markdown (desk #73).
 *
 * Two things models get wrong in Greek that English answers rarely show:
 *
 * 1. BULLETS AS GLYPHS. A model answering in Greek often writes its list items as `• item` or
 *    `– item` rather than markdown's `- item`. Markdown reads those lines as one paragraph, so a
 *    «Τι λείπει» list came out as a single run of text (DT Lab, Wine24, v0.1.23). Lines that start
 *    with a bullet glyph become markdown list items, and so does a line that strings several `•`
 *    items together.
 * 2. A CAPITAL INSIDE A WORD. «επιβεβαιΩθεί»: a capital Greek letter between two lowercase Greek
 *    letters, which Greek spelling never has, and which a small model sometimes writes. It is made
 *    lowercase. A word in capitals («ΑΦΜ») and a capital that starts a word are left alone.
 *
 * Code is never touched: inside a fenced block or inline code, the text is shown as written.
 * Display only: what the person copies or what is stored is the model's own text.
 */

const GREEK_LOWER = "α-ωάέήίόύώϊϋΐΰς";
const GREEK_UPPER = "Α-ΩΆΈΉΊΌΎΏΪΫ";

/** A capital Greek letter with a lowercase Greek letter on each side. */
const CAPITAL_INSIDE_WORD = new RegExp(
  `(?<=[${GREEK_LOWER}])[${GREEK_UPPER}](?=[${GREEK_LOWER}])`,
  "gu",
);

/** A line that starts with a bullet glyph and a space: `• item`, `– item`, `▪ item`. */
const GLYPH_BULLET_LINE = /^(\s*)[•◦▪▫‣⁃●○–—]\s+(?=\S)/u;

/** `•` between items on one line, with the spaces around it. */
const INLINE_BULLET = /\s+•\s+/u;

function tidyProse(line: string): string {
  // Inline code keeps its text: split on backtick runs and only tidy the parts outside them.
  return line
    .split(/(`+[^`]*`+)/u)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part.replace(CAPITAL_INSIDE_WORD, (letter) =>
            letter.toLocaleLowerCase("el"),
          ),
    )
    .join("");
}

function tidyBullets(line: string): string[] {
  // A table row keeps its cells as written, `•` and all.
  if (/^\s*\|/u.test(line)) return [line];
  // "Τι λείπει: • διεύθυνση • ημερομηνία • πληρωμή", or "• διεύθυνση • ημερομηνία": several `•`
  // items strung along one line.
  const parts = line.split(INLINE_BULLET);
  const head = parts[0]?.trim() ?? "";
  const startsWithBullet = /^•\s/u.test(head);
  if (parts.length >= 3 || (startsWithBullet && parts.length >= 2)) {
    const items = parts.slice(1);
    const start = startsWithBullet ? head.replace(/^•\s*/u, "") : null;
    const list = [...(start === null ? [] : [start]), ...items].map(
      (item) => `- ${item.trim()}`,
    );
    // A blank line between a lead-in and its list, so the list is never read as part of it.
    return start === null && head ? [head, "", ...list] : list;
  }

  const glyph = GLYPH_BULLET_LINE.exec(line);
  if (glyph) return [`${glyph[1]}- ${line.slice(glyph[0].length)}`];
  return [line];
}

export function tidyAnswer(text: string): string {
  if (!text) return text;
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1];
    if (fence) {
      out.push(line);
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (marker) {
      fence = marker;
      out.push(line);
      continue;
    }
    out.push(...tidyBullets(tidyProse(line)));
  }
  return out.join("\n");
}
