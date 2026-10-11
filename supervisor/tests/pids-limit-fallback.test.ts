import { test as bunTest, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Whether the supervisor's own dependencies are installed.
 *
 * The supervisor is not a root workspace: it is built from its own lockfile, and only its own CI job
 * installs it. The root `tests` job does not, and must not start to, because the Docker client it
 * would then find also switches on the lifecycle test in `docker.integration.test.ts` there. So
 * without the client these cases skip, the way that test does, and the supervisor job runs them.
 */
const hasDockerClient = (() => {
  try {
    Bun.resolveSync("dockerode", join(import.meta.dir, "..", "src"));
    return true;
  } catch {
    return false;
  }
})();
const test = hasDockerClient ? bunTest : bunTest.skip;

/**
 * A computer on an engine that cannot enforce a process limit.
 *
 * The first Windows install of 0.1.2 ran Podman in a machine that was not handed the cgroup `pids`
 * controller, so every computer failed to start with `crun: controller \`pids\` is not available`
 * and the Bot's screen said "The supervisor could not reach Docker". Each scenario runs in its own
 * process (see fixtures/pids-limit-fallback.ts), against a fake engine that gives that exact refusal.
 */
type Call = {
  op: string;
  container?: string;
  pids?: number | null;
  result?: string;
};
type Report = {
  outcome: { ok: boolean; status?: string; error?: string; message?: string };
  calls: Call[];
  final: { state: string; pids: number | null } | null;
  second?: { outcome: { ok: boolean }; calls: Call[] };
};

async function run(scenario: string): Promise<Report> {
  const directory = mkdtempSync(join(tmpdir(), "pids-fallback-"));
  try {
    const child = Bun.spawn(
      [process.execPath, `${import.meta.dir}/fixtures/pids-limit-fallback.ts`],
      {
        env: {
          ...process.env,
          SCENARIO: scenario,
          DOCKER_SOCKET: join(directory, "docker.sock"),
          COMPUTER_NAMESPACE: "pids-fixture",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const line = stdout.split("\n").find((l) => l.startsWith("PIDS_FIXTURE "));
    if (status !== 0 || !line) {
      throw new Error(
        `fixture ${scenario} failed (${status}): ${stdout}\n${stderr}`,
      );
    }
    return JSON.parse(line.slice("PIDS_FIXTURE ".length)) as Report;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const shape = (calls: Call[]) =>
  calls.map(
    (call) =>
      `${call.op}${call.pids !== undefined ? `:${call.pids}` : ""}${call.result ? `:${call.result}` : ""}`,
  );

test("an engine that refuses the process limit at start gets the computer built again without it", async () => {
  const report = await run("fresh");
  expect(report.outcome.ok).toBe(true);
  expect(report.outcome.status).toBe("running");
  expect(shape(report.calls)).toEqual([
    "create:512:ok",
    "start:refused",
    "remove",
    "create:null:ok",
    "start:ok",
  ]);
  expect(report.final).toEqual({ state: "running", pids: null });
});

test("what was learned is kept: the next Bot's computer is not asked to carry the limit", async () => {
  const report = await run("fresh");
  expect(report.second?.outcome.ok).toBe(true);
  expect(shape(report.second?.calls ?? [])).toEqual([
    "create:null:ok",
    "start:ok",
  ]);
});

test("a computer left behind with the limit by an earlier attempt is replaced, not adopted", async () => {
  const report = await run("leftover");
  expect(report.outcome.ok).toBe(true);
  expect(shape(report.calls)).toEqual([
    "start:refused",
    "remove",
    "create:null:ok",
    "start:ok",
  ]);
  expect(report.final).toEqual({ state: "running", pids: null });
});

test("an engine that refuses the limit when the computer is created is handled the same way", async () => {
  const report = await run("refused-at-create");
  expect(report.outcome.ok).toBe(true);
  expect(shape(report.calls)).toEqual([
    "create:512:refused",
    "create:null:ok",
    "start:ok",
  ]);
  expect(report.final).toEqual({ state: "running", pids: null });
});

test("an engine that can enforce the limit is still asked to", async () => {
  const report = await run("capable");
  expect(report.outcome.ok).toBe(true);
  expect(shape(report.calls)).toEqual(["create:512:ok", "start:ok"]);
  expect(report.final).toEqual({ state: "running", pids: 512 });
});

test("any other refusal to start is still reported, and nothing is removed or retried", async () => {
  const report = await run("other-error");
  expect(report.outcome.ok).toBe(false);
  expect(report.outcome.error).toBe("DockerUnavailableError");
  expect(report.outcome.message).toContain("no space left on device");
  expect(shape(report.calls)).toEqual(["create:512:ok", "start:failed"]);
});
