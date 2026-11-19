/**
 * The Workers phone relay's entry point, as `wrangler.toml` names it: the Worker and its two Durable
 * Object classes on the real runtime. Only this file imports `cloudflare:sockets` (for the alert
 * email), so the rest runs under `bun test` with stand-ins.
 */
import { connect } from "cloudflare:sockets";
import { DirectoryObject } from "./directory-object";
import { createWorker } from "./index";
import { LineObject } from "./line-object";
import { type DurableObjectState, type Env, workersPlatform } from "./types";

const platform = workersPlatform(connect);
const worker = createWorker(platform);

export default { fetch: worker.fetch };

export class PhoneLine extends LineObject {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env, platform);
  }
}

export class PhoneDirectory extends DirectoryObject {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env, platform);
  }
}
