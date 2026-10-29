import { IconPlayerStopFilled, IconVolume } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { MessageFooter } from "@/components/ui/message";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import {
  readAloud,
  readAloudOffered,
  speechVerdict,
} from "@/lib/speech/read-aloud";
import { queryClient } from "@/query-client";

/**
 * Whatever is reading aloud right now, anywhere in the app, so starting a second message stops the
 * first rather than talking over it.
 */
let stopCurrent: (() => void) | null = null;

/**
 * "Read aloud" under one of a digital employee's messages.
 *
 * Drawn only where the server would say yes: the deployment has Read aloud on, and the message is
 * Arabic or English (see `readAloudOffered`). Anything else gets nothing at all rather than a button
 * that would only explain itself by failing. The voice is synthetic and the control says so, because
 * a person hearing a voice is entitled to know it is not somebody's.
 */
export function ReadAloud({
  channelId,
  messageId,
  text,
}: {
  channelId: string;
  messageId: string;
  text: string;
}) {
  const { data } = useQuery(deploymentCapabilitiesQueryOptions(), queryClient);
  const verdict = useMemo(() => speechVerdict(text), [text]);
  const [phase, setPhase] = useState<"idle" | "preparing" | "playing">("idle");
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef<() => void>(() => {});

  // Leaving the conversation stops the voice and abandons a request still on its way.
  useEffect(() => () => stopRef.current(), []);

  if (!readAloudOffered(data?.readAloud, verdict)) return null;
  const attribution = data?.readAloud?.attribution;

  const start = async () => {
    stopCurrent?.();
    setError(null);
    setPhase("preparing");
    const abort = new AbortController();
    let audio: HTMLAudioElement | null = null;
    let url: string | null = null;
    const stop = () => {
      abort.abort();
      audio?.pause();
      if (url) URL.revokeObjectURL(url);
      url = null;
      if (stopCurrent === stop) stopCurrent = null;
      setPhase("idle");
    };
    stopRef.current = stop;
    stopCurrent = stop;

    const result = await readAloud({ channelId, messageId }, abort.signal);
    if (abort.signal.aborted) return;
    if ("error" in result) {
      stop();
      setError(result.error);
      return;
    }
    url = URL.createObjectURL(result.audio);
    audio = new Audio(url);
    audio.addEventListener("ended", stop, { once: true });
    setPhase("playing");
    try {
      await audio.play();
    } catch {
      stop();
      setError("This browser could not play the audio.");
    }
  };

  const busy = phase !== "idle";
  const label =
    phase === "preparing"
      ? "Preparing…"
      : phase === "playing"
        ? "Stop"
        : "Read aloud";

  return (
    <MessageFooter className="gap-2">
      <button
        aria-label={busy ? "Stop reading aloud" : "Read aloud"}
        className="inline-flex items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        onClick={busy ? () => stopRef.current() : start}
        title={`Read aloud in a synthetic voice${attribution ? `. ${attribution}` : ""}`}
        type="button"
      >
        {phase === "playing" ? (
          <IconPlayerStopFilled aria-hidden="true" className="size-3.5" />
        ) : (
          <IconVolume aria-hidden="true" className="size-3.5" />
        )}
        {label}
      </button>
      {busy ? <span>Synthetic voice</span> : null}
      {error ? (
        <span className="text-destructive" role="alert">
          {error}
        </span>
      ) : null}
    </MessageFooter>
  );
}
