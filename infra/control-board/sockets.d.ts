// Cloudflare's TCP sockets module, as the Workers runtime provides it (see workers.d.ts).
declare module "cloudflare:sockets" {
  export const connect: import("./workers").Connect;
}
