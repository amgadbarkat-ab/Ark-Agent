/**
 * Video editing on the customer's own computer (#109: Wine24's SM Media Creator; MD 15 Nov 15:01,
 * FFmpeg yes, Amgad handles the licence).
 *
 * WHERE THE FILES ARE. The business copies its own footage, photos and audio into
 * `ArkAgent/media/in` on that computer; finished videos are written to `ArkAgent/media/out`. Chat
 * attachments are capped at a few megabytes, which is too small for footage, and nothing here
 * uploads anything anywhere.
 *
 * WHAT AN EMPLOYEE CAN DO. `list_media` lists what is in `media/in`. `render_video` turns an edit
 * plan into MP4s, one per size asked for (9:16, 1:1, 4:5, 16:9). It is on the catalogue's write list,
 * so every render waits on an approval card that shows the whole plan. There is no publish tool:
 * a person looks at the files and publishes them, outside ArkAgent.
 *
 * WHAT IS TRUSTED. Every file a plan names must be inside `media/in` once links are resolved;
 * output names are letters, digits and hyphens; text reaches FFmpeg through files, never through
 * the command line, so a caption cannot become an FFmpeg option. One render at a time, so a plan
 * cannot overload the computer, and each FFmpeg run has a time limit.
 *
 * FFmpeg is the one already installed on the computer (`ARK_FFMPEG`, the PATH, or the usual winget
 * and Homebrew places). This module never downloads it.
 */
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, extname, join, relative, sep } from "node:path";
import { cutAtCodeUnits } from "../channels/text";
import { MAX_RESULT_CHARS, type McpCallResult, type McpTool } from "./mcp";

export const SIZES = {
  "9:16": { width: 1080, height: 1920, label: "9x16" },
  "1:1": { width: 1080, height: 1080, label: "1x1" },
  "4:5": { width: 1080, height: 1350, label: "4x5" },
  "16:9": { width: 1920, height: 1080, label: "16x9" },
} as const;
export type VideoSize = keyof typeof SIZES;

const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv"]);
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const AUDIO_EXT = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg"]);
export const MAX_SECONDS = 90;
const MAX_PIECES = 30;
const MAX_SUBTITLES = 200;
const MAX_TEXT = 300;
const RUN_TIMEOUT_MS = 10 * 60_000;
const FPS = 30;

export class VideoPlanError extends Error {}

// ---- where things are ------------------------------------------------------------------------

export type VideoSetup = {
  /** Off on a hosted deployment: there is no "this computer" there. */
  enabled: boolean;
  mediaDir: string;
  ffmpeg: string | null;
  ffprobe: string | null;
  font: string | null;
};

const FONT_CANDIDATES = [
  "C:\\Windows\\Fonts\\arial.ttf",
  "C:\\Windows\\Fonts\\segoeui.ttf",
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/Library/Fonts/Arial.ttf",
  "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/TTF/DejaVuSans.ttf",
  "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
];

function findTool(
  name: "ffmpeg" | "ffprobe",
  configured?: string,
): string | null {
  if (configured) {
    const sibling =
      name === "ffmpeg"
        ? configured
        : join(configured, "..", `ffprobe${extname(configured)}`);
    return existsSync(sibling) ? sibling : null;
  }
  const onPath = Bun.which(name);
  if (onPath) return onPath;
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  const places = [
    process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", exe)
      : "",
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
  ].filter(Boolean);
  return places.find((place) => existsSync(place)) ?? null;
}

export function detectVideoSetup(environment: {
  enabled: boolean;
  mediaDir?: string;
  ffmpeg?: string;
  font?: string;
}): VideoSetup {
  const ffmpeg = findTool("ffmpeg", environment.ffmpeg);
  return {
    enabled: environment.enabled,
    mediaDir: environment.mediaDir ?? join(homedir(), "ArkAgent", "media"),
    ffmpeg,
    ffprobe: ffmpeg
      ? findTool("ffprobe", environment.ffmpeg ? ffmpeg : undefined)
      : null,
    font:
      (environment.font && existsSync(environment.font)
        ? environment.font
        : FONT_CANDIDATES.find((font) => existsSync(font))) ?? null,
  };
}

