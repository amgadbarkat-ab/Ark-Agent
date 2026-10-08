import type { HubConfig } from "./config";
import { connect, ensureDatabase, migrate, type Sql } from "./db";
import { createGateway, type SocketData } from "./gateway";
import { Hub } from "./hub";
import { createRestApp } from "./rest";
import { HubStore } from "./store";

export interface RunningHub {
  hub: Hub;
  /** Base URL of the HTTP API. */
  apiUrl: string;
  /** Base URL of the sockets; the SDK derives `/runner` and `/client` from it. */
  wsUrl: string;
  stop(): Promise<void>;
}

/**
 * Starts the hub: HTTP API and both socket endpoints on one port.
 *
 * Pass `sql` to use an existing connection (tests do, with a private schema); otherwise one is
 * opened from the configuration, and closed again on stop.
 */
export async function startHub(
  config: HubConfig,
  options: { sql?: Sql } = {},
): Promise<RunningHub> {
  if (!options.sql) await ensureDatabase(config.databaseUrl);
  const sql = options.sql ?? connect(config.databaseUrl);
  await migrate(sql);
  const hub = new Hub(config, new HubStore(sql));
  const rest = createRestApp(hub);
  const gateway = createGateway(hub);

  const server = Bun.serve<SocketData>({
    port: config.port,
    fetch(request, bunServer) {
      const upgraded = gateway.upgrade(request, bunServer);
      if (upgraded === null) return rest.fetch(request);
      return upgraded;
    },
    websocket: gateway.websocket,
  });

  const port = server.port;
  return {
    hub,
    apiUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    async stop() {
      await server.stop(true);
      if (!options.sql) await sql.end();
    },
  };
}
