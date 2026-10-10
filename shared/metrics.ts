/**
 * Counters, gauges and histograms, and the text a Prometheus-compatible scraper reads them as.
 *
 * Written here rather than pulled in as a dependency: the whole of what is needed is a few hundred
 * lines, it runs in the server and the hub (two images, one of them with almost nothing in it), and a
 * metrics library's default behaviours (global registry, process collectors, unbounded label sets) are
 * exactly the ones to decide on purpose.
 *
 * TWO RULES THAT ARE ABOUT SAFETY RATHER THAN CONVENIENCE:
 *
 * - Labels are chosen by the code that records, never by a request. A label built from a path, a user
 *   id or an error message is an unbounded set of series that fills memory and puts people's data in
 *   the metrics. The callers pass route patterns and small fixed words.
 * - As a backstop, a metric holds at most {@link MAX_SERIES} label sets. The next new one is counted
 *   in `ark_metrics_dropped_series_total` and not stored, so a mistake costs a counter going up
 *   instead of the process running out of memory.
 */

export type Labels = Readonly<Record<string, string>>;

/** The most label sets any one metric keeps. */
export const MAX_SERIES = 1000;

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const escapeHelp = (text: string) =>
  text.replaceAll("\\", "\\\\").replaceAll("\n", "\\n");
const escapeValue = (text: string) =>
  text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");

function formatNumber(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "+Inf";
  if (value === Number.NEGATIVE_INFINITY) return "-Inf";
  return String(value);
}

function renderLabels(labels: Labels, extra?: [string, string]): string {
  const parts = Object.entries(labels).map(
    ([key, value]) => `${key}="${escapeValue(value)}"`,
  );
  if (extra) parts.push(`${extra[0]}="${escapeValue(extra[1])}"`);
  return parts.length > 0 ? `{${parts.join(",")}}` : "";
}

abstract class Metric {
  protected readonly labelNames: readonly string[];
  constructor(
    readonly name: string,
    readonly help: string,
    labelNames: readonly string[],
    protected readonly registry: Registry,
  ) {
    if (!NAME.test(name)) throw new Error(`"${name}" is not a metric name.`);
    for (const label of labelNames) {
      if (!LABEL.test(label) || label === "le") {
        throw new Error(`"${label}" is not a label name for ${name}.`);
      }
    }
    this.labelNames = [...labelNames];
  }

  /** The label set as a stable key, in the declared order, or throws if it is not the declared set. */
  protected keyOf(labels: Labels): string {
    const given = Object.keys(labels);
    if (
      given.length !== this.labelNames.length ||
      !this.labelNames.every((label) => label in labels)
    ) {
      throw new Error(
        `${this.name} takes the labels ${this.labelNames.join(", ") || "(none)"}, not ${given.join(", ") || "(none)"}.`,
      );
    }
    return this.labelNames.map((label) => labels[label] ?? "").join("\u0000");
  }

  protected ordered(labels: Labels): Labels {
    return Object.fromEntries(
      this.labelNames.map((label) => [label, labels[label] ?? ""]),
    );
  }

  abstract type(): "counter" | "gauge" | "histogram";
  abstract lines(): string[];
}

type Series<T> = Map<string, { labels: Labels; value: T }>;

function admit<T>(
  metric: Metric,
  series: Series<T>,
  key: string,
  registry: Registry,
): boolean {
  if (series.has(key) || series.size < MAX_SERIES) return true;
  registry.dropped(metric.name);
  return false;
}

export class Counter extends Metric {
  private readonly series: Series<number> = new Map();
  type() {
    return "counter" as const;
  }
  inc(labels: Labels = {}, by = 1): void {
    if (by < 0 || !Number.isFinite(by)) return;
    const key = this.keyOf(labels);
    if (!admit(this, this.series, key, this.registry)) return;
    const found = this.series.get(key);
    if (found) found.value += by;
    else this.series.set(key, { labels: this.ordered(labels), value: by });
  }
  lines(): string[] {
    return [...this.series.values()].map(
      (entry) =>
        `${this.name}${renderLabels(entry.labels)} ${formatNumber(entry.value)}`,
    );
  }
}

export class Gauge extends Metric {
  private readonly series: Series<number> = new Map();
  type() {
    return "gauge" as const;
  }
  set(labels: Labels, value: number): void;
  set(value: number): void;
  set(first: Labels | number, second?: number): void {
    const labels = typeof first === "number" ? {} : first;
    const value = typeof first === "number" ? first : (second ?? 0);
    const key = this.keyOf(labels);
    if (!admit(this, this.series, key, this.registry)) return;
    this.series.set(key, { labels: this.ordered(labels), value });
  }
  /** Forgets every label set, for a gauge that is rebuilt from scratch at each scrape. */
  clear(): void {
    this.series.clear();
  }
  lines(): string[] {
    return [...this.series.values()].map(
      (entry) =>
        `${this.name}${renderLabels(entry.labels)} ${formatNumber(entry.value)}`,
    );
  }
}

type Observations = { counts: number[]; sum: number; count: number };

/** Seconds, from a millisecond to a minute: what a web request or a database query takes. */
export const DEFAULT_BUCKETS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60,
];