let setup: VideoSetup = {
  enabled: false,
  mediaDir: "",
  ffmpeg: null,
  ffprobe: null,
  font: null,
};

/** Wired once at start (index.ts); tests swap it. */
export function useVideoSetup(value: VideoSetup): void {
  setup = value;
}

export function videoSetup(): VideoSetup {
  return setup;
}

/** Why the tools cannot run here, as a sentence, or null when they can. */
export function videoUnavailable(current = setup): string | null {
  if (!current.enabled) {
    return "Video editing runs in the ArkAgent desktop app on the business's own computer only.";
  }
  if (!current.ffmpeg || !current.ffprobe) {
    return "FFmpeg is not installed on this computer. Install it (Windows: winget install Gyan.FFmpeg; Mac: brew install ffmpeg), then restart ArkAgent.";
  }
  if (!current.font) {
    return "No font with Greek letters was found on this computer for captions.";
  }
  return null;
}

// ---- running FFmpeg ----------------------------------------------------------------------------

async function run(
  command: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const child = Bun.spawn([command, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const timer = setTimeout(() => child.kill(), RUN_TIMEOUT_MS);
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  return { ok: code === 0, stdout, stderr };
}

let encoderCache: { ffmpeg: string; args: string[] } | null = null;

/** The best H.264 encoder this FFmpeg has, with matching quality options. */
async function encoder(ffmpeg: string): Promise<string[]> {
  if (encoderCache?.ffmpeg === ffmpeg) return encoderCache.args;
  const listed = (await run(ffmpeg, ["-hide_banner", "-encoders"])).stdout;
  const has = (name: string) => new RegExp(`\\s${name}\\s`).test(listed);
  const args = has("libx264")
    ? ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"]
    : has("h264_videotoolbox")
      ? ["-c:v", "h264_videotoolbox", "-b:v", "8M"]
      : has("h264_mf")
        ? ["-c:v", "h264_mf", "-b:v", "8M"]
        : has("libopenh264")
          ? ["-c:v", "libopenh264", "-b:v", "8M"]
          : ["-c:v", "mpeg4", "-q:v", "3"];
  encoderCache = { ffmpeg, args };
  return args;
}

async function probe(
  file: string,
): Promise<{ seconds: number; audio: boolean; video: boolean }> {
  const ffprobe = setup.ffprobe as string;
  const result = await run(ffprobe, [
    "-v",
    "error",
    "-show_entries",
    "format=duration:stream=codec_type",
    "-of",
    "json",
    file,
  ]);
  if (!result.ok)
    throw new VideoPlanError(`${basename(file)} could not be read.`);
  const parsed = JSON.parse(result.stdout) as {
    format?: { duration?: string };
    streams?: { codec_type?: string }[];
  };
  const types = new Set((parsed.streams ?? []).map((s) => s.codec_type));
  return {
    seconds: Number(parsed.format?.duration ?? 0) || 0,
    audio: types.has("audio"),
    video: types.has("video"),
  };
}

/** A path for inside a filter graph: forward slashes, and `:` `'` `\` escaped. */
function filterPath(path: string): string {
  return `'${path
    .replace(/\\/g, "/")
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:")}'`;
}

// ---- the plan ----------------------------------------------------------------------------------

export type Piece = {
  file: string;
  from?: number;
  to?: number;
  seconds?: number;
  zoom?: boolean;
  caption?: string;
};

export type VideoPlan = {
  name: string;
  sizes: VideoSize[];
  pieces: Piece[];
  title?: { text: string; seconds: number };
  end?: { text: string; seconds: number };
  subtitles: { from: number; to: number; text: string }[];
  music?: { file: string; volume: number };
  voiceover?: { file: string };
  keepClipSound: boolean;
};

type Resolved = Piece & {
  path: string;
  kind: "video" | "image";
  length: number;
  audio: boolean;
};

function num(value: unknown, what: string, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new VideoPlanError(`${what} must be a number from ${min} to ${max}.`);
  }
  return n;
}

function words(value: unknown, what: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new VideoPlanError(`${what} needs some text.`);
  }
  if (value.length > MAX_TEXT) {
    throw new VideoPlanError(`${what} is longer than ${MAX_TEXT} characters.`);
  }
  // One or two lines; control characters other than a line break are dropped.
  return [...value]
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return ch === "\n" || (code >= 0x20 && code !== 0x7f);
    })
    .join("")
    .trim();
}

