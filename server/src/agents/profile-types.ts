export type AgentVisibility = "public" | "private";

/**
 * Where a coworker runs: in Ark's cloud, or on the person's own computer (decision D5). On the
 * computer it is included in the plan and costs Ark nothing; in the cloud it is metered and paid for
 * as an add-on (docs/ark/17-cloud-runtime.md).
 */
export type RunLocation = "cloud" | "device";

export const RUN_LOCATIONS: readonly RunLocation[] = ["cloud", "device"];

export type AgentActor = {
  id: string;
  role: "admin" | "user";
};

export type AgentProfile = {
  id: string;
  name: string;
  title: string;
  roleDescription: string;
  avatarSeed: string;
  /** The picture its owner chose, as a small `data:` image, or null for the default. */
  avatarImage: string | null;
  visibility: AgentVisibility;
  runLocation: RunLocation;
  ownerUserId: string | null;
  systemOwned: boolean;
  hidden: boolean;
  deletedAt: Date | null;
  /** Where this coworker runs. Null for the Bot in the box. */
  endpoint: string | null;
  /** Whether a key is set for it. Never the key. */
  hasAuth: boolean;
  /**
   * Whether this agent holds a credential for calling tools back.
   *
   * A boolean, never the token: the token exists in a readable form once, in the response that issued
   * it. A surface only needs to know whether to offer "generate" or "rotate".
   */
  hasCallbackToken: boolean;
};

export type CreateAgentInput = Pick<
  AgentProfile,
  "name" | "title" | "roleDescription" | "visibility"
> & {
  /** Where it runs. Absent on a create is the cloud, and on an update leaves it where it is. */
  runLocation?: RunLocation;
  /**
   * The AG-UI endpoint this Bot runs on, or undefined for the one in the box.
   *
   * This field is the AG-UI endpoint for a customer-provided agent. Without it the Bot runs on the
   * built-in endpoint.
   */
  endpoint?: string;
  /**
   * A key this agent sits behind, if any.
   *
   * Write-only. It goes to the vault and is never read back to a person: the edit form shows that a
   * key is set, not what it is. Absent on an update means "leave whatever is there alone", which is
   * why it is optional rather than defaulting to empty; a blank field must not drop a key.
   */
  auth?: { header: string; value: string };
};
