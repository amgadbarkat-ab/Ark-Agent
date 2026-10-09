import { useEffect, useRef } from "react";
import { mountParticleMark } from "../../../../shared/particle-mark";

/**
 * The company's hero animation (shared/particle-mark.ts) on a dark card, which is where it looks as it
 * does on www.blackark.uk: the points are additive light and need a dark ground in either theme.
 *
 * Decoration only. Where WebGL is missing, or the person asks for less motion, the card shows the
 * company's app tile (still) or one still frame of the mark, and nothing else changes.
 */
export function ParticleMark({ className }: { className?: string }) {
  const stage = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = stage.current;
    return node ? mountParticleMark(node, { zoom: 1 }) : undefined;
  }, []);

  return (
    <div
      aria-hidden="true"
      className={`relative grid place-items-center overflow-hidden rounded-xl bg-[#070504] [&[data-particles=on]>svg]:hidden ${className ?? ""}`}
      ref={stage}
    >
      {/* The still the card keeps until the animation is drawing (and for good if it cannot). */}
      <svg aria-hidden="true" className="size-16" viewBox="0 0 160 160">
        <rect fill="#FF7A1A" height="160" rx="28" width="160" />
        <rect fill="#1A0B03" height="42" rx="6" width="26" x="34" y="88" />
        <rect fill="#1A0B03" height="66" rx="6" width="26" x="67" y="64" />
        <rect fill="#1A0B03" height="96" rx="6" width="26" x="100" y="34" />
      </svg>
    </div>
  );
}
