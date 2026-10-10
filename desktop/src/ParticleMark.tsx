import { useEffect, useRef } from "react";
import { mountParticleMark } from "../../shared/particle-mark";

/**
 * The company's hero animation (shared/particle-mark.ts) on a dark card, which is where it looks as it
 * does on www.blackark.uk. Decoration only: where WebGL is missing it shows the company's app tile and
 * nothing else changes, and a person who asks the system for less motion gets one still frame.
 */
export function ParticleMark() {
  const stage = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = stage.current;
    return node ? mountParticleMark(node, { zoom: 1 }) : undefined;
  }, []);

  return (
    <div className="stage" ref={stage} aria-hidden="true">
      {/* The still the card keeps until the animation is drawing, and for good if it cannot. */}
      <svg className="stage-still" viewBox="0 0 160 160" aria-hidden="true">
        <rect width="160" height="160" rx="28" fill="#FF7A1A" />
        <rect x="34" y="88" width="26" height="42" rx="6" fill="#1A0B03" />
        <rect x="67" y="64" width="26" height="66" rx="6" fill="#1A0B03" />
        <rect x="100" y="34" width="26" height="96" rx="6" fill="#1A0B03" />
      </svg>
    </div>
  );
}
