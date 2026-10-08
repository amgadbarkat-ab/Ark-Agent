import { HubConfigError, loadConfig } from "./config";
import { startHub } from "./server";

try {
  const config = loadConfig();
  const running = await startHub(config);
  console.log(`ark hub listening on ${running.apiUrl}`);
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
