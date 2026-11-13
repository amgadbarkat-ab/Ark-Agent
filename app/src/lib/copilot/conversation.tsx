import { createContext, type ReactNode, useContext, useMemo } from "react";

/**
 * Lets transcript-rendered components add a user turn back into the containing conversation.
 */

type Conversation = {
  /** Submit a user turn from a transcript-rendered component. */
  ask: (text: string) => void;
  /**
   * Whether a turn is in flight. A card still being written while nothing is running never will be
   * (DT Lab, #83: a card from an interrupted run sat on "Preparing the request…" for good).
   */
  busy?: boolean;
  /**
   * Called by a card while it waits for the person, released when it stops waiting. While any card
   * waits there is nothing for Stop to stop: the person answers the card (DT Lab, #83).
   */
  holdForCard?: () => () => void;
};

const ConversationContext = createContext<Conversation | null>(null);

export function ConversationProvider({
  ask,
  busy,
  holdForCard,
  children,
}: {
  ask: (text: string) => void;
  busy?: boolean;
  holdForCard?: () => () => void;
  children: ReactNode;
}) {
  // Keep context identity stable across unrelated composer renders.
  const value = useMemo(
    () => ({ ask, busy, holdForCard }),
    [ask, busy, holdForCard],
  );
  return (
    <ConversationContext.Provider value={value}>
      {children}
    </ConversationContext.Provider>
  );
}

/** The conversation this component is drawn in, if it is drawn in one. */
export function useConversation(): Conversation | null {
  return useContext(ConversationContext);
}
