import { describe, expect, test } from "bun:test";
import { collectProcessMetrics, MAX_SERIES, Registry } from "./metrics";

describe("counters and gauges", () => {
  test("render in the text format, with help, type, and escaped label values", async () => {
    const registry = new Registry();
    const hits = registry.counter("ark_hits_total", "Things that\nhappened.", [
      "route",
    ]);
    hits.inc({ route: "/api/agents/:id" });
    hits.inc({ route: "/api/agents/:id" }, 2);
    hits.inc({ route: 'a "quoted" \\ one\nsplit' });
    const open = registry.gauge("ark_open", "Open things.");
    open.set(4);

    const text = await registry.render();

    expect(text).toContain("# HELP ark_hits_total Things that\\nhappened.");
    expect(text).toContain("# TYPE ark_hits_total counter");
    expect(text).toContain('ark_hits_total{route="/api/agents/:id"} 3');
    expect(text).toContain(
      'ark_hits_total{route="a \\"quoted\\" \\\\ one\\nsplit"} 1',
    );
    expect(text).toContain("# TYPE ark_open gauge\nark_open 4");
  });

  test("a counter only goes up, and a gauge can be rebuilt each scrape", async () => {
    const registry = new Registry();
    const c = registry.counter("ark_c_total", "c");
    c.inc({}, -5);
    c.inc({}, Number.NaN);
    c.inc();
    const g = registry.gauge("ark_g", "g", ["state"]);
    registry.collect(() => {
      g.clear();
      g.set({ state: "a" }, 1);
    });

    expect(await registry.render()).toContain("ark_c_total 1");
    g.set({ state: "stale" }, 9);
    expect(await registry.render()).not.toContain('state="stale"');
  });

  test("labels have to be the declared ones", () => {
    const registry = new Registry();
    const c = registry.counter("ark_l_total", "l", ["a"]);
    expect(() => c.inc({})).toThrow(/takes the labels a/);
    expect(() => c.inc({ a: "1", b: "2" })).toThrow(/not a, b/);
    expect(() => registry.counter("bad name", "x")).toThrow(/metric name/);
    expect(() => registry.counter("ark_ok_total", "x", ["le"])).toThrow(
      /label name/,
    );
    expect(() => registry.counter("ark_l_total", "again")).toThrow(
      /already registered/,
    );
  });
});

describe("histograms", () => {
  test("count into cumulative buckets, with a sum and a count", async () => {
    const registry = new Registry();
    const h = registry.histogram(
      "ark_seconds",
      "How long.",
      ["route"],
      [0.1, 1],
    );
    h.observe({ route: "/x" }, 0.05);
    h.observe({ route: "/x" }, 0.5);
    h.observe({ route: "/x" }, 5);

    const text = await registry.render();

    expect(text).toContain('ark_seconds_bucket{route="/x",le="0.1"} 1');
    expect(text).toContain('ark_seconds_bucket{route="/x",le="1"} 2');
    expect(text).toContain('ark_seconds_bucket{route="/x",le="+Inf"} 3');
    expect(text).toContain('ark_seconds_sum{route="/x"} 5.55');
    expect(text).toContain('ark_seconds_count{route="/x"} 3');
  });

  test("ignore what is not a duration", async () => {
    const registry = new Registry();
    const h = registry.histogram("ark_d_seconds", "d");
    h.observe({}, -1);
    h.observe({}, Number.NaN);
    expect(await registry.render()).not.toContain("ark_d_seconds_count");
  });
});

describe("the backstop on label sets", () => {
  test("keeps a bounded number and counts the rest instead of running out of memory", async () => {
    const registry = new Registry();
    const c = registry.counter("ark_unbounded_total", "u", ["id"]);
    for (let i = 0; i < MAX_SERIES + 25; i++) c.inc({ id: String(i) });
    // An existing set is still counted.
    c.inc({ id: "0" });

    const text = await registry.render();

    expect(text.match(/^ark_unbounded_total\{/gm)).toHaveLength(MAX_SERIES);
    expect(text).toContain('ark_unbounded_total{id="0"} 2');
    expect(text).toContain(
      'ark_metrics_dropped_series_total{metric="ark_unbounded_total"} 25',
    );
  });
});

describe("collectors", () => {
  test("one that fails is skipped and counted, and the page still renders", async () => {
    const registry = new Registry();
    const g = registry.gauge("ark_fine", "f");
    registry.collect(() => {
      throw new Error("the database is down");
    });
    registry.collect(() => g.set(1));

    const text = await registry.render();

    expect(text).toContain("ark_fine 1");
    expect(text).toContain("ark_metrics_collector_failures_total 1");
    // The reason is not in the page.
    expect(text).not.toContain("database");
  });

  test("the process reports its memory and uptime", async () => {
    const registry = new Registry();
    collectProcessMetrics(registry);
    const text = await registry.render();
    expect(text).toMatch(/process_resident_memory_bytes \d+/);
    expect(text).toMatch(/process_uptime_seconds [\d.]+/);
    expect(text).toMatch(/process_start_time_seconds \d+/);
  });
});
