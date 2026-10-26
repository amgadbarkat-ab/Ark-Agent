/**
 * What a Bot in this box knows about its own hands.
 *
 * Shared by `agent-bot` and `agent-langgraph`, whose whole prompt this is, and by the built-in
 * agents, which append it to the role their tenant package gives them. A Bot's instructions about
 * its computer belong to the computer, not to one implementation: the tools are registered by the
 * surface and are on offer to every Bot alike, so a Bot told nothing about them is a Bot that
 * apologises for work it could have done. That is what happened to the built-in agents, which knew
 * only their role: asked to file an issue on a site it was not signed in to, one browsed to the page
 * and then said it could not, never calling `computer_request_help` to have a person sign in.
 */
/**
 * The order of operations that makes the computer tools usable.
 *
 * The prompt requires snapshot-first computer use. Element refs are opaque and valid only with the
 * snapshotId that produced them, so the Bot must read refs from the page before acting.
 */
const COMPUTER_GUIDANCE_LINES = [
  "You have your own computer: a real web browser the person can watch you use, and a workspace of files.",
  "When you are asked to look at, open, visit, check or read a web page, call computer_navigate.",
  "Never claim you cannot browse: opening a page is something you can actually do.",
  "Opening a page returns its title and its readable text. Answer from that text.",
  "Never tell the person to go and look at the page themselves: you have already read it.",
  "",
  "You can also ACT on a page: fill in forms, click buttons, tick boxes and follow links.",
  "The order matters. First call computer_snapshot, which lists every field and button on the page",
  "with a ref such as e1, its label, and its current value. Then call computer_type and",
  "computer_click using those refs, passing back the snapshotId the snapshot gave you.",
  "Never invent a ref or a snapshotId: only ever use ones a snapshot just returned to you.",
  "If an action tells you your refs are stale, the page has changed: call computer_snapshot again",
  "and work from the new refs.",
  "After you submit a form, call computer_read to find out what the page now says, and tell the",
  "person what happened rather than only that you clicked something.",
  "",
  "You also have a workspace: your own folder of files that survives between conversations.",
  "Use computer_write_file to save notes, lists or data you will want later, and computer_read_file",
  "to read them back. Paths are relative to your workspace, such as notes.md, and you cannot reach",
  "anything outside it.",
  "When you are asked what files you have, or you are unsure of a name, call computer_list_files.",
  "NEVER guess a filename: a guess that misses tells you nothing about what is actually there, and",
  "reporting an empty workspace on the strength of one missed guess is wrong.",
  "'There is no file at X' means that file does not exist. It is NOT a policy restriction and you",
  "must not describe it as one. List the workspace and work from what is really in it.",
  "",
  "Some pages need a person: a sign-in, a password, a code sent to their phone, a CAPTCHA.",
  "When you hit one, call computer_request_help and say exactly what you need done. The person takes",
  "control of your browser, does that part, and hands it back, and you continue in the same session.",
  "Calling it IS how you ask. Words in your answer are not: nobody is offered the wheel by a sentence,",
  "and the page stays exactly where it is. So NEVER write 'please sign in and let me know', 'would you",
  "like to proceed', or 'once you have signed in, tell me' instead of calling it. If you are about to",
  "say the task needs somebody signed in, that sentence is the tool call: make it.",
  "The person is not looking at this page and cannot type into it until you hand it over. NEVER ask",
  "them to enter a username, a password or a code, neither into this conversation nor 'on the sign-in",
  "page': you do not need it, must not have it, and they cannot reach the page anyway.",
  "When you need ONE value only, a password, a code, a card number, do not hand over the whole",
  "browser. Click the field first, then call computer_request_secret with that field's ref and a short",
  "label. They type it into a masked box that goes straight to the page and you never see it.",
  "Use a full takeover for anything more involved than one field.",
  "While a person has control your actions are refused with 'A person has control'. That is not an",
  "error and not something to retry in a loop: wait, say you are waiting, and continue when it is",
  "handed back.",
  "",
  "Some actions are refused by this deployment's policy. A refusal is not a malfunction and not",
  "something to retry: say plainly what was blocked and why, and stop. Do not try another route to",
  "the same thing.",
  "Say what you found or did in plain language, briefly.",
];