export class Histogram extends Metric {
  private readonly series: Series<Observations> = new Map();
  private readonly buckets: readonly number[];
  constructor(
    name: string,
    help: string,
    labelNames: readonly string[],
    registry: Registry,
    buckets: readonly number[] = DEFAULT_BUCKETS,
  ) {
    super(name, help, labelNames, registry);
    this.buckets = [...buckets].sort((a, b) => a - b);
  }
  type() {
    return "histogram" as const;
  }
  observe(labels: Labels, value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    const key = this.keyOf(labels);
    if (!admit(this, this.series, key, this.registry)) return;
    let found = this.series.get(key);
    if (!found) {
      found = {
        labels: this.ordered(labels),
        value: {
          counts: this.buckets.map(() => 0),
          sum: 0,
          count: 0,
        },
      };
      this.series.set(key, found);
    }
    this.buckets.forEach((upper, index) => {
      if (value <= upper && found)
        found.value.counts[index] = (found.value.counts[index] ?? 0) + 1;
    });
    found.value.sum += value;
    found.value.count += 1;
  }
  lines(): string[] {
    const out: string[] = [];
    for (const { labels, value } of this.series.values()) {
      this.buckets.forEach((upper, index) => {
        out.push(
          `${this.name}_bucket${renderLabels(labels, ["le", formatNumber(upper)])} ${value.counts[index] ?? 0}`,
        );
      });
      out.push(
        `${this.name}_bucket${renderLabels(labels, ["le", "+Inf"])} ${value.count}`,
        `${this.name}_sum${renderLabels(labels)} ${formatNumber(value.sum)}`,
        `${this.name}_count${renderLabels(labels)} ${value.count}`,
      );
    }
    return out;
  }
}

export class Registry {
  private readonly metrics = new Map<string, Metric>();
  private readonly collectors: Array<() => void | Promise<void>> = [];
  private readonly droppedSeries: Counter;
  private readonly collectorFailures: Counter;

  constructor() {
    this.droppedSeries = this.counter(
      "ark_metrics_dropped_series_total",
      "Label sets not recorded because a metric already held the most it keeps (a label is being built from something unbounded).",
      ["metric"],
    );
    this.collectorFailures = this.counter(
      "ark_metrics_collector_failures_total",
      "Scrapes where a gauge's source could not be read.",
    );
  }

  /** @internal */
  dropped(metric: string): void {
    // Not through `inc`: it would be admitted or dropped by the same rule it reports on.
    this.droppedSeries.inc({ metric });
  }

  private add<T extends Metric>(metric: T): T {
    if (this.metrics.has(metric.name)) {
      throw new Error(`${metric.name} is already registered.`);
    }
    this.metrics.set(metric.name, metric);
    return metric;
  }

  counter(name: string, help: string, labelNames: readonly string[] = []) {
    return this.add(new Counter(name, help, labelNames, this));
  }
  gauge(name: string, help: string, labelNames: readonly string[] = []) {
    return this.add(new Gauge(name, help, labelNames, this));
  }
  histogram(
    name: string,
    help: string,
    labelNames: readonly string[] = [],
    buckets?: readonly number[],
  ) {
    return this.add(new Histogram(name, help, labelNames, this, buckets));
  }

  /**
   * Something to run at each scrape, before the text is made: sets gauges from what is true now (a
   * query, a count). A collector that throws is skipped for that scrape and counted, so one broken
   * source does not take the whole page down with it.
   */
  collect(collector: () => void | Promise<void>): void {
    this.collectors.push(collector);
  }

  async render(): Promise<string> {
    for (const collector of this.collectors) {
      try {
        await collector();
      } catch {
        this.collectorFailures.inc();
      }
    }
    const out: string[] = [];
    for (const metric of this.metrics.values()) {
      const lines = metric.lines();
      if (lines.length === 0) continue;
      out.push(
        `# HELP ${metric.name} ${escapeHelp(metric.help)}`,
        `# TYPE ${metric.name} ${metric.type()}`,
        ...lines,
      );
    }
    return `${out.join("\n")}\n`;
  }
}

/** The content type Prometheus expects for the text format. */
export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/**
 * What the process itself is doing: memory and how long it has been up. Read at each scrape.
 */
export function collectProcessMetrics(registry: Registry): void {
  const resident = registry.gauge(
    "process_resident_memory_bytes",
    "Resident memory of the process.",
  );
  const heap = registry.gauge(
    "process_heap_used_bytes",
    "Heap in use by the JavaScript engine.",
  );
  const uptime = registry.gauge(
    "process_uptime_seconds",
    "Seconds since the process started.",
  );
  const started = registry.gauge(
    "process_start_time_seconds",
    "When the process started, in seconds since the epoch.",
  );
  const startedAt = Date.now() / 1000 - process.uptime();
  registry.collect(() => {
    const memory = process.memoryUsage();
    resident.set(memory.rss);
    heap.set(memory.heapUsed);
    uptime.set(process.uptime());
    started.set(startedAt);
  });
}

/**
 * Serves `/metrics` on a port of its own, which is not the one the ingress points at.
 *
 * Separate because the metrics are for whoever runs the service, and the simplest way to keep them
 * from customers is for them to be on an address nothing public routes to (the chart exposes it to
 * the cluster only). There is no password on it for the same reason there is none on the database
 * port: reachability is the control. Anything but `GET /metrics` is a 404.
 */
export function serveMetrics(registry: Registry, port: number) {
  return Bun.serve({
    port,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "GET" || url.pathname !== "/metrics") {
        return new Response("Not found", { status: 404 });
      }
      return new Response(await registry.render(), {
        headers: { "content-type": METRICS_CONTENT_TYPE },
      });
    },
  });
}
