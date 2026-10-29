import { tryClient } from "@/lib/client";
import type { DeploymentCapabilities } from "@/lib/deployment/queries";
import { type SpeechVerdict, speechVerdict } from "../../../../shared/speech";

export { speechVerdict };

/**
 * Whether to offer Read aloud on one of a digital employee's messages.
 *
 * The same verdict the server reaches on the text it loads (shared/speech.ts), so the control is only
 * drawn where pressing it can succeed: the deployment has it on, the message is Arabic or English and
 * short enough, and there is a voice for that language. Greek, and every other script, is never
 * offered; the server refuses it anyway.
 */
export function readAloudOffered(
  readAloud: DeploymentCapabilities["readAloud"],
  verdict: SpeechVerdict,
): boolean {
  return Boolean(
    readAloud && verdict.ok && readAloud.languages.includes(verdict.language),
  );
}

/**
 * The audio for one message, or the sentence saying why there is none.
 *
 * Not a query and not a mutation: it is a moment's request, played once and thrown away, so a cache
 * key would be a key nothing reads. It names the message rather than sending its words, because the
 * server loads the text itself from a conversation the person is in.
 */
export async function readAloud(
  input: { channelId: string; messageId: string },
  signal?: AbortSignal,
): Promise<{ audio: Blob } | { error: string }> {
  const unavailable = "This message could not be read aloud. Please retry.";
  try {
    const response = await tryClient("/api/speech", {
      method: "POST",
      body: input,
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: unknown;
      } | null;
      return {
        error: typeof body?.error === "string" ? body.error : unavailable,
      };
    }
    const audio = await response.blob();
    return audio.size ? { audio } : { error: unavailable };
  } catch {
    return { error: unavailable };
  }
}
