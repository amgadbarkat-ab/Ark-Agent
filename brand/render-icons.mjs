// Renders every icon Ark ships from the company's app tile (brand/mark.svg) and writes it where it is used.
//
//   node brand/render-icons.mjs
//
// Needs Playwright and a Chromium, because Chromium is the one renderer present on every machine that
// builds this repository and it draws the same SVG the same way everywhere. Where they are is read from
// two optional variables:
//
//   PLAYWRIGHT_MODULE   path of the Playwright package, when `playwright` is not importable from here
//   CHROMIUM_PATH       path of the Chromium executable, when Playwright's own download is not installed
//
// What it writes (nothing else in the repository is touched):
//
//   app/public/icons/            the installable web app: icon.svg, icon-maskable.svg, icon-512.png,
//                                icon-maskable-512.png, plus the company's own 192 and 180 files copied
//   mobile/ios/brand/            AppIcon-1024.png, flat colour with no transparency (the App Store refuses it)
//   mobile/android/app/src/main/ the adaptive launcher icon (vector foreground, background colour) and the
//                                company's 192 file as the icon for phones too old for an adaptive one
//   app/public/brand/,           the ArkAgent character's head and shoulders, cropped from the poster the owner
//   desktop/src/assets/,         supplied (brand/arkagent/arkagent-poster.jpg): the product's face, a circle crop
//   brand/arkagent/              used on the first screens each app shows
//   desktop/src-tauri/icons/     icon.png, the 1024 master. The platform sizes are then made from it by
//                                `bun run tauri icon` (brand/README.md says how), because that is the tool
//                                that knows each platform's formats.
//
// The 192 and 180 files are the company's own artwork, published on its website, and are copied rather than
// redrawn so the app's icon is exactly the one a person has already seen.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const at = (...parts) => join(root, ...parts);

// The company's tile, in its own 160 unit space (brand/mark.svg).
const EMBER = "#FF7A1A";
const INK = "#1A0B03";
const TILE = 160;
const TILE_RADIUS = 28;
const BARS = [
  { x: 34, y: 88, w: 26, h: 42 },
  { x: 67, y: 64, w: 26, h: 66 },
  { x: 100, y: 34, w: 26, h: 96 },
];
const BAR_RADIUS = 6;
// The bars are not centred vertically (they span 34 to 130), so scaling them down around the tile's
// centre would push them low. This is where their own middle is.
const BARS_CENTRE = { x: 80, y: 82 };

const barRects = (transform = "") =>
  `<g${transform ? ` transform="${transform}"` : ""} fill="${INK}">${BARS.map(
    (bar) =>
      `<rect x="${bar.x}" y="${bar.y}" width="${bar.w}" height="${bar.h}" rx="${BAR_RADIUS}"/>`,
  ).join("")}</g>`;

/** An SVG document `size` pixels square showing `viewBox` of the tile's space. */
function svg(size, viewBox, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${viewBox}">${body}</svg>`;
}

/** The same document with an accessible name, as a file ending in a newline. */
const labelled = (document) =>
  `${document.replace("<svg ", '<svg role="img" aria-label="ArkAgent" ')}\n`;

const tileBody = `<rect width="${TILE}" height="${TILE}" rx="${TILE_RADIUS}" fill="${EMBER}"/>${barRects()}`;
const flatBody = `<rect width="${TILE}" height="${TILE}" fill="${EMBER}"/>${barRects()}`;

/**
 * Full-bleed, for launchers that cut their own shape (maskable web icons). Everything that matters has to
 * sit inside the circle of 80% of the width that any mask leaves, so the bars shrink to 90%, which puts
 * their farthest corner at 75% of the way to that circle's edge.
 */
const MASKABLE_SCALE = 0.9;
const maskableBody = `<rect width="${TILE}" height="${TILE}" fill="${EMBER}"/>${barRects(
  `translate(80 80) scale(${MASKABLE_SCALE}) translate(${-BARS_CENTRE.x} ${-BARS_CENTRE.y})`,
)}`;

