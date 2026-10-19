const scene = new URL("./assets/arkagent-scene.jpg", import.meta.url).href;

/**
 * The company's side of every setup step but the first (which is the whole scene): its app tile and the
 * product's name, the character, and the three promises the company makes about a digital employee,
 * in the company's own words (brand/README.md).
 *
 * The tile is drawn here from the same three bars the company publishes (brand/mark.svg) rather than
 * loaded, so it is on screen at the moment the window is, with no request to wait for. Decoration
 * throughout, so none of it is announced.
 */
export function BrandBar() {
  return (
    <aside className="brandside" aria-hidden="true">
      <div className="brandside-top">
        <svg viewBox="0 0 160 160" aria-hidden="true">
          <rect width="160" height="160" rx="28" fill="#FF7A1A" />
          <rect x="34" y="88" width="26" height="42" rx="6" fill="#1A0B03" />
          <rect x="67" y="64" width="26" height="66" rx="6" fill="#1A0B03" />
          <rect x="100" y="34" width="26" height="96" rx="6" fill="#1A0B03" />
        </svg>
        <span>ArkAgent</span>
      </div>
      <span className="brandside-glow" />
      <img className="brandside-figure" src={scene} alt="" />
      <ul className="brandside-lines">
        <li>Runs a written routine</li>
        <li>A person keeps judgment</li>
        <li>Hands off outside the procedure</li>
      </ul>
    </aside>
  );
}
