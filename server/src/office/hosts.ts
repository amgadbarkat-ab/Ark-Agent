// The Host rule lives in shared/, because the app's own server (app/serve.ts) applies it too.
export { hostAllowed, hostName } from "../../../shared/local-hosts";
