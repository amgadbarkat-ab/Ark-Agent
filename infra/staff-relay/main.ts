/**
 * The staff relay's entry point on Cloudflare Workers, as `wrangler.toml` names it: the Worker and
 * its Durable Object class on the real runtime. Everything else runs under `bun test` too.
 */
import {
  type DurableObjectState,
  workersPlatform,
} from "../phone-relay/worker/types";
import { createWorker, type Env, OfficeObject } from "./relay";

const platform = workersPlatform();
const worker = createWorker(platform);

export default { fetch: worker.fetch };

export class StaffOffice extends OfficeObject {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env, platform);
  }
}
