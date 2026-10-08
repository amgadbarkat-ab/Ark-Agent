import { describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Runs `scripts/hub.sh <command>` in a throwaway checkout holding only the given `.env`. */
async function runHub(command: string, envLines: string[] | null) {
  const directory = (
    await Bun.$`mktemp -d ${tmpdir()}/ark-hub-script-XXXXXX`.text()
  ).trim();
  try {
    const scripts = join(directory, "scripts");
    await mkdir(scripts, { recursive: true });
    for (const file of ["hub.sh", "require-bash.sh"]) {
      const target = join(scripts, file);
      await writeFile(target, await readFile(`scripts/${file}`));
      await chmod(target, 0o755);
    }
    if (envLines) {
      await writeFile(join(directory, ".env"), `${envLines.join("\n")}\n`);
    }
    const child = Bun.spawn({
      cmd: ["bash", "scripts/hub.sh", command],
      cwd: directory,
      env: { PATH: process.env.PATH ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
    ]);
    const env = envLines ? await readFile(join(directory, ".env"), "utf8") : "";
    const read = (name: string) =>
      env.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1];
    // Run again against the same directory is the caller's job; return what it needs for that.
    return { exitCode, stdout, env, read, directory };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("scripts/hub.sh secrets", () => {
  test("generates the hub's keys and points the API server at the hub", async () => {
    const { exitCode, read } = await runHub("secrets", [
      "DATABASE_URL=postgres://u:p@localhost:5432/app",
      "BOT_PROVIDER=anthropic",
    ]);
    expect(exitCode).toBe(0);
    const apiKey = read("HUB_API_KEY");
    const joinSecret = read("HUB_JOIN_SECRET");
    expect(apiKey?.length).toBeGreaterThanOrEqual(32);
    expect(joinSecret?.length).toBeGreaterThanOrEqual(32);
    expect(apiKey).not.toBe(joinSecret);
    expect(read("INTELLIGENCE_API_KEY")).toBe(apiKey);
    expect(read("INTELLIGENCE_API_URL")).toBe("http://localhost:7100");
    expect(read("INTELLIGENCE_GATEWAY_WS_URL")).toBe("ws://localhost:7100");
    expect(read("COPILOTKIT_TELEMETRY_DISABLED")).toBe("true");
    // Everything else the person set is left alone.
    expect(read("DATABASE_URL")).toBe("postgres://u:p@localhost:5432/app");
    expect(read("BOT_PROVIDER")).toBe("anthropic");
  });

  test("keeps keys that already exist, so a second run changes nothing", async () => {
    const { read } = await runHub("secrets", [
      `HUB_API_KEY=${"a".repeat(44)}`,
      `HUB_JOIN_SECRET=${"b".repeat(44)}`,
      "INTELLIGENCE_API_KEY=somebody-elses-old-value",
    ]);
    expect(read("HUB_API_KEY")).toBe("a".repeat(44));
    expect(read("HUB_JOIN_SECRET")).toBe("b".repeat(44));
    // The API server's copy is corrected to match the hub's, never the other way round.
    expect(read("INTELLIGENCE_API_KEY")).toBe("a".repeat(44));
  });

  test("points at the port the hub is configured to use", async () => {
    const { read } = await runHub("secrets", ["HUB_PORT=7555"]);
    expect(read("INTELLIGENCE_API_URL")).toBe("http://localhost:7555");
    expect(read("INTELLIGENCE_GATEWAY_WS_URL")).toBe("ws://localhost:7555");
  });

  test("an empty line left by .env.example is filled, not duplicated", async () => {
    const { env } = await runHub("secrets", [
      "HUB_API_KEY=",
      "INTELLIGENCE_API_KEY=",
    ]);
    expect(env.match(/^HUB_API_KEY=/gm)?.length).toBe(1);
    expect(env.match(/^INTELLIGENCE_API_KEY=/gm)?.length).toBe(1);
  });

  test("says what is wrong when there is no .env", async () => {
    const { exitCode, stdout } = await runHub("secrets", null);
    expect(exitCode).toBe(1);
    expect(stdout).toContain(".env is missing");
  });
});
