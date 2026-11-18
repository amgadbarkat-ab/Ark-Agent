/**
 * Starts the Ark Link relay from its environment (README.md). Behind Caddy, on port 8080.
 */
import type { MobileLinksConfig } from "../../server/src/mobile/links";
import {
  isAndroidAppId,
  isIosAppId,
  normalizeFingerprint,
} from "../../server/src/mobile/links";
import { createLinkRelay } from "./relay";
import { deviceFileStore, installsFromFile } from "./store";

const env = (name: string) => process.env[name]?.trim() ?? "";
const fail = (text: string): never => {
  console.error(text);
  process.exit(1);
};

const linkOrigin = env("LINK_ORIGIN").replace(/\/+$/, "");
if (!/^https:\/\/[a-z0-9.-]+$/.test(linkOrigin))
  fail(
    "LINK_ORIGIN must be https://<host>, e.g. https://link.blackark.uk. See README.md.",
  );

const apps: MobileLinksConfig = {};
if (env("ARK_ANDROID_APP_ID")) {
  if (!isAndroidAppId(env("ARK_ANDROID_APP_ID")))
    fail("ARK_ANDROID_APP_ID is not a package name.");
  const fingerprints = env("ARK_ANDROID_CERT_SHA256")
    .split(",")
    .map((value) => normalizeFingerprint(value))
    .filter((value): value is string => Boolean(value));
  if (fingerprints.length === 0)
    fail("ARK_ANDROID_CERT_SHA256 needs at least one SHA-256 fingerprint.");
  apps.android = {
    appId: env("ARK_ANDROID_APP_ID"),
    certFingerprints: fingerprints,
  };
}
if (env("ARK_IOS_APP_ID")) {
  if (!isIosAppId(env("ARK_IOS_APP_ID")))
    fail("ARK_IOS_APP_ID is TEAMID.bundle.identifier.");
  apps.ios = { appId: env("ARK_IOS_APP_ID") };
}

const relay = createLinkRelay({
  linkOrigin,
  installs: installsFromFile(
    env("LINK_INSTALLS_FILE") || "/data/installs.json",
  ),
  devices: deviceFileStore(env("LINK_DEVICES_FILE") || "/data/devices.json"),
  apps,
  trustProxy: env("TRUST_PROXY") !== "false",
});
const server = Bun.serve({
  port: Number(env("PORT") || 8080),
  fetch: relay.fetch,
  websocket: relay.websocket,
});
console.log(`Ark Link relay for ${linkOrigin} listening on ${server.port}`);
