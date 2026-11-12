/**
 * One approval phone call, as keys pressed and lines spoken (P2 idea 10, desk #90).
 *
 * Pure: no provider, no clock, no store. The service feeds it what the phone reports and acts on
 * what it decides, so every rule a person relies on is here and tested here:
 *  - nothing is decided before the right PIN, and three wrong PINs end the call;
 *  - 1 approves, 2 declines, 3 leaves it for the app; anything else repeats the choice;
 *  - a call that ends any other way, unanswered or hung up, decides nothing: not approved.
 * The call never says the PIN, and says only the summary the server wrote for the request.
 */

export const MAX_PIN_TRIES = 3;

export type CallOutcome =
  | "approved"
  | "declined"
  | "later"
  | "pin-failed"
  | "no-answer"
  | "hung-up";

export type CallState =
  | { step: "ringing" }
  | { step: "pin"; tries: number }
  | { step: "choose" }
  | { step: "ended"; outcome: CallOutcome };

export type Spoken = { state: CallState; say: string };

const GREETING =
  "This is ArkAgent with a request that needs your approval. Enter your PIN, then press the hash key.";
const CHOICES =
  "Press 1 to approve. Press 2 to decline. Press 3 to decide later in the app.";

export function choicesFor(summary: string): string {
  return `${summary} ${CHOICES}`;
}

export function answered(): Spoken {
  return { state: { step: "pin", tries: 0 }, say: GREETING };
}

/** The phone stopped ringing without an answer, or the person hung up: nothing is decided. */
export function ended(state: CallState): Spoken {
  const outcome: CallOutcome =
    state.step === "ringing" ? "no-answer" : "hung-up";
  return {
    state: { step: "ended", outcome },
    say: "Nothing was decided. The request is still waiting in the app.",
  };
}

/**
 * The keys pressed while the call is at `state`, as one entry: a PIN ends with `#`, a choice is one
 * digit.
 */
export function pressed(
  state: CallState,
  keys: string,
  summary: string,
  pinMatches: (pin: string) => boolean,
): Spoken {
  if (state.step === "pin") {
    const pin = keys.replace(/#$/, "");
    if (/^\d{4,8}$/.test(pin) && pinMatches(pin)) {
      return { state: { step: "choose" }, say: choicesFor(summary) };
    }
    const tries = state.tries + 1;
    if (tries >= MAX_PIN_TRIES) {
      return {
        state: { step: "ended", outcome: "pin-failed" },
        say: "That PIN was not right three times, so this call is ending. Nothing was decided.",
      };
    }
    return {
      state: { step: "pin", tries },
      say: "That PIN was not right. Enter your PIN, then press the hash key.",
    };
  }
  if (state.step === "choose") {
    switch (keys.trim()) {
      case "1":
        return {
          state: { step: "ended", outcome: "approved" },
          say: "Approved. Goodbye.",
        };
      case "2":
        return {
          state: { step: "ended", outcome: "declined" },
          say: "Declined. Goodbye.",
        };
      case "3":
        return {
          state: { step: "ended", outcome: "later" },
          say: "It is waiting for you in the app. Goodbye.",
        };
      default:
        return { state, say: CHOICES };
    }
  }
  // Ringing or over: keys mean nothing.
  return { state, say: "" };
}
