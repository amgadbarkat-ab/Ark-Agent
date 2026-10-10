// A URL rather than an import: the bundler copies the file and names it here, and a test (which has no
// bundler) gets a plain address instead of trying to read a picture as code.
const portrait = new URL("./assets/arkagent-portrait.jpg", import.meta.url)
  .href;

/**
 * The ArkAgent character, as the face beside the product's name. Cropped from the poster the company
 * supplied (brand/arkagent/) by brand/render-icons.mjs. Decorative.
 */
export function Portrait() {
  return <img className="portrait" src={portrait} alt="" aria-hidden="true" />;
}
