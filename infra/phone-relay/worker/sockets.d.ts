// Cloudflare's TCP sockets module, as the Workers runtime provides it (see types.ts).
declare module "cloudflare:sockets" {
  export const connect: import("./types").Connect;
}
