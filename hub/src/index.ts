import { HubConfigError, loadConfig } from "./config";
import { hubMetrics } from "./metrics";
import { startHub } from "./server";
import { serveMetrics } from "../../shared/metrics";

try {
  const config = loadConfig();
  const running = await startHub(config);
  console.log(`ark hub listening on ${running.apiUrl}`);
  if (config.metricsPort) {
    serveMetrics(hubMetrics, config.metricsPort);
    console.log(`ark hub metrics on port ${config.metricsPort}`);
  }
  const shutdown = async () => {
    await running.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} catch (error) {
  if (error instanceof HubConfigError) {
    console.error(`ark hub: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