const GREEK: Record<string, string> = {
  α: "a",
  β: "v",
  γ: "g",
  δ: "d",
  ε: "e",
  ζ: "z",
  η: "i",
  θ: "th",
  ι: "i",
  κ: "k",
  λ: "l",
  μ: "m",
  ν: "n",
  ξ: "x",
  ο: "o",
  π: "p",
  ρ: "r",
  σ: "s",
  ς: "s",
  τ: "t",
  υ: "y",
  φ: "f",
  χ: "ch",
  ψ: "ps",
  ω: "o",
};

/**
 * A file name from whatever the plan calls the video: Greek written in Latin letters, anything
 * else that is not a letter or digit turned into a hyphen. «Δοκιμή DT» becomes `dokimi-dt` (#109,
 * DT 16 Nov: a Greek name was approved and then refused). Empty when nothing usable is left.
 */
export function fileNameFrom(value: unknown): string {
  if (typeof value !== "string") return "";
  const latin = [...value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()]
    .map((ch) => GREEK[ch] ?? ch)
    .join("");
  return latin
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

/** Reads the model's arguments into a plan, refusing anything outside the limits. */
export function planFrom(args: Record<string, unknown>): VideoPlan {
  const name = fileNameFrom(args.name);
  if (!name) {
    throw new VideoPlanError(
      "Give the video a short name, e.g. assyrtiko-reel or «Ασύρτικο reel».",
    );
  }
  const sizes = Array.isArray(args.sizes) ? args.sizes : ["9:16"];
  if (
    sizes.length === 0 ||
    sizes.length > 4 ||
    !sizes.every((s) => s in SIZES)
  ) {
    throw new VideoPlanError("Sizes are any of 9:16, 1:1, 4:5 and 16:9.");
  }
  const rawPieces = Array.isArray(args.pieces) ? args.pieces : [];
  if (rawPieces.length === 0 || rawPieces.length > MAX_PIECES) {
    throw new VideoPlanError(`A video has 1 to ${MAX_PIECES} pieces.`);
  }
  const pieces = rawPieces.map((raw, index): Piece => {
    const piece = (raw ?? {}) as Record<string, unknown>;
    if (typeof piece.file !== "string" || !piece.file.trim()) {
      throw new VideoPlanError(`Piece ${index + 1} names no file.`);
    }
    return {
      file: piece.file.trim(),
      ...(piece.from !== undefined
        ? { from: num(piece.from, `Piece ${index + 1}'s start`, 0, 3600) }
        : {}),
      ...(piece.to !== undefined
        ? { to: num(piece.to, `Piece ${index + 1}'s end`, 0, 3600) }
        : {}),
      ...(piece.seconds !== undefined
        ? {
            seconds: num(piece.seconds, `Piece ${index + 1}'s length`, 0.5, 30),
          }
        : {}),
      zoom: piece.zoom !== false,
      ...(piece.caption !== undefined && piece.caption !== ""
        ? { caption: words(piece.caption, `Piece ${index + 1}'s caption`) }
        : {}),
    };
  });
  const card = (value: unknown, what: string) => {
    if (value === undefined || value === null) return undefined;
    const raw = value as Record<string, unknown>;
    return {
      text: words(raw.text, what),
      seconds:
        raw.seconds === undefined
          ? 2.5
          : num(raw.seconds, `${what}'s length`, 1, 6),
    };
  };
  const rawSubs = Array.isArray(args.subtitles) ? args.subtitles : [];
  if (rawSubs.length > MAX_SUBTITLES) {
    throw new VideoPlanError(`At most ${MAX_SUBTITLES} subtitles.`);
  }
  const subtitles = rawSubs.map((raw, index) => {
    const sub = (raw ?? {}) as Record<string, unknown>;
    const from = num(sub.from, `Subtitle ${index + 1}'s start`, 0, MAX_SECONDS);
    const to = num(sub.to, `Subtitle ${index + 1}'s end`, 0, MAX_SECONDS);
    if (to <= from)
      throw new VideoPlanError(`Subtitle ${index + 1} ends before it starts.`);
    return { from, to, text: words(sub.text, `Subtitle ${index + 1}`) };
  });
  const music =
    args.music && typeof (args.music as { file?: unknown }).file === "string"
      ? {
          file: String((args.music as { file: string }).file).trim(),
          volume:
            (args.music as { volume?: unknown }).volume === undefined
              ? 0.25
              : num(
                  (args.music as { volume: unknown }).volume,
                  "The music volume",
                  0.02,
                  1,
                ),
        }
      : undefined;
  const voiceover =
    args.voiceover &&
    typeof (args.voiceover as { file?: unknown }).file === "string"
      ? { file: String((args.voiceover as { file: string }).file).trim() }
      : undefined;
  const title = card(args.title, "The title card");
  const end = card(args.end, "The end card");
  return {
    name,
    sizes: [...new Set(sizes as VideoSize[])],
    pieces,
    ...(title ? { title } : {}),
    ...(end ? { end } : {}),
    subtitles,
    ...(music ? { music } : {}),
    ...(voiceover ? { voiceover } : {}),
    keepClipSound: args.keepClipSound !== false,
  };
}

/** A file named in a plan, as a real path inside `media/in`, or a refusal. */
async function inside(
  inDir: string,
  name: string,
  kinds: Set<string>,
): Promise<string> {
  const root = await realpath(inDir);
  let real: string;
  try {
    real = await realpath(join(root, name));
  } catch {
    throw new VideoPlanError(`There is no file ${name} in media/in.`);
  }
  if (real !== root && !real.startsWith(root + sep)) {
    throw new VideoPlanError(`${name} is not inside media/in.`);
  }
  if (!kinds.has(extname(real).toLowerCase())) {
    throw new VideoPlanError(`${name} is not a file type this step takes.`);
  }
  return real;
}

// ---- the tools ---------------------------------------------------------------------------------

const TOOLS: readonly McpTool[] = Object.freeze([
  {
    name: "list_media",
    description:
      "List the footage, photos and audio the business put in ArkAgent/media/in on this computer, with each file's length. Use the names exactly as listed in render_video.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "render_video",
    description: [
      "Make the final cut as MP4 files from an edit plan, on this computer. The person sees the whole plan on an approval card first; nothing renders until they approve, and nothing is ever published by you.",
      "pieces: in order; a video clip uses from/to (seconds) to trim, a photo uses seconds (default 3) and zoom (slow Ken Burns, default on). caption: short text over that piece.",
      "title / end: full-screen text cards. subtitles: burned-in lines with from/to in seconds of the finished video. music: a file played under everything at volume 0.02-1 (default 0.25). voiceover: a spoken track from the start.",
      `sizes: any of 9:16, 1:1, 4:5, 16:9. At most ${MAX_SECONDS} seconds and ${MAX_PIECES} pieces. Files must be in media/in.`,
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Short output name, e.g. assyrtiko-reel; Greek is written in Latin letters.",
        },
        sizes: {
          type: "array",
          items: { type: "string", enum: Object.keys(SIZES) },
        },
        pieces: {
          type: "array",
          items: {
            type: "object",
            properties: {
              file: { type: "string" },
              from: { type: "number" },
              to: { type: "number" },
              seconds: { type: "number" },
              zoom: { type: "boolean" },
              caption: { type: "string" },
            },
            required: ["file"],
          },
        },
        title: {
          type: "object",
          properties: { text: { type: "string" }, seconds: { type: "number" } },
        },
        end: {
          type: "object",
          properties: { text: { type: "string" }, seconds: { type: "number" } },
        },
        subtitles: {
          type: "array",
          items: {
            type: "object",
            properties: {
              from: { type: "number" },
              to: { type: "number" },
              text: { type: "string" },
            },
            required: ["from", "to", "text"],
          },
        },
        music: {
          type: "object",
          properties: { file: { type: "string" }, volume: { type: "number" } },
        },
        voiceover: { type: "object", properties: { file: { type: "string" } } },
        keepClipSound: { type: "boolean" },
      },
      required: ["name", "sizes", "pieces"],
    },
  },
]);