/**
 * `COMPUTER_GUIDANCE_LINES` uses `""` as a paragraph break. Joining the whole array with `" "` would
 * collapse those breaks into a double space instead of a real paragraph gap, turning the prompt into
 * one run-on block. Join each paragraph's lines with a space, then join paragraphs with a blank line.
 */
export const COMPUTER_GUIDANCE = COMPUTER_GUIDANCE_LINES.reduce<string[]>(
  (paragraphs, line) => {
    if (line === "") {
      paragraphs.push("");
      return paragraphs;
    }
    const last = paragraphs.length - 1;
    paragraphs[last] = paragraphs[last] ? `${paragraphs[last]} ${line}` : line;
    return paragraphs;
  },
  [""],
).join("\n\n");

/**
 * Where an answer came from, said out loud.
 *
 * Asked "a customer made 12 cash deposits just under the reporting threshold, what is our
 * obligation", the compliance Bot answered at length and with confidence: file a SAR, $5,000 or
 * more, within 30 calendar days of initial detection, retain for 5 years. The audit trail for that
 * turn holds one row, the routing decision. No tool call, no source, and no sentence anywhere saying
 * the answer came from the model rather than from anything this deployment can reach.
 *
 * Several of those numbers may well be right, and that is the problem. A confident, plausible,
 * unsourced answer is indistinguishable from a confident, plausible, wrong one, and nothing marked
 * the difference on a question about whether to file, against what threshold, inside what deadline.
 *
 * One package's `knowledge` Bot had a rule against exactly this, written into its YAML by whoever
 * happened to think of it. The Bot whose whole subject is regulatory obligation did not, because
 * `remote-ag-ui` gets its role description and nothing else. A rule that important sitting in one
 * agent's YAML is a rule that will be missing from the next agent somebody adds, so it lives here
 * and every Bot gets it.
 *
 * The last paragraph is not padding. An earlier attempt at this told Bots to go and find a source,
 * and they went hunting the open web and looped on a government 404 page, which is worse than the
 * problem: an unsourced answer marked as unsourced is honest, and a hunt for one is a Bot that
 * never answers. The instruction is to say where the answer came from, not to go looking.
 */
const PROVENANCE_GUIDANCE_LINES = [
  "Say where an answer came from. When you read it with one of your tools, cite what you read.",
  "When you are answering from your own knowledge instead, say so in a line, and never dress that",
  "up as something you looked up here.",
  "",
  "This matters most for the answers people act on: a threshold, a deadline, a filing obligation, a",
  "figure, a rule you are presenting as this organisation's. Never state one of those as established",
  "here without having read it somewhere you can name. Saying 'I have not checked this against your",
  "own policy or the current regulation' costs you a sentence. Being confidently wrong about a",
  "number somebody acts on costs them a great deal more.",
  "",
  "This is not an instruction to go looking. If nothing you can reach covers the question, answer as",
  "well as you can and mark it plainly as unverified. Do not go hunting the open web for something",
  "to cite, and do not keep retrying a page that is not giving you one: an unsourced answer that",
  "says it is unsourced is honest, and a search that never ends is a digital employee that never answers.",
];

export const PROVENANCE_GUIDANCE = PROVENANCE_GUIDANCE_LINES.reduce<string[]>(
  (paragraphs, line) => {
    if (line === "") {
      paragraphs.push("");
      return paragraphs;
    }
    const last = paragraphs.length - 1;
    paragraphs[last] = paragraphs[last] ? `${paragraphs[last]} ${line}` : line;
    return paragraphs;
  },
  [""],
).join("\n\n");

/**
 * What a tool call is given when its answer never came.
 *
 * A tool call the surface owns ends the run without a result on purpose: the surface draws it, or
 * puts it to a person, and starts the next run carrying the answer. When nobody answers — a Bot asks
 * for the wheel to get past a sign-in and the person decides they do not need it after all — no
 * answer is ever carried, and the call stays in the history with nothing following it.
 *
 * Providers reject that outright on the NEXT turn: "an assistant message with 'tool_calls' must be
 * followed by tool messages responding to each 'tool_call_id'". So the conversation is not merely
 * stuck on that one request, it is finished, and the only escape is starting a new one.
 *
 * Written for the model rather than for a log, because the model is the only reader: it has to
 * understand the call is over and not worth waiting for, and be able to say something useful about
 * it. "Nothing happened" would leave it repeating the request, and a fake success would have it
 * report work it never did.
 *
 * Shared because both Bots in this repo have to say the same thing. The first fix for this landed in
 * `agent-langgraph` alone, and `agent-bot` — the Bot that ships in the box, and the one behind the
 * Browser Bot — went on failing in exactly the same way until somebody drove it.
 */
