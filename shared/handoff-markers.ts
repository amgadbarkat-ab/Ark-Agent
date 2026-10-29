/**
 * The first words of the sentences a server-side handoff tool answers with.
 *
 * ONE DECLARATION, READ FROM BOTH SIDES. A tool that runs on the server reaches the transcript as
 * text meant for a model, so the only thing the renderer can tell an accepted hop from a refused one
 * by is the wording. That is not a contract to be proud of, and the least it can be is a contract
 * with one author: a rewording here changes the server and the transcript together.
 *
 * It lived in three places once — the server, the renderer, and a test — under a comment claiming it
 * was shared. It was not, and the bug that produced is the one both renderers' comments recount:
 * every accepted hop drawn as Blocked, with the whole suite green.
 */

/** How `message_bot` starts its answer when a hop was accepted. */
export const HANDED_OVER = "Handed to ";

/** How `ask_person` starts its answer when the question was routed. */
export const PUT_TO = "Put to ";

/**
 * How a colleague's answer opens when it is written, as it was said, into the conversation that
 * asked for it.
 *
 * The colleague runs in a conversation of its own that nobody is shown, so its words reach the
 * person only through the employee that asked. That employee was the only place they went, and a
 * small model told to pass them on summarised three risks into "it got back to me" (DT Lab, v0.1.19,
 * step 1). Written into the transcript under this opening, the answer is there word for word
 * whatever the relaying model makes of it, and the browser draws it as the colleague's rather than
 * as something the person typed, which is the role it is stored under.
 */
const COLLEAGUE_ANSWER = "Passed on word for word, the answer from ";

/** The colleague's answer, framed for the transcript. Its name is kept to one line so it reads back. */
export function frameColleagueAnswer(name: string, answer: string): string {
  return `${COLLEAGUE_ANSWER}${name.replace(/\s+/g, " ").trim()}:\n\n${answer}`;
}

/** Who answered and what they said, or null when the text is not a framed answer. */
export function readColleagueAnswer(
  text: string,
): { name: string; answer: string } | null {
  if (!text.startsWith(COLLEAGUE_ANSWER)) return null;
  const end = text.indexOf(":\n\n", COLLEAGUE_ANSWER.length);
  if (end < 0) return null;
  const name = text.slice(COLLEAGUE_ANSWER.length, end);
  if (!name || name.includes("\n")) return null;
  return { name, answer: text.slice(end + 3) };
}
