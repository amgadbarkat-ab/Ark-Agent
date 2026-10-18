/**
 * Turns the file somebody chose into the small picture a coworker keeps as its icon.
 *
 * The server refuses anything over about 24 KB (`server/src/agents/avatar-image.ts`) because the picture
 * rides along on every list of coworkers, so the file is cropped to its middle square and drawn at 128
 * pixels first, which is twice the largest size the app shows it at on an ordinary screen.
 */

export const ICON_SIDE = 128;

/** The kinds of picture a person may choose. SVG is not one: it can carry script. */
export const ICON_FILE_TYPES = ["image/png", "image/jpeg", "image/webp"];

/** A file this large is a photograph, not an icon, and decoding it would only slow the page down. */
export const MAX_ICON_FILE_BYTES = 8 * 1024 * 1024;

export function iconFileProblem(file: {
  type: string;
  size: number;
}): string | null {
  if (!ICON_FILE_TYPES.includes(file.type)) {
    return "Choose a PNG, JPEG or WebP picture.";
  }
  if (file.size > MAX_ICON_FILE_BYTES) {
    return "That picture is too large. Choose one under 8 MB.";
  }
  return null;
}

/** The side of the largest square in the middle of an image, and where it starts. */
export function centreSquare(
  width: number,
  height: number,
): { x: number; y: number; side: number } {
  const side = Math.min(width, height);
  return { x: (width - side) / 2, y: (height - side) / 2, side };
}

export async function iconFromFile(file: File): Promise<string> {
  const problem = iconFileProblem(file);
  if (problem) throw new Error(problem);
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = ICON_SIDE;
    canvas.height = ICON_SIDE;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot resize pictures.");
    context.imageSmoothingQuality = "high";
    const { x, y, side } = centreSquare(bitmap.width, bitmap.height);
    context.drawImage(bitmap, x, y, side, side, 0, 0, ICON_SIDE, ICON_SIDE);
    // WebP keeps transparency. A browser that cannot write it answers with a PNG, which is too large
    // for a list, so that case is drawn again on white as a JPEG.
    const webp = canvas.toDataURL("image/webp", 0.85);
    if (webp.startsWith("data:image/webp")) return webp;
    context.globalCompositeOperation = "destination-over";
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, ICON_SIDE, ICON_SIDE);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    bitmap.close();
  }
}