/**
 * The desktop master: the tile with a margin of 1/16 of the width on every side, which is what macOS and
 * Windows expect so the icon does not look larger than its neighbours, and with transparent corners, which
 * the tray icon's test insists on.
 */
const DESKTOP_MARGIN = TILE / 14;
const desktopViewBox = `${-DESKTOP_MARGIN} ${-DESKTOP_MARGIN} ${TILE + 2 * DESKTOP_MARGIN} ${TILE + 2 * DESKTOP_MARGIN}`;

/** Where the character's head and shoulders are in the 768 by 1152 poster: a square of this side, from this corner. */
const PORTRAIT_CROP = { x: 325, y: 88, size: 350 };

// ---------- PNG writing (no dependencies) ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

/** An 8-bit PNG from RGBA pixels, with the alpha channel kept (colour type 6) or dropped (colour type 2). */
function encodePng(rgba, size, keepAlpha) {
  const channels = keepAlpha ? 4 : 3;
  const stride = size * channels;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const from = (y * size + x) * 4;
      const to = y * (stride + 1) + 1 + x * channels;
      raw[to] = rgba[from];
      raw[to + 1] = rgba[from + 1];
      raw[to + 2] = rgba[from + 2];
      if (keepAlpha) raw[to + 3] = rgba[from + 3];
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = keepAlpha ? 6 : 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- Android's vector foreground ----------

const dp = (value) => Number(value.toFixed(2));

/** A rounded rectangle as a vector-drawable path, because that format has no rounded rectangle. */
function roundedRect(x, y, w, h, r) {
  return [
    `M${dp(x + r)},${dp(y)}`,
    `H${dp(x + w - r)}`,
    `A${dp(r)},${dp(r)} 0 0 1 ${dp(x + w)},${dp(y + r)}`,
    `V${dp(y + h - r)}`,
    `A${dp(r)},${dp(r)} 0 0 1 ${dp(x + w - r)},${dp(y + h)}`,
    `H${dp(x + r)}`,
    `A${dp(r)},${dp(r)} 0 0 1 ${dp(x)},${dp(y + h - r)}`,
    `V${dp(y + r)}`,
    `A${dp(r)},${dp(r)} 0 0 1 ${dp(x + r)},${dp(y)}`,
    "Z",
  ].join(" ");
}

/**
 * Android draws an adaptive icon on a 108 by 108 canvas and shows only a circle of 66 in the middle
 * wherever a launcher masks it. At 0.46 of a tile unit per unit of that canvas the bars' farthest corner is
 * 30.6 from the middle, inside the 33 that is always shown.
 */
const ANDROID_SCALE = 0.46;

function androidForeground() {
  const paths = BARS.map((bar) => {
    const x = 54 + (bar.x - BARS_CENTRE.x) * ANDROID_SCALE;
    const y = 54 + (bar.y - BARS_CENTRE.y) * ANDROID_SCALE;
    return `    <path
        android:fillColor="${INK}"
        android:pathData="${roundedRect(x, y, bar.w * ANDROID_SCALE, bar.h * ANDROID_SCALE, BAR_RADIUS * ANDROID_SCALE)}" />`;
  });
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by brand/render-icons.mjs from the company's app tile. Do not edit by hand. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
${paths.join("\n")}
</vector>
`;
}

const ANDROID_ADAPTIVE = `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by brand/render-icons.mjs. The monochrome layer is what Android 13 tints for themed icons. -->
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
    <monochrome android:drawable="@drawable/ic_launcher_foreground" />
</adaptive-icon>
`;

const ANDROID_BACKGROUND = `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by brand/render-icons.mjs. The company's ember. -->
<resources>
    <color name="ic_launcher_background">${EMBER}</color>
</resources>
`;

// ---------- Drawing ----------

async function loadChromium() {
  const specifier = process.env.PLAYWRIGHT_MODULE
    ? pathToFileURL(
        resolve(process.env.PLAYWRIGHT_MODULE, "index.mjs"),
      ).toString()
    : "playwright";
  const { chromium } = await import(specifier);
  return chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH }
      : {}),
  });
}

/** RGBA pixels of an SVG document, as Chromium draws it. */
async function pixels(page, document, size) {
  const encoded = Buffer.from(document).toString("base64");
  const values = await page.evaluate(
    async ({ encoded, size }) => {
      const image = new Image();
      image.src = `data:image/svg+xml;base64,${encoded}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(image, 0, 0, size, size);
      return Array.from(context.getImageData(0, 0, size, size).data);
    },
    { encoded, size },
  );
  return Uint8Array.from(values);
}