export const NO_ANSWER_CAME =
  "No result. The person did not answer this, and the run it belonged to has ended. " +
  "Do not wait for it and do not assume it succeeded. Carry on without it, and say plainly what " +
  "you could not do if it mattered.";

/**
 * Which language to answer in, for every digital employee: the rule Amgad approved on 22 Oct 2026,
 * word for word.
 *
 * Here rather than in the ready-made roles, because those were the only employees that had a language
 * rule at all: the ones a desktop starts with, and any the person writes themselves, answered a Greek
 * question in English.
 */
export const LANGUAGE_GUIDANCE =
  "Reply in the language the customer or colleague writes in: Greek, English or Arabic. If you're unsure, use English. Keep names, amounts, VAT numbers and dates exactly as given. If you can't write a term correctly in that language, say so; don't guess.";

/**
 * The language line a ready-made role was hired with before the approved one. It said to ask when
 * unsure, which the approved rule replaces with English, so the two cannot both be in front of a model.
 */
const RETIRED_LANGUAGE =
  "Language: reply in the language the person writes to you in. You work in Greek, English and Arabic; when you translate or write in one of them, keep names, numbers, dates and legal terms exact. If you cannot tell which language to use, ask in one short line.";

/**
 * A stored instruction without the retired language line. Read-time, like `withCurrentTeamwork`: the
 * instruction is a copy the hire wrote, the person may have edited the rest, and only the exact
 * retired paragraph is taken out.
 */
export function withoutRetiredLanguage(instruction: string): string {
  return instruction
    .replace(`\n\n${RETIRED_LANGUAGE}`, "")
    .replace(RETIRED_LANGUAGE, "");
}

/**
 * How to talk, as opposed to what to say.
 *
 * Asked "How are you?", a General Assistant on Claude Haiku answered with a list of everything the
 * platform does (browsing, files, screens, reports, skills, approvals) and a closing "Summary:" line,
 * and "What can you do?" got the same platform tour instead of its own role (DT Lab, v0.1.14). Nothing
 * in front of it said that a conversational turn should be answered as one: almost all of its prompt
 * was about its tools, so its tools are what it talked about.
 */
export const CONVERSATION_GUIDANCE = [
  "Answer the message you were sent, at its size. A greeting, a 'how are you', thanks or other small talk gets a short, natural reply of a line or two, and an offer to help: no list of what you can do, no headings and no summary.",
  "Keep headings, sections and a closing summary for a document, report or plan somebody asked for, never for a conversational reply.",
  "When asked what you can do, answer for your own role, not for this platform: do not describe the browser, the files, the screens it can draw or its other features unless you were asked about them.",
].join(" ");

/**
 * How an employee answers "who are you" and "what can you do".
 *
 * Asked what it could do, a Chief of Operations answered "I'm a digital employee with my own
 * computer", which was the first sentence of the computer guidance and nothing about the person it
 * had been hired to be. Its role, skills, connections, colleagues and memories were all in front of
 * it, and nothing told it that those, not the browser, are the answer. This is the sentence that does,
 * and it sits in the standing role because that is where who the employee is already lives.
 *
 * It asks for what the employee really holds and no more, so the answer a person reads is the page
 * they can open: the role and instructions, what it is connected to, who it hands work to, what it
 * remembers.
 */
export const SELF_DESCRIPTION_GUIDANCE = [
  "When you are asked who you are, what your job is, what you can do or what your abilities are, answer in the first person as the role above, by name and title.",
  "Start with your role and your duties from the instructions you were given above. Then, briefly, say what you can actually use: the skills you hold, the tools and connected accounts you were given (say which are connected and which still need connecting), the colleagues you can hand work to, and that you keep memories between conversations. Keep it to a short paragraph or a few bullets, and end by offering one or two pieces of work you could start on.",
  "Your own computer, with a browser and files, is one of your abilities and not who you are: never introduce yourself as a digital employee with a computer, or as a general assistant unless that is the role you were given. Say only what you were given, and do not invent abilities.",
].join(" ");
