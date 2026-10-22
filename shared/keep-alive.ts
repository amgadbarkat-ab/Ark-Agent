/**
 * A line a stream sends so nobody on the way mistakes a slow answer for a dead one.
 *
 * A model on this computer can spend minutes reading a prompt before it writes a word, and the run
 * is silent for all of it. Between the person and that model sit a server, a bot, and the timers of
 * each: Bun closes a connection that has said nothing for its idle time, and the next fetch up the
 * chain reports "The socket connection was closed unexpectedly" in place of an answer. That is what
 * the first message after installing did on a laptop, after five or six minutes.
 *
 * A server-sent-events comment (a line that starts with a colon) is ignored by every reader of the
 * format, the AG-UI client included, so sending one carries no event and changes nothing the person
 * sees. It only keeps the connection from looking idle.
 */
export const KEEP_ALIVE_FRAME = ": keep-alive\n\n";

/** Well inside every idle limit on the way (the shortest is Bun's default of ten seconds). */
export const KEEP_ALIVE_EVERY_MS = 8_000;

/**
 * Send {@link KEEP_ALIVE_FRAME} every so often until the returned function is called.
 *
 * `send` may throw once the stream is closed or the person has gone away; that ends the beat rather
 * than the run.
 */
export function keepAlive(
  send: (frame: string) => void,
  everyMs: number = KEEP_ALIVE_EVERY_MS,
): () => void {
  const timer = setInterval(() => {
    try {
      send(KEEP_ALIVE_FRAME);
    } catch {
      clearInterval(timer);
    }
  }, everyMs);
  return () => clearInterval(timer);
}
