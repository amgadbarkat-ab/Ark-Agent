/**
 * The picture an owner gives a coworker, checked before it is stored.
 *
 * It is kept on the coworker's own row as a `data:` image, and every screen that lists coworkers
 * carries it, so it has to stay small: the app shrinks a chosen file to a 128 pixel square first, and
 * this refuses anything larger than a few kilobytes rather than trusting that it did.
 *
 * Only PNG, JPEG and WebP, and the bytes have to say so: a `data:image/png` label over anything else
 * is refused. SVG is left out on purpose, because it can carry script, and this string ends up in an
 * `<img>` in every person's browser who can see the coworker.
 */

/** Characters of base64, so about 24 KB of image. A 128 pixel JPEG is under 10. */
export const MAX_AVATAR_IMAGE_CHARACTERS = 32_768;

const DATA_URL = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

function startsLike(kind: string, bytes: Uint8Array): boolean {
  if (kind === "png") {
    return [0x89, 0x50, 0x4e, 0x47].every(
      (byte, index) => bytes[index] === byte,
    );
  }
  if (kind === "jpeg") {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  // WebP is a RIFF file whose form type, at bytes 8 to 11, reads "WEBP".
  return (
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  );
}

export function parseAvatarImage(
  value: unknown,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== "string") {
    return { ok: false, error: "Choose a picture to use as the icon." };
  }
  if (value.length > MAX_AVATAR_IMAGE_CHARACTERS) {
    return {
      ok: false,
      error: "That picture is too large. Choose a smaller one.",
    };
  }
  const match = DATA_URL.exec(value);
  if (!match) {
    return {
      ok: false,
      error: "The icon must be a PNG, JPEG or WebP picture.",
    };
  }
  const bytes = Uint8Array.from(Buffer.from(match[2], "base64"));
  if (!startsLike(match[1], bytes)) {
    return {
      ok: false,
      error: "That file is not the kind of picture it says.",
    };
  }
  return { ok: true, value };
}
