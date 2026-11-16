/**
 * Video editing (#109) on this machine: plans read strictly, files only from media/in, and
 * a real render by FFmpeg from clips, a still and a tone FFmpeg itself generates. The render tests
 * need FFmpeg on this machine (CI installs it); without it they report that and stop.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogueEntry } from "../src/plugins/catalogue";
import {
  callTool,
  detectVideoSetup,
  fileNameFrom,
  listTools,
  planFrom,
  prepareCall,
  useVideoSetup,
  VideoPlanError,
  videoUnavailable,
} from "../src/plugins/video";

let root = "";
const setup = detectVideoSetup({ enabled: true });
const haveFfmpeg = Boolean(setup.ffmpeg && setup.ffprobe && setup.font);

async function make(args: string[]) {
  const child = Bun.spawn([
    setup.ffmpeg as string,
    "-y",
    "-loglevel",
    "error",
    ...args,
  ]);
  expect(await child.exited).toBe(0);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ark-video-test-"));
  await mkdir(join(root, "in"), { recursive: true });
  useVideoSetup({ ...setup, mediaDir: root });
  if (!haveFfmpeg) return;
  const inDir = join(root, "in");
  await make([
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=640x360:rate=25:duration=3",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=3",
    "-shortest",
    join(inDir, "cellar.mp4"),
  ]);
  await make([
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=1280x720:rate=25:duration=1",
    "-frames:v",
    "1",
    join(inDir, "bottle.png"),
  ]);
  await make([
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:duration=10",
    join(inDir, "music.wav"),
  ]);
});

afterAll(async () => {
  if (process.env.ARK_VIDEO_KEEP) {
    console.log(`video.test.ts: kept ${root}`);
    return;
  }
  await rm(root, { recursive: true, force: true });
});

const call = (tool: string, args: Record<string, unknown> = {}) =>
  callTool({ url: "builtin://video" }, tool, args);

describe("video editing (#109)", () => {
  test("offers listing and rendering, and rendering waits on an approval card; there is no publish tool", async () => {
    const names = (await listTools()).map((tool) => tool.name).sort();
    expect(names).toEqual(["list_media", "render_video"]);
    expect(catalogueEntry("video")?.writeTools).toEqual(["render_video"]);
  });

  test("is off where there is no desktop, and says how to get FFmpeg when it is missing", async () => {
    expect(videoUnavailable({ ...setup, enabled: false })).toContain(
      "desktop app",
    );
    expect(videoUnavailable({ ...setup, ffmpeg: null })).toContain(
      "winget install Gyan.FFmpeg",
    );
  });

  test("a Greek or spaced name is written in Latin letters, so it never fails after approval", () => {
    expect(fileNameFrom("Δοκιμή DT")).toBe("dokimi-dt");
    expect(fileNameFrom("Ασύρτικο 2023 reel!")).toBe("asyrtiko-2023-reel");
    expect(fileNameFrom("  ")).toBe("");
  });

  test.if(haveFfmpeg)(
    "a plan is checked before its approval card: a bad one goes back to the employee, a good one gets a plain summary",
    async () => {
      const missing = await prepareCall({}, "render_video", {
        name: "x",
        sizes: ["9:16"],
        pieces: [{ file: "nowhere.mp4" }],
      });
      expect(missing.refused).toContain("There is no file nowhere.mp4");
      expect(missing.refused).toContain("Nothing was asked of the person");

      const good = await prepareCall({}, "render_video", {
        name: "Δοκιμή DT",
        sizes: ["9:16"],
        pieces: [{ file: "cellar.mp4", from: 0, to: 2, caption: "Δοκιμή DT" }],
      });
      expect(good.refused).toBeUndefined();
      expect(good.args.name).toBe("dokimi-dt");
      expect(good.summary).toContain('Make the video "dokimi-dt" in 9:16');
      expect(good.summary).toContain(
        "cellar.mp4 0–2 s with caption «Δοκιμή DT»",
      );
      expect(good.summary).toContain("nothing is published");
      expect(good.summary).not.toContain("{");
      // Other tools are not checked here.
      expect(await prepareCall({}, "list_media", {})).toEqual({ args: {} });
    },
  );

  test("reads a plan strictly", () => {
    const plan = planFrom({
      name: "Reel-1",
      sizes: ["9:16", "1:1"],
      pieces: [{ file: "a.mp4" }],
    });
    expect(plan.name).toBe("reel-1");
    expect(plan.keepClipSound).toBe(true);
    expect(() =>
      planFrom({ name: "../", sizes: ["9:16"], pieces: [{ file: "a.mp4" }] }),
    ).toThrow(VideoPlanError);
    expect(() =>
      planFrom({ name: "x", sizes: ["4:3"], pieces: [{ file: "a.mp4" }] }),
    ).toThrow(VideoPlanError);
    expect(() => planFrom({ name: "x", sizes: ["9:16"], pieces: [] })).toThrow(
      VideoPlanError,
    );
    expect(() =>
      planFrom({
        name: "x",
        sizes: ["9:16"],
        pieces: [{ file: "a.mp4" }],
        subtitles: [{ from: 3, to: 1, text: "x" }],
      }),
    ).toThrow(VideoPlanError);
  });

  test.if(haveFfmpeg)(
    "refuses a file outside media/in, even through a link",
    async () => {
      await writeFile(join(root, "secret.mp4"), "x");
      await symlink(
        join(root, "secret.mp4"),
        join(root, "in", "link.mp4"),
      ).catch(() => undefined);
      for (const file of ["../secret.mp4", "link.mp4"]) {
        const result = await call("render_video", {
          name: "x",
          sizes: ["9:16"],
          pieces: [{ file }],
        });
        expect(result.isError).toBe(true);
        expect(result.text).toContain("not inside media/in");
      }
    },
  );

  test.if(haveFfmpeg)("refuses a cut over 90 seconds", async () => {
    const result = await call("render_video", {
      name: "long",
      sizes: ["9:16"],
      pieces: Array.from({ length: 4 }, () => ({
        file: "bottle.png",
        seconds: 30,
      })),
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("the most is 90");
  });

  test.if(haveFfmpeg)(
    "lists media/in and renders a cut with a title, a still, captions, subtitles, music and an end card in two sizes",
    async () => {
      const listed = await call("list_media");
      expect(listed.text).toContain("cellar.mp4 · video");
      expect(listed.text).toContain("bottle.png · image");
      const result = await call("render_video", {
        name: "assyrtiko-reel",
        sizes: ["9:16", "16:9"],
        title: { text: "Ασύρτικο 2023", seconds: 1.5 },
        pieces: [
          {
            file: "cellar.mp4",
            from: 0.5,
            to: 2.5,
            caption: "Από το κελάρι μας",
          },
          { file: "bottle.png", seconds: 2, caption: "Λευκό, ξηρό" },
        ],
        subtitles: [{ from: 1.5, to: 3, text: "Δροσερό και αρωματικό" }],
        music: { file: "music.wav", volume: 0.2 },
        end: { text: "Απολαύστε υπεύθυνα.", seconds: 1.5 },
      });
      expect(result.isError).toBe(false);
      expect(result.text).toContain("assyrtiko-reel-9x16.mp4");
      expect(result.text).toContain("Nothing was published");
      for (const [label, width, height] of [
        ["9x16", 1080, 1920],
        ["16x9", 1920, 1080],
      ] as const) {
        const probe = Bun.spawnSync([
          setup.ffprobe as string,
          "-v",
          "error",
          "-show_entries",
          "stream=codec_type,width,height:format=duration",
          "-of",
          "json",
          join(root, "out", `assyrtiko-reel-${label}.mp4`),
        ]);
        const info = JSON.parse(probe.stdout.toString()) as {
          streams: { codec_type: string; width?: number; height?: number }[];
          format: { duration: string };
        };
        const video = info.streams.find((s) => s.codec_type === "video");
        expect(video?.width).toBe(width);
        expect(video?.height).toBe(height);
        expect(info.streams.some((s) => s.codec_type === "audio")).toBe(true);
        // 1.5 title + 2 clip + 2 still + 1.5 end.
        expect(Number(info.format.duration)).toBeGreaterThan(6.5);
        expect(Number(info.format.duration)).toBeLessThan(7.6);
      }
    },
    120_000,
  );

  test.if(!haveFfmpeg)(
    "FFmpeg is not on this machine, so the render tests did not run",
    () => {
      console.warn(
        "video.test.ts: FFmpeg not found; render tests not run on this machine.",
      );
    },
  );
});