function write(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  console.log(`wrote ${path.slice(root.length + 1)}`);
}

function copy(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  console.log(`copied ${to.slice(root.length + 1)}`);
}

const browser = await loadChromium();
try {
  const page = await browser.newPage();

  // The installable web app.
  write(
    at("app/public/icons/icon.svg"),
    labelled(svg(512, `0 0 ${TILE} ${TILE}`, tileBody)),
  );
  write(
    at("app/public/icons/icon-maskable.svg"),
    labelled(svg(512, `0 0 ${TILE} ${TILE}`, maskableBody)),
  );
  write(
    at("app/public/icons/icon-512.png"),
    encodePng(
      await pixels(page, svg(512, `0 0 ${TILE} ${TILE}`, tileBody), 512),
      512,
      true,
    ),
  );
  write(
    at("app/public/icons/icon-maskable-512.png"),
    encodePng(
      await pixels(page, svg(512, `0 0 ${TILE} ${TILE}`, maskableBody), 512),
      512,
      false,
    ),
  );
  copy(
    at("brand/official/favicon-192.png"),
    at("app/public/icons/icon-192.png"),
  );
  copy(
    at("brand/official/apple-touch-icon.png"),
    at("app/public/icons/apple-touch-icon.png"),
  );

  // The iOS app's App Store icon: flat, square, no transparency (the store applies its own corners).
  const ios = await pixels(
    page,
    svg(1024, `0 0 ${TILE} ${TILE}`, flatBody),
    1024,
  );
  for (let index = 3; index < ios.length; index += 4) {
    if (ios[index] !== 255) {
      throw new Error("The App Store icon came out with transparent pixels.");
    }
  }
  write(at("mobile/ios/brand/AppIcon-1024.png"), encodePng(ios, 1024, false));

  // The Android app.
  const res = at("mobile/android/app/src/main/res");
  write(join(res, "drawable/ic_launcher_foreground.xml"), androidForeground());
  write(join(res, "values/ic_launcher_background.xml"), ANDROID_BACKGROUND);
  write(join(res, "mipmap-anydpi-v26/ic_launcher.xml"), ANDROID_ADAPTIVE);
  copy(
    at("brand/official/favicon-192.png"),
    join(res, "mipmap-xxxhdpi/ic_launcher.png"),
  );

  // The desktop master.
  write(
    at("desktop/src-tauri/icons/icon.png"),
    encodePng(
      await pixels(page, svg(1024, desktopViewBox, tileBody), 1024),
      1024,
      true,
    ),
  );

  // The ArkAgent character, head and shoulders, from the owner's poster (the poster itself carries the
  // retired v2 logo, so only the figure is used). A square, drawn at its own size and never scaled up.
  const poster = readFileSync(at("brand/arkagent/arkagent-poster.jpg"));
  const portrait = Buffer.from(
    await page.evaluate(
      async ({ encoded, crop }) => {
        const image = new Image();
        image.src = `data:image/jpeg;base64,${encoded}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = crop.size;
        canvas.height = crop.size;
        const context = canvas.getContext("2d");
        context.drawImage(
          image,
          crop.x,
          crop.y,
          crop.size,
          crop.size,
          0,
          0,
          crop.size,
          crop.size,
        );
        return canvas.toDataURL("image/jpeg", 0.92).split(",")[1];
      },
      { encoded: poster.toString("base64"), crop: PORTRAIT_CROP },
    ),
    "base64",
  );
  write(at("brand/arkagent/portrait.jpg"), portrait);
  write(at("app/public/brand/arkagent-portrait.jpg"), portrait);
  write(at("desktop/src/assets/arkagent-portrait.jpg"), portrait);
} finally {
  await browser.close();
}
