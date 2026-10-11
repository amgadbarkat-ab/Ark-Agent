// Launched by pids-limit-fallback.test.ts, one scenario per process: the supervisor keeps what it
// learns about the engine for as long as it runs, and its Docker client is made at import.
//
// The engine here is a small fake that speaks the parts of the Docker API `ensure` uses, over a unix
// socket, so the real code runs end to end against the refusal found on the first Windows install of
// 0.1.2. Its message is the one Podman's crun sent, word for word.
import {
  BOT_LABEL,
  NAMESPACE,
  NAMESPACE_LABEL,
  namesFor,
  OWNER_LABEL,
} from "../../src/names";

const scenario = process.env.SCENARIO ?? "";
const socket = process.env.DOCKER_SOCKET ?? "";
if (!scenario || !socket)
  throw new Error("SCENARIO and DOCKER_SOCKET are required.");

const REFUSAL =
  "crun: controller `pids` is not available under /sys/fs/cgroup/non-systemd/user.slice/user-1000.slice/user@1000.service/user.slice/libpod-8d2ec16ee0206c8fb2800de3584c53cec73e455aa4017281c013792f90ed87a4.scope/container/cgroup.controllers: OCI runtime error";

type Fake = {
  name: string;
  body: {
    Labels?: Record<string, string>;
    Env?: string[];
    Image?: string;
    HostConfig?: { PidsLimit?: number };
  };
  state: "created" | "running";
};

const containers = new Map<string, Fake>();
const calls: {
  op: string;
  container?: string;
  pids?: number | null;
  result?: string;
}[] = [];

// What this engine will and will not do.
const engineHasPidsController = scenario === "capable";
const refusesAtCreate = scenario === "refused-at-create";
const failsStartForAnotherReason = scenario === "other-error";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function wantsLimit(fake: Fake) {
  return (fake.body.HostConfig?.PidsLimit ?? 0) > 0;
}

Bun.serve({
  unix: socket,
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/v\d+(\.\d+)?/, "");
    const method = request.method;

    if (path === "/_ping") return new Response("OK");
    if (method === "POST" && path === "/volumes/create") {
      return json(201, { Name: "volume" });
    }
    if (method === "GET" && /^\/images\/.+\/json$/.test(path)) {
      return json(200, { Id: "sha256:fixture" });
    }
    if (method === "POST" && path === "/containers/create") {
      const name = url.searchParams.get("name") ?? "";
      const body = (await request.json()) as Fake["body"];
      const fake: Fake = { name, body, state: "created" };
      const pids = body.HostConfig?.PidsLimit ?? null;
      if (containers.has(name)) return json(409, { message: "name in use" });
      if (refusesAtCreate && !engineHasPidsController && wantsLimit(fake)) {
        calls.push({ op: "create", container: name, pids, result: "refused" });
        return json(500, { message: REFUSAL });
      }
      containers.set(name, fake);
      calls.push({ op: "create", container: name, pids, result: "ok" });
      return json(201, { Id: `id-${name}`, Warnings: [] });
    }

    const match = path.match(/^\/containers\/([^/]+)(\/json|\/start)?$/);
    if (!match) return json(404, { message: `unexpected ${method} ${path}` });
    const name = decodeURIComponent(match[1] as string);
    const fake = containers.get(name);

    if (method === "GET" && match[2] === "/json") {
      if (!fake) return json(404, { message: "No such container" });
      return json(200, {
        Id: `id-${name}`,
        Image: "sha256:fixture",
        Config: {
          Labels: fake.body.Labels,
          Env: fake.body.Env,
          Image: fake.body.Image,
        },
        HostConfig: fake.body.HostConfig,
        State: {
          Status: fake.state,
          Running: fake.state === "running",
          StartedAt: "2026-01-01T00:00:00Z",
          ...(fake.state === "running"
            ? { Health: { Status: "healthy" } }
            : {}),
        },
        NetworkSettings: {
          Ports: { "4100/tcp": [{ HostIp: "127.0.0.1", HostPort: "49152" }] },
        },
      });
    }
    if (method === "POST" && match[2] === "/start") {
      if (!fake) return json(404, { message: "No such container" });
      if (fake.state === "running") return new Response(null, { status: 304 });
      if (failsStartForAnotherReason) {
        calls.push({ op: "start", container: name, result: "failed" });
        return json(500, { message: "no space left on device" });
      }
      if (!engineHasPidsController && wantsLimit(fake)) {
        calls.push({ op: "start", container: name, result: "refused" });
        return json(500, { message: REFUSAL });
      }
      fake.state = "running";
      calls.push({ op: "start", container: name, result: "ok" });
      return new Response(null, { status: 204 });
    }
    if (method === "DELETE" && !match[2]) {
      if (!fake) return json(404, { message: "No such container" });
      containers.delete(name);
      calls.push({ op: "remove", container: name });
      return new Response(null, { status: 204 });
    }
    return json(404, { message: `unexpected ${method} ${path}` });
  },
});

const supervisor = await import("../../src/docker");

function namesOf(botId: string) {
  const result = namesFor(botId);
  if (!result.ok) throw new Error(result.reason);
  return result.names;
}

const first = namesOf("pidsbot");
if (scenario === "leftover") {
  // What the earlier attempt on the same machine left behind: created with the limit, never started.
  containers.set(first.container, {
    name: first.container,
    state: "created",
    body: {
      Labels: {
        [OWNER_LABEL]: "true",
        [BOT_LABEL]: first.botId,
        [NAMESPACE_LABEL]: NAMESPACE,
      },
      Env: [],
      Image: "fixture:1",
      HostConfig: { PidsLimit: 512 },
    },
  });
}

async function ensure(names: ReturnType<typeof namesOf>) {
  try {
    const state = await supervisor.ensure(names, {
      image: "fixture:1",
      environment: [],
      readyTimeoutMs: 5000,
    });
    return { ok: true, status: state.status, url: state.url };
  } catch (error) {
    return {
      ok: false,
      error: (error as Error).name,
      message: (error as Error).message,
    };
  }
}

const outcome = await ensure(first);
const firstCalls = calls.splice(0);

// A second Bot on the same engine, in the same process.
let second: { outcome: unknown; calls: typeof calls } | undefined;
if (scenario === "fresh") {
  const other = namesOf("pidsbot2");
  second = { outcome: await ensure(other), calls: calls.splice(0) };
}

const final = containers.get(first.container);
console.log(
  `PIDS_FIXTURE ${JSON.stringify({
    outcome,
    calls: firstCalls,
    final: final
      ? { state: final.state, pids: final.body.HostConfig?.PidsLimit ?? null }
      : null,
    second,
  })}`,
);
process.exit(0);