export const listNeedsCredential = false;

export async function listTools(): Promise<McpTool[]> {
  return TOOLS.map((tool) => ({ ...tool }));
}

function answer(text: string, isError = false): McpCallResult {
  const truncated = text.length > MAX_RESULT_CHARS;
  return {
    text: truncated ? cutAtCodeUnits(text, MAX_RESULT_CHARS) : text,
    isError,
    truncated,
  };
}

function kindOf(name: string): "video" | "image" | "audio" | null {
  const ext = extname(name).toLowerCase();
  if (VIDEO_EXT.has(ext)) return "video";
  if (IMAGE_EXT.has(ext)) return "image";
  if (AUDIO_EXT.has(ext)) return "audio";
  return null;
}

async function listMedia(): Promise<string> {
  const inDir = join(setup.mediaDir, "in");
  await mkdir(inDir, { recursive: true });
  await mkdir(join(setup.mediaDir, "out"), { recursive: true });
  const found: string[] = [];
  const walk = async (dir: string, depth: number) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (found.length >= 200) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory() && depth < 2) await walk(full, depth + 1);
      else if (entry.isFile() && kindOf(entry.name)) found.push(full);
    }
  };
  await walk(inDir, 0);
  if (found.length === 0) {
    return `media/in is empty. Ask the person to copy their footage, photos and music into ${inDir}.`;
  }
  const lines: string[] = [];
  for (const file of found.sort()) {
    const kind = kindOf(file);
    const size = (await stat(file)).size;
    let length = "";
    if (kind !== "image") {
      try {
        length = ` · ${(await probe(file)).seconds.toFixed(1)} s`;
      } catch {
        length = " · unreadable";
      }
    }
    lines.push(
      `${relative(inDir, file).split(sep).join("/")} · ${kind} · ${(size / 1_048_576).toFixed(1)} MB${length}`,
    );
  }
  return lines.join("\n");
}

