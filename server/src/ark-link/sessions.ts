/**
 * A paired phone acts as its person (#149, PE 18 Nov).
 *
 * The phone never signs in: there is no OAuth round trip and no Better Auth session for it. Instead,
 * a request the connector made for a phone (its secret mark and the device id, `marker.ts`) is
 * answered as the person the device is bound to, built the way a signed-in session is built: the same
 * id and address, and no role here, so the guard reads that person's roles from the database on every
 * request exactly as it does for a session. A person demoted a moment ago is the lower role on the
 * phone's next request; a person removed (deleted, or on the deny list) or a device removed is no
 * session at all. Cookies the phone carries are not read on this path.
 *
 * Wrapped around the deployment's `AuthService`, so every place that asks "who is this" (the route
 * guard, CopilotKit's resolver, the socket upgrades) gets the same answer.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import type { AuthService } from "../auth/guards";
import type { Database } from "../db/client";
import { arkLinkDevices, users } from "../db/schema";
import { linkDeviceOf } from "./marker";

export type LinkPerson = {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
};

/** The person an accepted device acts as, or null when the device, its acceptance or the person is gone. */
export function linkPersonResolver(
  database: Database,
  isRevoked: (email: string) => Promise<boolean>,
) {
  return async (deviceId: string): Promise<LinkPerson | null> => {
    const [row] = await database
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        image: users.image,
      })
      .from(arkLinkDevices)
      .innerJoin(users, eq(users.id, arkLinkDevices.userId))
      .where(
        and(
          eq(arkLinkDevices.id, deviceId),
          isNotNull(arkLinkDevices.acceptedAt),
        ),
      )
      .limit(1);
    if (!row) return null;
    if (await isRevoked(row.email)) return null;
    return row;
  };
}

/** `auth`, answering a phone's request as its person and everything else as before. */
export function withArkLinkSessions(
  auth: AuthService,
  personFor: (deviceId: string) => Promise<LinkPerson | null>,
): AuthService {
  return {
    handler: (request) => auth.handler(request),
    api: {
      getSession: async (input) => {
        const deviceId = linkDeviceOf(input.headers);
        if (!deviceId) return auth.api.getSession(input);
        const person = await personFor(deviceId);
        // No `role`: the guard reads it fresh, so a role changed since pairing is the one that applies.
        return person ? { user: person } : null;
      },
    },
  };
}
