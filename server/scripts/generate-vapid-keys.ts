/**
 * Make the key pair a server needs to send notifications to phones and browsers.
 *
 *   bun server/scripts/generate-vapid-keys.ts
 *
 * Prints two lines to set in the deployment's environment (the private one is a secret: put it where
 * the other secrets go, not in a file in the repository). Run once. Making a new pair later silences
 * every device that subscribed with the old one until it subscribes again.
 */
import webpush from "web-push";

const keys = webpush.generateVAPIDKeys();
console.log(`WEB_PUSH_VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`WEB_PUSH_VAPID_PRIVATE_KEY=${keys.privateKey}`);