let queue: Promise<unknown> = Promise.resolve();

/** One render at a time on this computer. */
function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
}

async function textFile(dir: string, text: string): Promise<string> {
  const path = join(dir, `t${Math.random().toString(36).slice(2)}.txt`);
  await writeFile(path, text, "utf8");
  return path;
}

async function drawText(
  dir: string,
  text: string,
  size: { width: number; height: number },
  where: "caption" | "subtitle" | "card",
  enable?: { from: number; to: number },
): Promise<string> {
  const file = await textFile(dir, text);
  const fontsize = Math.round(
    (where === "card" ? size.width / 14 : size.width / 22) * 1,
  );
  // A piece's caption sits above the subtitles, so the two never cover each other.
  const y =
    where === "card"
      ? "(h-text_h)/2"
      : where === "caption"
        ? "h*0.70-text_h"
        : "h*0.88-text_h";
  return [
    `drawtext=fontfile=${filterPath(setup.font as string)}`,
    `textfile=${filterPath(file)}`,
    "fontcolor=white",
    `fontsize=${fontsize}`,
    "line_spacing=8",
    ...(where !== "card"
      ? ["box=1", "boxcolor=black@0.45", "boxborderw=18"]
      : []),
    "x=(w-text_w)/2",
    `y=${y}`,
    ...(enable ? [`enable='between(t,${enable.from},${enable.to})'`] : []),
  ].join(":");
}

