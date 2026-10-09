/**
 * Where does a signed-in customer's page load spend its time, and does it grow with how much they have?
 *
 * Starts the real server against a throwaway database (the security suite's harness), gives one customer
 * a lot of everything, then times every parameterless GET a screen makes, alone and under concurrency.
 * Prints a table, slowest first. It finds the endpoint that is O(everything the customer has), which is
 * the one a larger customer will feel first; it does not say how many customers a pod holds, since the
 * numbers are for whatever machine this ran on.
 *
 *   bun scripts/load-profile.ts [agents] [channels] [skills]
 */
import { seedCustomer, startTarget } from "../server/tests/security/harness";

const agents = Number(process.argv[2] ?? 40);
const channels = Number(process.argv[3] ?? 150);
const skills = Number(process.argv[4] ?? 30);

const target = await startTarget();
try {
  await seedCustomer(target, target.a, "LOAD");
  const alice = target.a;
  const ok = async (method: string, path: string, body?: unknown) => {
    const response = await target.call(alice, method, path, { body });
    if (response.status >= 300) {
      throw new Error(
        `${method} ${path} -> ${response.status} ${response.text.slice(0, 200)}`,
      );
    }
    return JSON.parse(response.text);
  };

  const started = Date.now();
  const agentIds: string[] = [];
  for (let i = 0; i < agents; i++) {
    const { agent } = await ok("POST", "/api/agents", {
      name: `Load ${i}`,
      title: "Analyst",
      roleDescription: `Role ${i}. `.repeat(20),
      visibility: "private",
    });
    agentIds.push(agent.id);
  }
  for (let i = 0; i < channels; i++) {
    await ok("POST", "/api/channels", {
      agentIds: [agentIds[i % agentIds.length]],
    });
  }
  for (let i = 0; i < skills; i++) {
    await ok("POST", "/api/plugins/skills", {
      slug: `load-skill-${i}`,
      title: `Skill ${i}`,
      instructions: "Do the thing. ".repeat(40),
    });
  }
  console.log(
    `seeded ${agents} agents, ${channels} channels, ${skills} skills in ${((Date.now() - started) / 1000).toFixed(1)}s\n`,
  );

  const routes = [
    ...new Set(
      target.routes
        .filter(
          (route) =>
            route.method === "GET" &&
            !route.path.includes(":") &&
            !route.path.includes("*") &&
            !route.path.startsWith("/api/admin/") &&
            !route.path.startsWith("/api/auth") &&
            route.path.startsWith("/api/") &&
            // Long-polls and streams hold the connection open on purpose; timing them times nothing.
            !/host-access|stream|events|socket|\/next$/.test(route.path),
        )
        .map((route) => route.path),
    ),
  ];

  const percentile = (sorted: number[], p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;

  type Row = {
    path: string;
    status: number;
    bytes: number;
    p50: number;
    p95: number;
    concurrentP95: number;
  };
  const rows: Row[] = [];
  for (const path of routes) {
    const times: number[] = [];
    let status = 0;
    let bytes = 0;
    for (let i = 0; i < 25; i++) {
      const t = performance.now();
      const response = await target.call(alice, "GET", path);
      times.push(performance.now() - t);
      status = response.status;
      bytes = response.text.length;
    }
    const concurrent: number[] = [];
    await Promise.all(
      Array.from({ length: 20 }, async () => {
        const t = performance.now();
        await target.call(alice, "GET", path);
        concurrent.push(performance.now() - t);
      }),
    );
    times.sort((a, b) => a - b);
    concurrent.sort((a, b) => a - b);
    rows.push({
      path,
      status,
      bytes,
      p50: percentile(times, 0.5),
      p95: percentile(times, 0.95),
      concurrentP95: percentile(concurrent, 0.95),
    });
  }
  rows.sort((a, b) => b.p95 - a.p95);
  const pad = (value: string | number, width: number) =>
    String(value).padEnd(width);
  console.log(
    `${pad("route", 44)}${pad("status", 8)}${pad("bytes", 9)}${pad("p50 ms", 9)}${pad("p95 ms", 9)}20-at-once p95`,
  );
  for (const row of rows) {
    console.log(
      `${pad(row.path, 44)}${pad(row.status, 8)}${pad(row.bytes, 9)}${pad(row.p50.toFixed(1), 9)}${pad(row.p95.toFixed(1), 9)}${row.concurrentP95.toFixed(1)}`,
    );
  }
} finally {
  await target.stop();
}
