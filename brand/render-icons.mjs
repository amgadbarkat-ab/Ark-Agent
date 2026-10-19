// Renders every icon ArkAgent ships from the character's portrait (brand/arkagent/icon-source.webp) and
// writes it where it is used.
//
//   node brand/render-icons.mjs
//
// Needs Playwright and a Chromium, because Chromium is the one renderer present on every machine that
// builds this repository and it draws the same picture the same way everywhere. Where they are is read from
// two optional variables:
//
//   PLAYWRIGHT_MODULE   path of the Playwright package, when `playwright` is not importable from here
//   CHROMIUM_PATH       path of the Chromium executable, when Playwright's own download is not installed
//
// What it writes (nothing else in the repository is touched):
//
//   app/public/brand/arkagent-icon.jpg   the icon the app itself draws: the top-left logo and every Bot's
//                                        default picture. Square; the screen rounds it.
//   app/public/icons/            the installable web app: icon.svg, icon-maskable.svg, icon-192.png,
//                                icon-512.png, icon-maskable-512.png, apple-touch-icon.png
//   mobile/ios/brand/            AppIcon-1024.png, flat with no transparency (the App Store refuses it)
//   mobile/android/app/src/main/ the adaptive launcher icon (picture foreground, the picture's own dark as
//                                the background) and the 192 file as the icon for phones too old for one
//   desktop/src-tauri/icons/     icon.png, the 1024 master. The platform sizes are then made from it by
//                                `bun run tauri icon` (brand/README.md says how), because that is the tool
//                                that knows each platform's formats.
//   app/public/brand/,           the ArkAgent character's head and shoulders, cropped from the poster the owner
//   desktop/src/assets/,         supplied (brand/arkagent/arkagent-poster.webp): the product's face on the
//   brand/arkagent/              first screens each app shows
//   brand/arkagent/scene.jpg     the whole figure, cropped from the same poster for the welcome screens (also
//   app/public/brand/,           copied to app/public/brand/ and desktop/src/assets/), and four role faces for
//   desktop/src/assets/roles/    the desktop's welcome. `--scene-only` writes just these and nothing else.
//   brand/arkteam/,              the Ark Team roster the owner supplied (brand/arkteam/arkteam-roster.webp), cut into its
//   app/public/brand/team/       eight characters and a four-face picture for the plan screen
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const at = (...parts) => join(root, ...parts);

/**
 * Where the head is in the 1024 square portrait the owner supplied: a square of this side from this corner.
 * Found by fitting the owner's own round icon (256 px) to the portrait, so the framing is theirs.
 */
const ICON_CROP = { x: 240, y: 30, size: 560 };

/**
 * The same head, framed tighter, for the icons an operating system draws small: the taskbar, the dock, the
 * tray, a launcher. In the owner's own framing the head fills about 80% of the square and the rest is dark
 * background, which at 32 pixels is a small head in a large frame. This crop starts a few pixels left of the
 * head and at its crown, so the head fills about nine tenths of the width.
 */
const TIGHT_CROP = { x: 276, y: 50, size: 500 };

/** Where the character's head and shoulders are in the 864 by 1152 poster: a square of this side, from this corner. */
const PORTRAIT_CROP = { x: 430, y: 74, size: 346 };

/**
 * The whole figure, without the poster's own wording: the strip of the 864 by 1152 poster to the right of
 * where its text ends. Drawn at its own size and faded into the dark by the screen that shows it, which is
 * the picture the desktop's welcome and the app's empty states stand the character in.
 */
const SCENE_CROP = { x: 420, y: 0, w: 444, h: 1152 };

/** The characters shown on the desktop's welcome screen, to say a digital employee comes in a role. */
const WELCOME_ROLES = ["sales", "accounting", "finance", "front-desk"];

/**
 * Where each character's head and shoulders are in the 1280 by 720 Ark Team roster: a square of
 * ROLE_SIZE from this corner. Row one is Sales, Marketing, Accounting, Inventory and logistics; row two is
 * Finance, Chief of operations, Chief of staff, Front desk.
 */
