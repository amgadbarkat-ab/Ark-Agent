/**
 * A person's conversations, which live in the conversation service (Ark Hub) and not in this
 * database, so reading or removing them is a call to it.
 *
 * Only what the privacy features need: every thread a person has, its messages, and removing one. The
 * hub's own API is the contract (hub/src/rest.ts): a bearer key, and every call scoped to a user id,
 * so a person's conversations are only ever reached under their own id.
 */
export type ConversationThread = { id: string } & Record<string, unknown>;

export type ConversationService = {
  /** Every thread this person has, archived ones included. */
  threads: (userId: string) => Promise<ConversationThread[]>;
  messages: (threadId: string, userId: string) => Promise<unknown[]>;
  /** Removes a thread and everything in it. Removing one that is already gone is not an error. */
  remove: (threadId: string, userId: string) => Promise<void>;
};

export class ConversationServiceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConversationServiceError";
  }
}

const PAGE = 100;
/** A ceiling on one person's threads, so a loop that never ends cannot hold a request for ever. */
const MAX_THREADS = 20_000;
const TIMEOUT_MS = 30_000;

export function hubConversations(options: {
  apiUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): ConversationService {
  const base = options.apiUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;

  async function call(
    method: "GET" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new ConversationServiceError(
        "The conversation service could not be reached.",
        { cause: error },
      );
    }
    return response;
  }

  return {
    async threads(userId) {
      const found: ConversationThread[] = [];
      let cursor: string | undefined;
      do {
        const query = new URLSearchParams({
          userId,
          includeArchived: "true",
          limit: String(PAGE),
        });
        if (cursor) query.set("cursor", cursor);
        const response = await call("GET", `/api/threads?${query}`);
        if (!response.ok) {
          throw new ConversationServiceError(
            `The conversation service refused to list conversations (${response.status}).`,
          );
        }
        const page = (await response.json()) as {
          threads?: ConversationThread[];
          nextCursor?: string | null;
        };
        found.push(...(page.threads ?? []));
        cursor = page.nextCursor ?? undefined;
        if (found.length > MAX_THREADS) {
          throw new ConversationServiceError(
            "This person has more conversations than can be handled in one go.",
          );
        }
      } while (cursor);
      return found;
    },

    async messages(threadId, userId) {
      const response = await call(
        "GET",
        `/api/threads/${encodeURIComponent(threadId)}/messages?userId=${encodeURIComponent(userId)}`,
      );
      if (response.status === 404) return [];
      if (!response.ok) {
        throw new ConversationServiceError(
          `The conversation service refused to read a conversation (${response.status}).`,
        );
      }
      return (
        ((await response.json()) as { messages?: unknown[] }).messages ?? []
      );
    },

    async remove(threadId, userId) {
      const response = await call(
        "DELETE",
        `/api/threads/${encodeURIComponent(threadId)}`,
        { userId },
      );
      // Already gone is the outcome wanted.
      if (response.status === 404 || response.ok) return;
      throw new ConversationServiceError(
        `The conversation service refused to remove a conversation (${response.status}).`,
      );
    },
  };
}
