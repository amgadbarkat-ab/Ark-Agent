/**
 * What OpenBot is, before it asks for anything.
 *
 * Few words on purpose. The person here was sent a link by their IT department and has not decided
 * to care yet: they need to know what this is, that it will not ask them for anything technical,
 * and where the button is. Everything else waits for a screen that needs it.
 */
export function Welcome({ onStart }: { onStart: () => void }) {
  return (
    <div className="sheet">
      <div className="lockup">
        <svg className="tile" viewBox="0 0 160 160" aria-hidden="true">
          {/* The company's app tile (brand/mark.svg): ember, with three ascending bars. */}
          <rect width="160" height="160" rx="28" fill="#FF7A1A" />
          <rect x="34" y="88" width="26" height="42" rx="6" fill="#1A0B03" />
          <rect x="67" y="64" width="26" height="66" rx="6" fill="#1A0B03" />
          <rect x="100" y="34" width="26" height="96" rx="6" fill="#1A0B03" />
        </svg>
        <span>OpenBot</span>
      </div>
      <h1>Your own AI coworkers, on this computer.</h1>
      <p className="lede big">
        They answer questions, use the tools you connect, and can work in a
        browser for you.
      </p>
      <div className="row">
        <button type="button" onClick={onStart}>
          Set up OpenBot
        </button>
      </div>
      <p className="footnote">
        Takes a few minutes. OpenBot installs what it needs first, then asks how
        you want to connect an AI model.
      </p>
    </div>
  );
}