const ROLE_SIZE = 150;
const ROLES = [
  { slug: "sales", x: 110, y: 114 },
  { slug: "marketing", x: 403, y: 114 },
  { slug: "accounting", x: 701, y: 114 },
  { slug: "inventory-and-logistics", x: 993, y: 114 },
  { slug: "finance", x: 110, y: 392 },
  { slug: "chief-of-operations", x: 403, y: 392 },
  { slug: "chief-of-staff", x: 701, y: 392 },
  { slug: "front-desk", x: 993, y: 392 },
];

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

/** The icon's average dark, taken from the portrait's own corner, so a launcher's fill matches the picture. */
async function sourceBackground(page, source) {
  const rgb = await page.evaluate(async (encoded) => {
    const image = new Image();
    image.src = `data:image/webp;base64,${encoded}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 20;
    canvas.height = 20;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, 5, 5, 20, 20, 0, 0, 20, 20);
    const data = context.getImageData(0, 0, 20, 20).data;
    const sum = [0, 0, 0];
    for (let index = 0; index < data.length; index += 4) {
      for (let channel = 0; channel < 3; channel += 1) {
        sum[channel] += data[index + channel];
      }
    }
    return sum.map((value) => Math.round(value / (data.length / 4)));
  }, source.toString("base64"));
  return `#${rgb.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * RGBA pixels of the icon: the portrait's head, cropped, in a shape, on an optional fill.
 *
 *   shape       "circle", "rounded" (a desktop icon's squircle) or "square"
 *   inset       the fraction of the width left empty on every side (transparent unless `background`)
 *   content     the fraction of the shape the picture fills, centred; below 1 it leaves a margin of `background`
 */
async function character(
  page,
  source,
  {
    size,
    shape = "square",
    inset = 0,
    content = 1,
    background = null,
    crop = TIGHT_CROP,
  },
) {
  const values = await page.evaluate(
    async ({ encoded, crop, size, shape, inset, content, background }) => {
      const image = new Image();
      image.src = `data:image/webp;base64,${encoded}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.imageSmoothingQuality = "high";
      const margin = size * inset;
      const box = size - 2 * margin;
      if (background) {
        context.fillStyle = background;
        context.fillRect(0, 0, size, size);
      }
      context.save();
      context.beginPath();
      if (shape === "circle") {
        context.arc(size / 2, size / 2, box / 2, 0, Math.PI * 2);
      } else if (shape === "rounded") {
        context.roundRect(margin, margin, box, box, box * 0.22);
      } else {
        context.rect(margin, margin, box, box);
      }
      context.clip();
      const side = box * content;
      const offset = margin + (box - side) / 2;
      context.drawImage(
        image,
        crop.x,
        crop.y,
        crop.size,
        crop.size,
        offset,
        offset,
        side,
        side,
      );
      context.restore();
      return Array.from(context.getImageData(0, 0, size, size).data);
    },
    {
      encoded: source.toString("base64"),
      crop,
      size,
      shape,
      inset,
      content,
      background,
    },
  );
  return Uint8Array.from(values);
}

/** An SVG that shows `href` (a data URI) in a circle, or full-bleed on `fill` when `fill` is given. */
function iconSvg(href, fill, content) {
  const body = fill
    ? `<rect width="512" height="512" fill="${fill}"/><image href="${href}" x="${(512 * (1 - content)) / 2}" y="${(512 * (1 - content)) / 2}" width="${512 * content}" height="${512 * content}"/>`
    : `<clipPath id="c"><circle cx="256" cy="256" r="256"/></clipPath><image href="${href}" width="512" height="512" clip-path="url(#c)"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="ArkAgent" width="512" height="512" viewBox="0 0 512 512">${body}</svg>\n`;
}

const androidAdaptive = `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by brand/render-icons.mjs. -->
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
</adaptive-icon>
`;

const androidBackground = (colour) => `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by brand/render-icons.mjs. The picture's own dark. -->
<resources>
    <color name="ic_launcher_background">${colour}</color>
</resources>
`;

function write(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  console.log(`wrote ${path.slice(root.length + 1)}`);
}

/** A JPEG made of rectangles cut from one picture and drawn at their own size (never scaled up). */
async function cut(page, source, mime, pieces, size) {
  const encoded = await page.evaluate(
    async ({ encoded, mime, pieces, size }) => {
      const image = new Image();
      image.src = `data:${mime};base64,${encoded}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = size.w;
      canvas.height = size.h;
      const context = canvas.getContext("2d");
      for (const piece of pieces) {
        context.drawImage(
          image,
          piece.sx,
          piece.sy,
          piece.sw,
          piece.sh,
          piece.dx,
          piece.dy,
          piece.dw,
          piece.dh,
        );
      }
      return canvas.toDataURL("image/jpeg", 0.92).split(",")[1];
    },
    { encoded: source.toString("base64"), mime, pieces, size },
  );
  return Buffer.from(encoded, "base64");
}

/** The cinematic figure and the role faces, written alone when `--scene-only` is given. */
async function writeScene(page) {
  const poster = readFileSync(at("brand/arkagent/arkagent-poster.webp"));
  const scene = await cut(
    page,
    poster,
    "image/webp",
    [
      {
        sx: SCENE_CROP.x,
        sy: SCENE_CROP.y,
        sw: SCENE_CROP.w,
        sh: SCENE_CROP.h,
        dx: 0,
        dy: 0,
        dw: SCENE_CROP.w,
        dh: SCENE_CROP.h,
      },
    ],
    { w: SCENE_CROP.w, h: SCENE_CROP.h },
  );
  write(at("brand/arkagent/scene.jpg"), scene);
  write(at("app/public/brand/arkagent-scene.jpg"), scene);
  write(at("desktop/src/assets/arkagent-scene.jpg"), scene);
  const roster = readFileSync(at("brand/arkteam/arkteam-roster.webp"));
  for (const slug of WELCOME_ROLES) {
    const role = ROLES.find((entry) => entry.slug === slug);
    const face = await cut(
      page,
      roster,
      "image/webp",
      [
        {
          sx: role.x,
          sy: role.y,
          sw: ROLE_SIZE,
          sh: ROLE_SIZE,
          dx: 0,
          dy: 0,
          dw: ROLE_SIZE,
          dh: ROLE_SIZE,
        },
      ],
      { w: ROLE_SIZE, h: ROLE_SIZE },
    );
    write(at(`desktop/src/assets/roles/${slug}.jpg`), face);
  }
}

const browser = await loadChromium();
try {
  const page = await browser.newPage();
  if (process.argv.includes("--scene-only")) {
    await writeScene(page);
    process.exit(0);
  }
  const source = readFileSync(at("brand/arkagent/icon-source.webp"));
  const dark = await sourceBackground(page, source);

  // What the app draws itself: a square, which the screen rounds.
  const face = await cut(
    page,
    source,
    "image/webp",
    [
      {
        sx: ICON_CROP.x,
        sy: ICON_CROP.y,
        sw: ICON_CROP.size,
        sh: ICON_CROP.size,
        dx: 0,
        dy: 0,
        dw: 256,
        dh: 256,
      },
    ],
    { w: 256, h: 256 },
  );
  write(at("app/public/brand/arkagent-icon.jpg"), face);
  const href = `data:image/jpeg;base64,${face.toString("base64")}`;

  // The installable web app.
  write(at("app/public/icons/icon.svg"), iconSvg(href, null, 1));
  write(at("app/public/icons/icon-maskable.svg"), iconSvg(href, dark, 0.8));
  const round = (size) =>
    character(page, source, { size, shape: "circle" }).then((rgba) =>
      encodePng(rgba, size, true),
    );
  write(at("app/public/icons/icon-512.png"), await round(512));
  const round192 = await round(192);
  write(at("app/public/icons/icon-192.png"), round192);
  // A launcher cuts its own shape from a maskable icon, so it is full-bleed and everything that matters
  // sits inside the circle of 80% of the width that any mask leaves.
  write(
    at("app/public/icons/icon-maskable-512.png"),
    encodePng(
      await character(page, source, {
        size: 512,
        content: 0.8,
        background: dark,
      }),
      512,
      false,
    ),
  );
  // iOS rounds its own corners, so these two are flat squares.
  write(
    at("app/public/icons/apple-touch-icon.png"),
    encodePng(
      await character(page, source, { size: 180, background: dark }),
      180,
      false,
    ),
  );
  const ios = await character(page, source, { size: 1024, background: dark });
  for (let index = 3; index < ios.length; index += 4) {
    if (ios[index] !== 255) {
      throw new Error("The App Store icon came out with transparent pixels.");
    }
  }
  write(at("mobile/ios/brand/AppIcon-1024.png"), encodePng(ios, 1024, false));

  // The Android app. Android draws an adaptive icon on a 108 by 108 canvas and shows only a circle of 66
  // in the middle wherever a launcher masks it, so the picture fills 61% of the canvas.
  const res = at("mobile/android/app/src/main/res");
  rmSync(join(res, "drawable/ic_launcher_foreground.xml"), { force: true });
  write(
    join(res, "drawable-xxxhdpi/ic_launcher_foreground.png"),
    encodePng(
      await character(page, source, { size: 432, content: 0.61 }),
      432,
      true,
    ),
  );
  write(
    join(res, "values/ic_launcher_background.xml"),
    androidBackground(dark),
  );
  write(join(res, "mipmap-anydpi-v26/ic_launcher.xml"), androidAdaptive);
  write(join(res, "mipmap-xxxhdpi/ic_launcher.png"), round192);

  // The desktop master: a rounded square with a margin, which is what macOS and Windows expect so the icon
  // does not look larger than its neighbours, and with transparent corners, which the tray icon's test
  // insists on.
  write(
    at("desktop/src-tauri/icons/icon.png"),
    encodePng(
      await character(page, source, {
        size: 1024,
        shape: "rounded",
        inset: 0.02,
      }),
      1024,
      true,
    ),
  );

  // The ArkAgent character, head and shoulders, from the owner's poster.
  const poster = readFileSync(at("brand/arkagent/arkagent-poster.webp"));
  const portrait = await cut(
    page,
    poster,
    "image/webp",
    [
      {
        sx: PORTRAIT_CROP.x,
        sy: PORTRAIT_CROP.y,
        sw: PORTRAIT_CROP.size,
        sh: PORTRAIT_CROP.size,
        dx: 0,
        dy: 0,
        dw: PORTRAIT_CROP.size,
        dh: PORTRAIT_CROP.size,
      },
    ],
    { w: PORTRAIT_CROP.size, h: PORTRAIT_CROP.size },
  );
  write(at("brand/arkagent/portrait.jpg"), portrait);
  write(at("app/public/brand/arkagent-portrait.jpg"), portrait);
  write(at("desktop/src/assets/arkagent-portrait.jpg"), portrait);

  // The Ark Team roster, cut into its eight characters, and four of them together for the plan screen.
  const roster = readFileSync(at("brand/arkteam/arkteam-roster.webp"));
  const piece = (role, dx, dy, d) => ({
    sx: role.x,
    sy: role.y,
    sw: ROLE_SIZE,
    sh: ROLE_SIZE,
    dx,
    dy,
    dw: d,
    dh: d,
  });
  for (const role of ROLES) {
    const face = await cut(
      page,
      roster,
      "image/webp",
      [piece(role, 0, 0, ROLE_SIZE)],
      { w: ROLE_SIZE, h: ROLE_SIZE },
    );
    write(at(`brand/arkteam/roles/${role.slug}.jpg`), face);
    write(at(`app/public/brand/team/${role.slug}.jpg`), face);
  }
  const faces = await cut(
    page,
    roster,
    "image/webp",
    ROLES.slice(0, 4).map((role, index) =>
      piece(role, (index % 2) * 96, Math.floor(index / 2) * 96, 96),
    ),
    { w: 192, h: 192 },
  );
  write(at("brand/arkteam/team-faces.jpg"), faces);
  write(at("app/public/brand/team/faces.jpg"), faces);
  await writeScene(page);
} finally {
  await browser.close();
}
