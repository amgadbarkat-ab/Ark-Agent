import portrait from "./assets/arkagent-portrait.jpg";

/**
 * The ArkAgent character, as the face beside the product's name. Cropped from the poster the company
 * supplied (brand/arkagent/) by brand/render-icons.mjs. Decorative.
 */
export function Portrait() {
  return <img className="portrait" src={portrait} alt="" aria-hidden="true" />;
}
