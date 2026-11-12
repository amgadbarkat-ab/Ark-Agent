/**
 * Who places an approval call (P2 idea 10).
 *
 * A real provider (Twilio, Plivo) needs Amgad's separate yes, a key and a spend cap; the spec with
 * prices is on desk #90. Until then the only provider is the simulated one, which rings inside the
 * app: the person sees the call, hears nothing, reads each line and presses keys on screen. The
 * call steps, the PIN, the rules and the audit are the same either way, which is the point of the
 * seam.
 */
export type PhoneProvider = {
  readonly name: string;
  /** Ring `to`. What is said and what is pressed come back through the service. */
  place(call: { id: string; userId: string; to: string }): Promise<void>;
};

/** Rings in the app. Holds nothing but which calls it was asked to place. */
export function simulatedPhoneProvider(): PhoneProvider & {
  placed: { id: string; userId: string; to: string }[];
} {
  const placed: { id: string; userId: string; to: string }[] = [];
  return {
    name: "simulated",
    placed,
    async place(call) {
      placed.push(call);
    },
  };
}
