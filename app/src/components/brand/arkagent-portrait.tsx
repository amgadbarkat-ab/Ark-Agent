/**
 * The ArkAgent character: the product's own face, for the screens where the product speaks for itself
 * (the welcome and the terms). The coworkers a person hires keep their own orbs; this one is not a
 * coworker. Decorative, so it says nothing to assistive technology.
 *
 * The picture is cropped from the poster the company supplied (brand/arkagent/), by brand/render-icons.mjs.
 */
export function ArkAgentPortrait({ size }: { size: number }) {
  return (
    <img
      alt=""
      aria-hidden="true"
      className="rounded-full object-cover ring-1 ring-border"
      height={size}
      src="/brand/arkagent-portrait.jpg"
      width={size}
    />
  );
}
