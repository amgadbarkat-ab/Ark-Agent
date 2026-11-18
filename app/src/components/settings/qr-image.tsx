import { qrCode } from "../../../../shared/qr";

/**
 * A QR code drawn as one SVG path, dark on white with the four-module quiet zone a phone needs, in
 * both themes (a scanner reads dark on light, so this does not follow the dark theme).
 */
export function QrImage({ label, text }: { label: string; text: string }) {
  const code = qrCode(text);
  if (!code) return null;
  const quiet = 4;
  const size = code.size + quiet * 2;
  let path = "";
  code.modules.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    });
  });
  return (
    <svg
      aria-label={label}
      className="h-44 w-44 rounded-md"
      role="img"
      shapeRendering="crispEdges"
      viewBox={`0 0 ${size} ${size}`}
    >
      <rect fill="#fff" height={size} width={size} />
      <path d={path} fill="#000" />
    </svg>
  );
}