async function renderOne(
  plan: VideoPlan,
  resolved: Resolved[],
  sizeKey: VideoSize,
  work: string,
  extra: { music?: string; voiceover?: string },
): Promise<{ file: string; seconds: number }> {
  const ffmpeg = setup.ffmpeg as string;
  const size = SIZES[sizeKey];
  const { width: W, height: H } = size;
  const enc = await encoder(ffmpeg);
  const common = [
    ...enc,
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(FPS),
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-ar",
    "48000",
    "-ac",
    "2",
  ];
  const fit = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1`;
  const segments: string[] = [];
  let total = 0;

  const card = async (text: string, seconds: number, index: string) => {
    const out = join(work, `${sizeKey.replace(":", "x")}-${index}.mp4`);
    const vf = `${await drawText(work, text, size, "card")},format=yuv420p`;
    const result = await run(ffmpeg, [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=black:s=${W}x${H}:r=${FPS}:d=${seconds}`,
      "-f",
      "lavfi",
      "-i",
      `anullsrc=r=48000:cl=stereo`,
      "-t",
      String(seconds),
      "-vf",
      vf,
      ...common,
      "-shortest",
      out,
    ]);
    if (!result.ok) throw new Error(`card: ${result.stderr.slice(-400)}`);
    segments.push(out);
    total += seconds;
  };

  if (plan.title) await card(plan.title.text, plan.title.seconds, "title");
  for (const [index, piece] of resolved.entries()) {
    const out = join(work, `${sizeKey.replace(":", "x")}-${index}.mp4`);
    const caption = piece.caption
      ? `,${await drawText(work, piece.caption, size, "caption")}`
      : "";
    let args: string[];
    let seconds: number;
    if (piece.kind === "image") {
      seconds = piece.seconds ?? 3;
      const frames = Math.round(seconds * FPS);
      const motion = piece.zoom
        ? `scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,crop=${W * 2}:${H * 2},zoompan=z='min(zoom+0.0009,1.15)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${FPS},setsar=1`
        : `${fit},fps=${FPS}`;
      args = [
        "-y",
        "-loop",
        "1",
        "-t",
        String(seconds),
        "-i",
        piece.path,
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=48000:cl=stereo",
        "-t",
        String(seconds),
        "-filter_complex",
        `[0:v]${motion}${caption},format=yuv420p[v]`,
        "-map",
        "[v]",
        "-map",
        "1:a",
        ...common,
        "-shortest",
        out,
      ];
    } else {
      const from = piece.from ?? 0;
      const to = Math.min(piece.to ?? piece.length, piece.length);
      seconds = to - from;
      if (seconds <= 0.2)
        throw new VideoPlanError(`${piece.file}: the cut is empty.`);
      const withSound = plan.keepClipSound && piece.audio;
      args = [
        "-y",
        "-ss",
        String(from),
        "-t",
        String(seconds),
        "-i",
        piece.path,
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=48000:cl=stereo",
        "-t",
        String(seconds),
        "-filter_complex",
        `[0:v]${fit},fps=${FPS}${caption},format=yuv420p[v]${withSound ? ";[0:a]aresample=48000,aformat=channel_layouts=stereo[a]" : ""}`,
        "-map",
        "[v]",
        "-map",
        withSound ? "[a]" : "1:a",
        ...common,
        "-shortest",
        out,
      ];
    }
    const result = await run(ffmpeg, args);
    if (!result.ok)
      throw new Error(`${piece.file}: ${result.stderr.slice(-400)}`);
    segments.push(out);
    total += seconds;
  }
  if (plan.end) await card(plan.end.text, plan.end.seconds, "end");

  // Join the pieces, then lay subtitles, music and voice-over over the whole, and even out loudness.
  const list = join(work, `${sizeKey.replace(":", "x")}-list.txt`);
  await writeFile(
    list,
    segments
      .map((s) => `file '${s.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`)
      .join("\n"),
  );
  const joined = join(work, `${sizeKey.replace(":", "x")}-joined.mp4`);
  const concat = await run(ffmpeg, [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    list,
    "-c",
    "copy",
    joined,
  ]);
  if (!concat.ok) throw new Error(`join: ${concat.stderr.slice(-400)}`);

  const inputs = ["-i", joined];
  const audio: string[] = ["[0:a]volume=1[a0]"];
  const mix = ["[a0]"];
  if (extra.music) {
    inputs.push("-stream_loop", "-1", "-i", extra.music);
    const at = inputs.filter((x) => x === "-i").length - 1;
    audio.push(
      `[${at}:a]atrim=0:${total},volume=${plan.music?.volume ?? 0.25},aresample=48000[m]`,
    );
    mix.push("[m]");
  }
  if (extra.voiceover) {
    inputs.push("-i", extra.voiceover);
    const at = inputs.filter((x) => x === "-i").length - 1;
    audio.push(`[${at}:a]aresample=48000[vo]`);
    mix.push("[vo]");
  }
  let video = "[0:v]null";
  for (const sub of plan.subtitles) {
    if (sub.from >= total) continue;
    video += `,${await drawText(work, sub.text, size, "subtitle", { from: sub.from, to: Math.min(sub.to, total) })}`;
  }
  const graph = [
    `${video}[v]`,
    ...audio,
    `${mix.join("")}amix=inputs=${mix.length}:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[a]`,
  ].join(";");
  const outDir = join(setup.mediaDir, "out");
  await mkdir(outDir, { recursive: true });
  const final = join(outDir, `${plan.name}-${size.label}.mp4`);
  const partial = `${final}.part.mp4`;
  const last = await run(ffmpeg, [
    "-y",
    ...inputs,
    "-filter_complex",
    graph,
    "-map",
    "[v]",
    "-map",
    "[a]",
    ...common,
    "-t",
    String(total),
    "-movflags",
    "+faststart",
    partial,
  ]);
  if (!last.ok) throw new Error(`finish: ${last.stderr.slice(-400)}`);
  await rename(partial, final);
  return { file: final, seconds: total };
}

