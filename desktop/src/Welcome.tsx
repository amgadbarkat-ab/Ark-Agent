import { ParticleMark } from "./ParticleMark";

/**
 * What Ark Agent is, before it asks for anything.
 *
 * Few words on purpose. The person here was sent a link by their IT department and has not decided
 * to care yet: they need to know what this is, that it will not ask them for anything technical,
 * and where the button is. Everything else waits for a screen that needs it.
 */
export function Welcome({ onStart }: { onStart: () => void }) {
  return (
    <div className="sheet">
      <ParticleMark />
      <div className="lockup">
        <span>Ark Agent</span>
      </div>
      <h1>Your own AI coworkers, on this computer.</h1>
      <p className="lede big">
        They answer questions, use the tools you connect, and can work in a
        browser for you.
      </p>
      <div className="row">
        <button type="button" onClick={onStart}>
          Set up Ark Agent
        </button>
      </div>
      <p className="footnote">
        Takes a few minutes. Ark Agent installs what it needs first, then asks
        how you want to connect an AI model.
      </p>
    </div>
  );
}
