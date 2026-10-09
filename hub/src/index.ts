import { HubConfigError, loadConfig } from "./config";
import { hubMetrics } from "./metrics";
import { startHub } from "./server";
import { createDrain } from "../../shared/drain";
import { serveMetrics } from "../../shared/metrics";

try {
  const config = loadConfig();
  const running = await startHub(config);
  console.log(`ark hub listening on ${running.apiUrl}`);
  if (config.metricsPort) {
    serveMetrics(hubMetrics, config.metricsPort);
    console.log(`ark hub metrics on port ${config.metricsPort}`);
  }
  // Leaving is not exiting: a deploy replaces every pod, and the people and runs on this one should be
  // moved, not dropped (shared/drain.ts).
  const drain = createDrain({
    pending: () => running.pendingRequests(),
    stopListening: () => running.stopListening(),
    closeAll: () => running.stop(),
    cleanup: async () => undefined,
    exit: (code) => process.exit(code),
    log: (line) => console.log(line),
    settleMs: config.shutdown?.settleMs ?? 0,
    graceMs: config.shutdown?.graceMs ?? 8000,
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => void drain.begin(signal));
  }
} catch (error) {
  if (error instanceof HubConfigError) {
    console.error(`ark hub: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