export async function render(
  plan: VideoPlan,
): Promise<{ file: string; seconds: number }[]> {
  const inDir = join(setup.mediaDir, "in");
  await mkdir(inDir, { recursive: true });
  const resolved: Resolved[] = [];
  let total = (plan.title?.seconds ?? 0) + (plan.end?.seconds ?? 0);
  for (const piece of plan.pieces) {
    const path = await inside(
      inDir,
      piece.file,
      new Set([...VIDEO_EXT, ...IMAGE_EXT]),
    );
    const kind = IMAGE_EXT.has(extname(path).toLowerCase()) ? "image" : "video";
    if (kind === "image") {
      resolved.push({
        ...piece,
        path,
        kind,
        length: piece.seconds ?? 3,
        audio: false,
      });
      total += piece.seconds ?? 3;
    } else {
      const probed = await probe(path);
      if (!probed.video)
        throw new VideoPlanError(`${piece.file} has no picture.`);
      const from = piece.from ?? 0;
      const to = Math.min(piece.to ?? probed.seconds, probed.seconds);
      if (from >= to)
        throw new VideoPlanError(
          `${piece.file}: the start is after the end (${probed.seconds.toFixed(1)} s long).`,
        );
      resolved.push({
        ...piece,
        path,
        kind,
        length: probed.seconds,
        audio: probed.audio,
      });
      total += to - from;
    }
  }
  if (total > MAX_SECONDS) {
    throw new VideoPlanError(
      `The cut is ${total.toFixed(1)} seconds; the most is ${MAX_SECONDS}. Trim some pieces.`,
    );
  }
  const music = plan.music
    ? await inside(inDir, plan.music.file, AUDIO_EXT)
    : undefined;
  const voiceover = plan.voiceover
    ? await inside(inDir, plan.voiceover.file, AUDIO_EXT)
    : undefined;
  const work = await mkdtemp(join(tmpdir(), "ark-video-"));
  try {
    const outputs: { file: string; seconds: number }[] = [];
    for (const size of plan.sizes) {
      outputs.push(
        await renderOne(plan, resolved, size, work, {
          ...(music ? { music } : {}),
          ...(voiceover ? { voiceover } : {}),
        }),
      );
    }
    return outputs;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

function seconds(value: number): string {
  return `${Number(value.toFixed(1))} s`;
}

/** The plan in one plain sentence for the approval card (#109, DT 16 Nov: it showed raw JSON). */
export function planSummary(plan: VideoPlan): string {
  const pieces = plan.pieces.map((piece) => {
    const span =
      piece.from !== undefined || piece.to !== undefined
        ? ` ${piece.from ?? 0}–${piece.to ?? "end"} s`
        : piece.seconds !== undefined
          ? ` for ${seconds(piece.seconds)}`
          : "";
    const caption = piece.caption ? ` with caption «${piece.caption}»` : "";
    return `${piece.file}${span}${caption}`;
  });
  return [
    `Make the video "${plan.name}" in ${plan.sizes.join(", ")}`,
    `from ${pieces.join("; ")}`,
    ...(plan.title ? [`title card «${plan.title.text}»`] : []),
    ...(plan.end ? [`end card «${plan.end.text}»`] : []),
    ...(plan.subtitles.length > 0
      ? [`${plan.subtitles.length} subtitles`]
      : []),
    ...(plan.music ? [`music ${plan.music.file}`] : []),
    ...(plan.voiceover ? [`voice-over ${plan.voiceover.file}`] : []),
    "saved in media/out on this computer; nothing is published",
  ].join(" · ");
}

/**
 * Checks a render before it is held for approval, so a plan that would fail is sent back to the
 * employee instead of to a person (#109, DT 16 Nov). The files must be in media/in.
 */
export async function prepareCall(
  _connection: { actorId?: string; botId?: string; threadId?: string },
  toolName: string,
  args: Record<string, unknown>,
): Promise<{
  args: Record<string, unknown>;
  shown?: Record<string, string>;
  summary?: string;
  refused?: string;
}> {
  if (toolName !== "render_video") return { args };
  const unavailable = videoUnavailable();
  if (unavailable) return { args, refused: unavailable };
  try {
    const plan = planFrom(args);
    const inDir = join(setup.mediaDir, "in");
    await mkdir(inDir, { recursive: true });
    for (const piece of plan.pieces) {
      await inside(inDir, piece.file, new Set([...VIDEO_EXT, ...IMAGE_EXT]));
    }
    if (plan.music) await inside(inDir, plan.music.file, AUDIO_EXT);
    if (plan.voiceover) await inside(inDir, plan.voiceover.file, AUDIO_EXT);
    const summary = planSummary(plan);
    return {
      args: { ...args, name: plan.name },
      summary,
      shown: { name: plan.name, pieces: summary },
    };
  } catch (error) {
    return {
      args,
      refused:
        error instanceof VideoPlanError
          ? `${error.message} Nothing was asked of the person; correct the plan and call render_video again.`
          : "The plan could not be checked. Try again.",
    };
  }
}

export async function callTool(
  _connection: { url: string },
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  const unavailable = videoUnavailable();
  if (unavailable) return answer(unavailable, true);
  try {
    if (toolName === "list_media") return answer(await listMedia());
    if (toolName === "render_video") {
      const plan = planFrom(args);
      const outputs = await oneAtATime(() => render(plan));
      return answer(
        [
          `Rendered ${outputs.length} file${outputs.length === 1 ? "" : "s"}, ${outputs[0]?.seconds.toFixed(1)} seconds each, in media/out:`,
          ...outputs.map((o) => `- ${basename(o.file)}`),
          "Nothing was published. Ask the person to watch each file before it goes anywhere.",
        ].join("\n"),
      );
    }
    return answer(`There is no video tool called ${toolName}.`, true);
  } catch (error) {
    if (error instanceof VideoPlanError) return answer(error.message, true);
    console.error(
      "Video render failed:",
      error instanceof Error ? error.message : error,
    );
    return answer(
      "FFmpeg could not make this video. Check the files are complete and try a simpler plan.",
      true,
    );
  }
}
