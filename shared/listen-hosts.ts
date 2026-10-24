/**
 * Which addresses a server listens on, from `LISTEN_HOSTS` (comma-separated).
 *
 * Unset or empty means every interface, which is what a hosted deployment inside a container needs.
 * The desktop sets loopback: there, every request is the computer's one administrator, and listening
 * on every interface put an administrator's API and screens on the local network.
 */
export function listenHosts(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
}
