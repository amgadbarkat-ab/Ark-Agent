import { collectProcessMetrics, Registry } from "../../shared/metrics";

/**
 * What the hub says about itself. Numbers only, with labels from small fixed sets: nothing here is
 * about a conversation, a thread id or a person. Served on a port of its own when `HUB_METRICS_PORT`
 * is set (see shared/metrics.ts).
 */
export const hubMetrics = new Registry();
collectProcessMetrics(hubMetrics);

const sockets = hubMetrics.gauge(
  "ark_hub_sockets",
  "Sockets open now, by who is on the other end: a runner executing a turn, or a browser.",
  ["endpoint"],
);
const open: Record<string, number> = { runner: 0, client: 0 };
hubMetrics.collect(() => {
  for (const [endpoint, n] of Object.entries(open))
    sockets.set({ endpoint }, n);
});

export function socketOpened(endpoint: "runner" | "client") {
  open[endpoint] = (open[endpoint] ?? 0) + 1;
}
export function socketClosed(endpoint: "runner" | "client") {
  open[endpoint] = Math.max(0, (open[endpoint] ?? 0) - 1);
}

/** Events made durable. The rate is how much the coworkers are saying. */
export const eventsStored = hubMetrics.counter(
  "ark_hub_events_stored_total",
  "Events written to the conversation log.",
);

/** A runner's events that could not be stored; it resends them. Should stay at zero. */
export const storageErrors = hubMetrics.counter(
  "ark_hub_storage_errors_total",
  "Batches of events the database refused.",
);

/**
 * A browser brought up to date from the log. `join` is the ordinary case; `gap` is a live event whose
 * predecessor it never saw, and `reconnect` is the bus losing its connection and getting it back.
 * Anything but `join` is the bus dropping an announcement, which is worth knowing the rate of.
 */
export const catchUps = hubMetrics.counter(
  "ark_hub_catchups_total",
  "Times a browser's conversation was read back from the log, by why.",
  ["reason"],
);
