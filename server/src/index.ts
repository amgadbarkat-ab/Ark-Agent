// Must stay first: it decides, before the SDK loads, that nothing is reported to its vendor.
import "./no-telemetry";
// Second, and for a reason that is easy to undo by accident. The MCP client the runtime loads is
// CommonJS and `require`s `eventsource`, which is an ES module with a top-level await. Bun can only
// `require` such a module once it has finished evaluating, and it loads sibling imports in parallel,
// so whether it had finished by then depended on the order imports were listed in. The production
// process gets this from `production-entry.ts`, which imports it before this file; this line is for
// everything that runs `bun src/index.ts` itself (development, the security suite's server), where the
// error ("require() async module is unsupported") appeared a few starts in fifty. Loading the
// application's graph without it failed about three times in ten.
import "eventsource";
import { randomUUID } from "node:crypto";
import {
  CopilotKitIntelligence,
  IntelligenceAgentRunner,
} from "@copilotkit/runtime/v2";
import { serve } from "bun";
import { eq, sql } from "drizzle-orm";
import { COMPUTER_GUIDANCE } from "../../shared/bot-prompt";
import { DICTATION_HTTP_IDLE_SECONDS } from "../../shared/dictation";
import { createDrain } from "../../shared/drain";
import { listenHosts } from "../../shared/listen-hosts";
import { createReadiness } from "../../shared/readiness";
import { TERMS_VERSION } from "../../shared/terms-version";
import { workOwner } from "../../shared/work-owner";
import { RunGateAgent } from "./accounts/run-gate";
import { createRunSlots } from "./accounts/run-slots";
import { billingModeFrom, createAccountStore } from "./accounts/store";
import { mintRunAssertion, readRunAssertion } from "./agents/callback-token";
import { createAgentFetch } from "./agents/endpoint";
import { createHandoffDesk, HANDOFF_KIND } from "./agents/handoff";
import { createHandoffDelivery } from "./agents/handoff-delivery";
import { createHandoffRunner } from "./agents/handoff-runner";
import { signHandoffDeliveryRun } from "./agents/handoff-signing";
import { createTeamReach } from "./agents/lead-reach";
import { createAgentProfileStore } from "./agents/profile-store";
import type { AgentActor } from "./agents/profile-types";
import { createRunTools } from "./agents/run-tools";
import { createRuntimeAgentLoader } from "./agents/runtime-agents";
import { teamTools } from "./agents/team-tools";
import { createApp } from "./app";
import { approvalExecutors } from "./approvals/executors";
import {
  CHAT_CARD_KIND,
  COMPUTER_ACTION_KIND,
  chatCardExecutor,
  computerActionApprovals,
  computerActionExecutor,
  resumeInConversation,
  TOOL_CALL_KIND,
  toolCallApprovals,
  toolCallExecutor,
} from "./approvals/held";
import { createApprovalStore } from "./approvals/store";
import {
  type AuditInitiator,
  createAuditReader,
  createAuditStore,
  DEPLOYMENT_INITIATOR,
  PERSON_INITIATOR,
  recordAuditEvent,
} from "./audit";
import { startRetentionSweeps } from "./audit-retention";
import { createAuth } from "./auth";
import { DEV_ACTOR, initializeDevActorUser } from "./auth/dev-actor";
import type { AuthService } from "./auth/guards";
import { createRoleRepository } from "./auth/guards";
import { createIdentityProviderStore } from "./auth/identity-provider-store";
import { createOrganizationAuth } from "./auth/organization";
import { organizationUserStore } from "./auth/organization-store";
import type { OpenBotRole } from "./auth/roles";
import type { BillingProvider } from "./billing/provider";
import { billingFromEnvironment } from "./billing/select";
import { createBillingWebhook } from "./billing/webhook";
import {
  loadAttachmentForTurn,
  markAttachmentsSent,
} from "./channels/attachments";
import {
  createChannelEventHub,
  startChannelActivityListener,
} from "./channels/events";
import { createConversationOwnership } from "./channels/conversation-owner";
import { createChannelStore } from "./channels/routes";
import { websocket as channelSocket } from "./channels/socket";
import { createStallGuard } from "./channels/stall-guard";
import {
  forgetSettledSummaries,
  offerChannelsAwaitingSummary,
  summariseClaimedChannels,
} from "./channels/summary";
import { createThreadIdentity } from "./channels/thread-identity";
import { createChannelTitler, withPersonalModel } from "./channels/titler";
import { createCloudGate } from "./cloud/gate";
import { createCloudMeter } from "./cloud/meter";
import { meteredComputerProvider, tenantOfBot } from "./cloud/provider";
import { createCloudStore } from "./cloud/store";
import { createSandboxedStore } from "./components/sandboxed";
import { createComponentStore } from "./components/store";
import { createComputerGateway } from "./computer/gateway";
import { createPageFrameStore } from "./computer/page-frames";
import { startPolicyListener } from "./computer/policy-listener";
import {
  createPolicyStore,
  DEFAULT_ACTION_POLICY,
} from "./computer/policy-store";
import {
  createComputerProvider,
  describeComputerIsolation,
} from "./computer/provider";
import { createSnapshotStore } from "./computer/snapshot-store";
import { LOCAL_APP_ORIGINS, loadConfig, mayBrowsePrivateHosts } from "./config";
import {
  type IdentifyActor,
  type IdentifyUser,
  mountCopilotRuntime,
  normalizeModelBaseUrls,
  resolveRuntimeAgents,
  runtimeModelForEnvironment,
  type ToolSelection,
} from "./copilot";
import {
  createCredentialAdminService,
  createCredentialStore,
  resolveModelApiKey,
  useRetiredEncryptionKeys,
} from "./credentials";
import { createDatabase } from "./db/client";
import { agentProfiles, intelligenceChannelMappings } from "./db/schema";
import { createHostAccessBroker } from "./host-access/broker";
import { hostAccessTools } from "./host-access/tools";
import { observeIntelligenceAuthentication } from "./intelligence-client";
import { createMarketplaceStore } from "./marketplace/store";
import { createMemoryStore } from "./memories/store";
import { memoryTools } from "./memories/tools";
import { createModelConnectionStore } from "./models/connections";
import {
  createModelForActor,
  createModelHeaderForActor,
} from "./models/for-actor";
import { createStarterModel } from "./models/starter";
import {
  registerBusinessMetrics,
  serveMetrics,
  serverMetrics,
} from "./observability";
import { originAllowed, trustedOrigins } from "./origin-guard";
import { deploymentFacts } from "./overview/facts";
import { createOverviewStore } from "./overview/store";
import { createOnboardingStore } from "./people/onboarding";
import { createPeopleStore } from "./people/store";
import { createTermsStore } from "./people/terms";
import { useRoutineTools } from "./plugins/builtin-routines";
import { useComposioClient } from "./plugins/composio";
import { createComposioClient } from "./plugins/composio-adapter";
import { backfillComposioLogos } from "./plugins/logos";
import { redirectUriFor } from "./plugins/oauth";
import { createPluginStore } from "./plugins/store";
import { grantedSkills, grantedTools, REFUSAL_MARKER } from "./plugins/tools";
import { hubConversations } from "./privacy/conversations";
import { createProviderOAuthProxy } from "./provider-oauth";
import { createPushSender, webPushSend } from "./push/sender";
import { createPushStore } from "./push/store";
import { dropRetiredPlanCredentials } from "./retired-plan-credentials";
import { createTurnRunner } from "./routines/run-turn";
import { createRoutineRunner } from "./routines/runner";
import { createRoutineStore } from "./routines/store";
import { createIntentRouter } from "./routing/classify";
import { createModelCompleter } from "./routing/model";
import {
  createPackageStatusReader,
  loadTenantPackage,
  synchronizeTenantPackage,
} from "./tenant-package";
import { createUserInstructionsStore } from "./user-instructions";
import { createUserPreferencesStore } from "./user-preferences";
import { createVoiceSessionStore } from "./voice/sessions";
import { createVoiceSummarizer } from "./voice/summary";
import { repeatAfterEach } from "./work/loop";
import {
  createWorkQueue,
  startWorkOfferedListener,
  type WorkOfferedListener,
} from "./work/queue";

/**
 * Who is asking, for a CopilotKit request.
 *
 * One resolver, because a run has two questions to answer about the same person: whose threads and
 * memory these are, and which coworkers they may run. Answering them from different places is how
 * one person ends up running another's private coworker, or reading their thread.
 */
async function resolveRequestActor(request: Request): Promise<{
  id: string;
  name: string;
  role: OpenBotRole;
}> {
  if (config.singleUser) {
    return { id: DEV_ACTOR.id, name: DEV_ACTOR.email, role: DEV_ACTOR.role };
  }
  const session = await auth?.api.getSession({ headers: request.headers });
  const user = session?.user;
  if (!user) {
    throw new Error("A CopilotKit run requires a signed-in user.");
  }
  const roles = user.role
    ? [user.role]
    : await roleRepository.rolesForUser(user.id);
  if (!roles.includes("admin") && !roles.includes("user")) {
    throw new Error("A CopilotKit run requires an authorized user.");
  }
  return {
    id: user.id,
    name: user.name ?? user.email ?? user.id,
    role: roles.includes("admin") ? "admin" : "user",
  };
}

/** The Intelligence projection of {@link resolveRequestActor}: threads are scoped to this person. */
const identifyUser: IdentifyUser = async (request) => {
  const { id, name } = await resolveRequestActor(request);
  return { id, name };
};

/**
 * The authorization projection of the same person: agent visibility is decided from this.
 *
 * An unauthenticated request resolves to a person who owns nothing rather than an error, so the
 * runtime can still describe itself, `/info` reports the licence and the public roster, which is
 * what a deployment check reads to tell "the licence is invalid" apart from "chat is silently
 * broken". It grants nothing: this actor matches no private profile and is not an administrator,
 * and a run still fails in `identifyUser`, which has no anonymous case because a thread must belong
 * to somebody.
 */
const ANONYMOUS_ACTOR = { id: "", role: "user" } as const;

const identifyActor: IdentifyActor = async (request) => {
  try {
    const { id, role } = await resolveRequestActor(request);
    return { id, role };
  } catch {
    return ANONYMOUS_ACTOR;
  }
};

const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const config = loadConfig();
// The same trusted origins the app's own guard uses (app.ts), for the one route this file answers itself.
const streamOrigins = trustedOrigins([
  ...(config.auth?.trustedOrigins ?? LOCAL_APP_ORIGINS),
  config.publicUrl,
  config.appUrl,
]);
// Before anything reads a stored value, so a rotation under way never meets one it cannot open.
useRetiredEncryptionKeys(config.previousKeyEncryptionKeys);
// Read with the rest of the configuration, where an empty variable is an absent one. See
// `serverPort` in config.ts for what `process.env.PORT ?? …` did with `PORT=` instead.
const port = config.port;
const database = createDatabase(config.databaseUrl);
await initializeDevActorUser(database, config.singleUser);
// The vault, built before the agent store because a customer's agent may sit behind a key and that
// key belongs here rather than on the agent row. See agents/auth-header.ts.
const credentialStore = createCredentialStore(database);
const agentVault = {
  store: credentialStore,
  reader: credentialStore,
  encryptionKey: config.keyEncryptionKey,
};
const accountStore = createAccountStore(database, {
  billingMode: billingModeFrom(process.env.ARK_BILLING_MODE),
});
const agentProfileStore = createAgentProfileStore(
  database,
  config.managedAgent?.endpoint,
  agentVault,
  accountStore,
);
// Ark's own digital employees, written to the database on every start so the catalogue in code is the
// catalogue on screen.
const marketplaceStore = createMarketplaceStore(database, {
  accounts: accountStore,
  profiles: agentProfileStore,
  // Read when an install happens, which is after the plugin store below exists.
  skills: {
    install: (input) => pluginStore.installSkill(input),
    grant: (kind, ref, agentId, by) =>
      pluginStore.grant(kind, ref, agentId, by),
  },
});
await marketplaceStore.syncOfficial();
// Read here rather than beside the synchronise below, because the package names the deployment and
// the channel store needs that name before it can mint a thread id.
const tenantPackage = await loadTenantPackage(config.tenantPackageDirectory);
const threadIdentity = createThreadIdentity(
  config.deploymentId ?? tenantPackage.tenantId,
);
const channelStore = createChannelStore(
  database,
  agentProfileStore,
  threadIdentity,
);
const channelEvents = createChannelEventHub();
/**
 * Which components each Bot may answer with.
 *
 * Nothing is seeded here. The catalogue is a fact about the build; a fork that ships four components
 * of its own should start with four rows, and the only thing that can enumerate them is
 * the app that compiled them. It announces itself on load; this process learns what exists from that,
 * and owns only what may be done with it.
 */
const componentStore = createComponentStore(database);
// Its own connection is held for the life of the process; announced activity from any instance
// arrives here and is fanned out to connected members.
const channelActivityListener = await startChannelActivityListener(
  config.databaseUrl,
  channelEvents,
);
const roleRepository = createRoleRepository(database);
// A person's own model connections. Built here, before the agent loader, because the loader tells the
// deployment's bot which model the person chose; the routes and the gateway share the same store.
const modelConnectionStore = createModelConnectionStore(
  database,
  config.keyEncryptionKey,
);
// The free starter model, when the operator has set one up. One queue for the whole process, shared by
// the server's own agents, the bot's gateway and the status route, so a single small machine is never
// asked for more than it can answer.
const starterModel = config.starterModel
  ? createStarterModel(config.starterModel)
  : undefined;
const loadAgentsForActor = createRuntimeAgentLoader(
  database,
  agentVault,
  config.managedAgent,
  createModelHeaderForActor(
    modelConnectionStore,
    config.keyEncryptionKey,
    starterModel,
  ),
  // Reads only: what each of the person's digital employees keeps in mind, for its instructions.
  createMemoryStore(database),
);
await synchronizeTenantPackage(database, tenantPackage);
/*
 * Built before `auth`, because the deny list is consulted during sign-in and the store is what
 * holds it. It needs the administrator list too, so it can tell the screen which people the
 * deployment's configuration has already decided about.
 */
const peopleStore = createPeopleStore(
  database,
  config.auth?.initialAdminEmails ?? [],
  /*
   * Removing somebody retires the credentials they granted this deployment.
   *
   * A closure rather than the method itself, because the plugin store is built further down: this
   * has to exist before `auth` does, and that one needs the vault and the policy. Nothing calls this
   * during module initialisation — it runs when an administrator removes somebody, over HTTP — so by
   * then the binding is there.
   */
  (userId, by) => pluginStore.retireConnectionsFor(userId, by),
);
const identityProviderStore = createIdentityProviderStore(database);
/*
 * Built before `auth` for the same reason the people store is: sign-in writes to the trail, and the
 * store that receives those rows has to exist before anything can sign in.
 */
// Where each audit event is also written as it happens, when the deployment asks (AUDIT_SHIPPING=log):
// the process log, which the application cannot rewrite, as a check on the table.
const auditShipping = {
  ...(config.auditShipping === "log"
    ? { ship: (line: string) => console.log(line) }
    : {}),
};
const signInAuditStore = createAuditStore(database, auditShipping);
const auth: AuthService | undefined = config.organizationAuthUrl
  ? createOrganizationAuth({
      authorityUrl: config.organizationAuthUrl,
      materializeUser: organizationUserStore(database),
    })
  : config.auth
    ? createAuth(
        config,
        database,
        (email) => peopleStore.isRevoked(email),
        signInAuditStore,
      )
    : undefined;
/*
 * Running in Ark's cloud: what it may do, and the record of the time it uses (docs/ark/17-cloud-runtime.md).
 *
 * The record is kept in every deployment, including a company's own where nobody is charged, because
 * what the cloud costs is worth knowing before anybody decides what to charge for it.
 */
const cloudStore = createCloudStore(database);
const cloudMeter = createCloudMeter(database);
const botTenant = tenantOfBot(database);
const cloudGate = createCloudGate({
  config: config.cloud,
  hosted: accountStore.billingMode === "subscriptions",
  store: cloudStore,
  meter: cloudMeter,
  runLocationOf: async (botId) => {
    const [row] = await database
      .select({ runLocation: agentProfiles.runLocation })
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, botId))
      .limit(1);
    return row ? (row.runLocation === "device" ? "device" : "cloud") : null;
  },
});
const computerProvider = config.computer
  ? meteredComputerProvider(createComputerProvider(config.computer), {
      meter: cloudMeter,
      tenantOf: botTenant,
    })
  : undefined;

if (computerProvider?.warm) {
  void computerProvider.warm();
}
// What Bots may do on their computers. Configuration supplies the deployment's default; an
// administrator can change it while running, and a restart returns to the configured one.
const policyStore = createPolicyStore(
  config.computer?.policy ?? DEFAULT_ACTION_POLICY,
  database,
);
// A boundary an administrator set is read back before the first action is decided, so a restart no
// longer silently returns to the configured default.
const policySource = await policyStore.load();
/*
 * And kept current afterwards.
 *
 * A boundary an administrator changes arrives at one server. Without this, every other server keeps
 * enforcing what it read at boot, so a new deny rule stops roughly one action in N while the screen
 * and the audit row both report success. See policy-listener.ts.
 */
const policyListener = await startPolicyListener(
  config.databaseUrl,
  policyStore,
);

/*
 * Record which boundary this process started with.
 *
 * The trail records the boundary a process starts with, so later audit reads can distinguish the
 * configured default from any administrator-updated policy that was persisted before restart.
 *
 * Not awaited and never fatal. A deployment must not fail to start because its audit trail is
 * unavailable, and the row is a note for a reader rather than something the server depends on.
 */
const bootAuditStore = createAuditStore(database, auditShipping);
// One store: the gateway writes through it, a route reads it, and the sweep below takes the old ones out.
const pageFrameStore = createPageFrameStore(database);
// Housekeeping on a schedule: audit rows when asked for, screenshots always, one timer. See audit-retention.ts.
const retentionSweeps = startRetentionSweeps(
  config.databaseUrl,
  config.auditRetentionDays,
  pageFrameStore,
);
const computerGateway = computerProvider
  ? createComputerGateway({
      provider: computerProvider,
      auditStore: bootAuditStore,
      policy: () => policyStore.get(),
      // In Postgres, so the ref a click carries resolves against the snapshot that produced it even
      // when the snapshot was taken by another server. A Map here would be blank on every replica
      // but the one that snapshotted, and the boundary would decide with no element to look at.
      snapshots: createSnapshotStore(database),
      // So wiping a profile takes the pictures of its signed-in pages with it, which is what the
      // sentence on that button already promised.
      pageFrames: pageFrameStore,
      // Where an employee's browser may go, which the desktop narrows below this server's own reach
      // (AGENT_COMPUTER_BROWSE_PRIVATE_HOSTS; device control, finding 1).
      allowPrivateHosts: mayBrowsePrivateHosts(config.computer),
      token: config.computer?.token,
      /*
       * An action a boundary rule holds for a person goes to their Requests. Deferred: the inbox is
       * built further down, because carrying out an approved action needs this gateway.
       */
      approvals: {
        hold: (action) => computerActionApprovals(approvalStore).hold(action),
        approved: (id) => computerActionApprovals(approvalStore).approved(id),
      },
    })
  : undefined;

/**
 * What a Bot can reach beyond its own computer.
 *
 * Built here rather than beside the component store because it needs the policy, and it needs the
 * same policy the computer gateway enforces rather than one of its own. A deployment that has said
 * "this Bot may not change anything in Jira" has said one thing, and it should not matter whether
 * the change would arrive through a browser or through a tool call.
 */
const sandboxedStore = createSandboxedStore(database, bootAuditStore);

/**
 * Composio, built ONCE: the client the transport calls through and the broker behind the app
 * directory are the same client, and the store below and the routes further down share it.
 *
 * ONE CLIENT, TWO SEAMS, INSTALLED TWO DIFFERENT WAYS, because the two are reached two different
 * ways. The transport is reached as a MODULE — `transportFor` maps a kind to one, exactly as the
 * builtin routines transport above is reached — so there is no constructor to hand a client to and
 * the registry is built at IMPORT TIME, long before there is configuration to read. That is why the
 * actions seam is installed globally, from here, the one place that has the key. The broker has no
 * such problem: it is an ordinary argument, passed to the store and to `createApp`.
 *
 * A DEPLOYMENT WITH NO KEY INSTALLS NEITHER, which is the state the transport is written for rather
 * than an edge of it. The seam stays null and every Composio listing and call refuses saying the
 * connector is not configured here; the store gets no broker and the app directory says the same.
 * Installing a client built from an absent key would turn all of that into a vendor error at first
 * use, which sends an operator looking for a broken Composio instead of at their own configuration.
 */
const composio = config.composioApiKey
  ? createComposioClient(config.composioApiKey)
  : null;
if (composio) useComposioClient(composio.actions);

const pluginStore = createPluginStore({
  database,
  auditStore: bootAuditStore,
  credentials: credentialStore,
  encryptionKey: config.keyEncryptionKey,
  policy: () => policyStore.get(),
  /*
   * Where a vendor sends people back, for a vendor whose client this deployment registers itself.
   *
   * The same value the connect and callback routes build, from the same config field, because it has
   * to match what was registered character for character. Undefined without a public URL, which is
   * the honest state: there is nowhere for a consent flow to come back to, so there is nothing worth
   * registering.
   */
  redirectUri: config.publicUrl ? redirectUriFor(config.publicUrl) : undefined,
  /*
   * The same client the transport seam above was installed with, never a second one. Enabling an
   * app writes the row here and creates the auth config at the vendor, and a store holding a
   * different client from the one the call goes out through is two deployments' worth of state
   * behind one screen. Undefined without a key, which leaves enabling an app refused rather than
   * attempted.
   */
  broker: composio?.broker,
  /*
   * A call held for a person goes to their Requests. Deferred for the same reason as the computer
   * gateway's: carrying out an approved call needs this store.
   */
  approvals: {
    hold: (call) => toolCallApprovals(approvalStore).hold(call),
    approved: (id) => toolCallApprovals(approvalStore).approved(id),
  },
});

// Logo metadata is optional; a vendor outage must not prevent the API from starting.
if (composio) {
  void backfillComposioLogos(database, composio.broker).catch(() => {
    console.warn(
      "Composio app logos could not be updated. Existing icons remain available; missing logos will be retried on the next restart.",
    );
  });
}

/**
 * Routines, and the one moment its tools are told what to act on.
 *
 * The builtin transport is reached as a MODULE — `transportFor` maps a kind to one — so there is no
 * constructor to hand a store to and no request-time seam either: the transport registry is built at
 * import time, long before there is a database. So the store is installed here, once, from the place
 * that already owns building stores. Without this call the four tools are advertised and every one of
 * them refuses, which is the honest behaviour for a deployment that never wired it, and would be a
 * silent outage for this one.
 */
const routineStore = createRoutineStore(database);

/**
 * Changes one digital employee asked to make to another's work, held until their owner decides.
 * Built here because applying one needs the routine and profile stores, which exist by now.
 */
/** What a digital employee keeps in mind. This one writes, so it records who added and who deleted. */
const memoryStore = createMemoryStore(database, { auditStore: bootAuditStore });

/*
 * The outcome of a held call goes back into the conversation it was asked in, as a turn of the
 * employee's that carries on from there — the hand-off desk's queue, which already delivers a turn
 * into a conversation durably and for any kind of employee. See approvals/held.ts.
 */
const resumeHeldWork = resumeInConversation(createWorkQueue(database));

const approvalStore = createApprovalStore(database, {
  executors: {
    ...approvalExecutors({
      routines: routineStore,
      profiles: agentProfileStore,
      memories: memoryStore,
    }),
    [TOOL_CALL_KIND]: toolCallExecutor((input) => pluginStore.callTool(input)),
    [COMPUTER_ACTION_KIND]: computerActionExecutor(() => computerGateway),
    [CHAT_CARD_KIND]: chatCardExecutor,
  },
  afterDecision: {
    [TOOL_CALL_KIND]: resumeHeldWork,
    [COMPUTER_ACTION_KIND]: resumeHeldWork,
  },
  auditStore: bootAuditStore,
});
useRoutineTools(routineStore);

/**
 * Where a Bot handing work to another gets decided.
 *
 * The queue is the one #216 shipped, shared with the idle-computer culler and with routines: durable
 * work claimed by whichever replica gets to it, leased so a dead replica's work comes back. A hop is
 * that, because the Bot being addressed will very likely run on a different pod from the Bot that
 * addressed it, and a hop held in memory is lost the moment either is rescheduled.
 */
const teamMayAsk = createTeamReach(database);

const handoffDesk = createHandoffDesk({
  queue: createWorkQueue(database),
  profiles: agentProfileStore,
  // Read per hop and never held, so revoking a grant applies to the next hop rather than after a
  // restart.
  mayAddress: async (fromBotId, toBotId, threadId) =>
    (
      await pluginStore
        .botsReachableFrom(fromBotId)
        // A grant that cannot be read is not a grant. Failing closed here costs a hop; failing open
        // would let a Bot address one nobody gave it because the database blinked.
        .catch(() => [] as string[])
    ).includes(toBotId) ||
    // The lead of a person's team, and employees in one room, may ask each other without a grant.
    (await teamMayAsk(fromBotId, toBotId, threadId).catch(() => false)),
  /*
   * Deferred rather than passed directly, because `actorFor` is defined further down with the rest
   * of the run-building collaborators. It is only ever called during a hop, long after this module
   * has finished loading.
   */
  actorFor: (userId) =>
    // Null rather than a throw: see the seam's own note. A role that cannot be read is not a role,
    // and the hop is refused with a sentence rather than ending the run in silence.
    actorFor(userId).catch(() => null),
  auditStore: bootAuditStore,
  caps: config.handoff,
});

void recordAuditEvent(bootAuditStore, {
  eventType: "computer.policy_loaded",
  targetType: "policy",
  initiator: DEPLOYMENT_INITIATOR,
  payload: {
    ...policyStore.get(),
    source:
      policySource === "the database"
        ? "an administrator, saved in this deployment"
        : config.computer?.policy
          ? "configuration"
          : "the built-in default",
    note:
      policySource === "the database"
        ? "Set while running and kept. A restart returns to this."
        : "The deployment default. Anything an administrator sets from here is kept.",
  },
}).catch(() => undefined);

/*
 * Record whether each Bot has a computer of its own.
 *
 * A shared provider is a fine way to run on a laptop, but the shared isolation state must be visible
 * rather than inferred.
 */
const isolation = describeComputerIsolation(computerProvider);

void recordAuditEvent(bootAuditStore, {
  eventType: "computer.isolation_loaded",
  targetType: "computer",
  initiator: DEPLOYMENT_INITIATOR,
  payload: {
    isolation: isolation.isolation,
    note: isolation.note,
  },
}).catch(() => undefined);

console.info(
  JSON.stringify({
    type: "computer-isolation",
    provider: computerProvider ? computerProvider.name : "none",
    isolation: isolation.isolation,
    ...(isolation.warning ? { warning: isolation.warning } : {}),
  }),
);
/**
 * One Bot's endpoint must not take down the platform.
 *
 * Restarting a remote agent while a run is in flight resets the socket. The rejection reaches the top
 * of the process, and Bun kills the whole server: every other person's conversation, every other Bot
 * and the admin surface go with it, because somebody redeployed their own agent.
 *
 * That blast radius is created by design the moment people can register their own endpoints,
 * so it belongs to that feature. A remote agent is untrusted infrastructure: it will restart, it will
 * time out, it will close a stream halfway through, and none of that is exceptional.
 *
 * Logged loudly rather than swallowed. A process that hides unhandled rejections is worse than one
 * that dies, so this prints the full reason and keeps serving; what it must never do is stay quiet.
 */
process.on("unhandledRejection", (reason) => {
  console.error(
    JSON.stringify({
      type: "unhandled-rejection",
      message: reason instanceof Error ? reason.message : String(reason),
      code:
        reason && typeof reason === "object" && "code" in reason
          ? String((reason as { code: unknown }).code)
          : undefined,
      note: "The server kept running. A remote agent's connection failing must not stop everyone else.",
    }),
  );
});

/**
 * The watch on Bot streams, built once and shared by every run.
 *
 * It has to outlive the request that opens a stream: the sweep that notices a silent one is still
 * running long after the run request has been answered, because in Intelligence mode that request is
 * answered in about a second and the Bot keeps writing for as long as it has something to say.
 *
 * The same audit store as everything else, so a Bot that hangs is recorded beside what Bots do.
 */
const stallGuard = createStallGuard({
  stallMs: config.agentStallTimeoutMs,
  auditStore: bootAuditStore,
});

for (const name of dropRetiredPlanCredentials()) {
  console.warn(
    `${name} is set but Ark no longer uses chat-plan credentials. It was ignored; remove it from the environment.`,
  );
}
normalizeModelBaseUrls();
const runtimeModel = runtimeModelForEnvironment(tenantPackage.model);

const intentRouter = createIntentRouter({
  complete: createModelCompleter({
    model: runtimeModel,
    resolveApiKey: () =>
      resolveModelApiKey({
        encryptionKey: config.keyEncryptionKey,
        reader: credentialStore,
        provider: runtimeModel.provider,
        keyId: tenantPackage.model.credentialSecretRef,
        environment: process.env,
      }),
  }),
});

/**
 * Pass one of tool selection: which skills a message needs, on the deployment's own model.
 *
 * Built once rather than per request, because it holds nothing about a person: the key is resolved
 * on every call, so a credential rotated a moment ago is used by the next run.
 */
const chooseSkills = createModelCompleter({
  model: runtimeModel,
  resolveApiKey: () =>
    resolveModelApiKey({
      encryptionKey: config.keyEncryptionKey,
      reader: credentialStore,
      provider: runtimeModel.provider,
      keyId: tenantPackage.model.credentialSecretRef,
      environment: process.env,
    }),
});

/*
 * WHY THESE ARE NAMED CONSTANTS RATHER THAN ARGUMENTS WRITTEN INLINE.
 *
 * Two callers now build a Bot: a person's chat request, through `mountCopilotRuntime` below, and a
 * routine's headless turn, through `buildAgentFor` further down. They have to build the SAME Bot. A
 * routine that resolved its tools, its run assertion or its endpoint dialling through a second,
 * slightly different set of collaborators would be a Bot that behaves one way when a person asks and
 * another way at three in the morning, with nothing to point at. So each of these is written once and
 * passed to both.
 */

/** The deployment's model key, resolved per call so a credential rotated a moment ago is used next. */
const resolveRuntimeModelApiKey = () =>
  resolveModelApiKey({
    encryptionKey: config.keyEncryptionKey,
    reader: credentialStore,
    provider: runtimeModel.provider,
    keyId: tenantPackage.model.credentialSecretRef,
    environment: process.env,
  });

const hostAccessBroker = createHostAccessBroker();

// Tools run here, not in the browser. Each connector still executes through the plugin store, so the
// grant, the policy and the audit row are exactly where they were. Host-folder tools are also
// server-dispatched: the selected Bot and the signed-in owner are bound here, then the desktop worker
// receives only opaque grant ids and relative paths.
/**
 * What the lead of a team needs to look after its colleagues: the roster, their routines, the inbox
 * its requests go to, and the desk for asking one of them for work.
 */
const teamToolDependencies = {
  profiles: agentProfileStore,
  routines: routineStore,
  approvals: approvalStore,
  memories: memoryStore,
  ...(config.handoff.maxDepth > 0 && config.handoff.maxPerRun > 0
    ? { handoff: handoffDesk }
    : {}),
  auditStore: bootAuditStore,
};

const loadToolsForActor =
  (actorId: string, initiator: AuditInitiator = PERSON_INITIATOR) =>
  async (botId: string) => [
    ...(await grantedTools({ store: pluginStore, botId, actorId, initiator })),
    // Only the lead of the team, and only for its own owner; empty for everybody else.
    ...(await teamTools({ deps: teamToolDependencies, botId, actorId })),
    ...memoryTools({ store: memoryStore, botId, actorId }),
    ...hostAccessTools({
      broker: hostAccessBroker,
      botId,
      actorId,
      auditStore: bootAuditStore,
      initiator,
    }),
  ];

/** One person's standing instructions, for both the /api/settings routes and every run they start. */
const userInstructionsStore = createUserInstructionsStore(database);

/*
 * What this person has told every built-in coworker they run.
 *
 * Per actor and read per build, for the reason every other per-person fact here is: somebody who
 * edits their instructions and sends a message expects the message to land on the new ones, and a
 * value captured at boot would serve the whole deployment whatever the first person to sign in had
 * written.
 */
const loadInstructionsForActor = (actorId: string) => () =>
  userInstructionsStore.read(actorId);

/*
 * The file behind an attachment reference, read when a turn turns out to name one.
 *
 * Read per turn rather than held, for the reason the bytes are in the database at all: a message
 * carries a `/api/attachments/<id>` URL, and a model provider is not going to go and fetch it. The
 * row is fetched here and the bytes go up inline, so the Bot sees the file the person attached
 * instead of a link it cannot follow.
 *
 * Built per actor and passed to both turn paths — the request path through `mountCopilotRuntime` and
 * a routine's turn through `buildAgentFor` — so a routine firing at three in the morning inlines
 * exactly as a person's chat turn does, on exactly the same footing.
 *
 * NARROWED BY ACTOR AND BY CONVERSATION, and not silent. The reference reaches the loader out of
 * browser-supplied message content, so a turn can name an attachment in a channel the asker was
 * never in — or in one they ARE in but which is not the channel this turn is running in.
 * `loadAttachmentForTurn` answers both with the same membership join the fetch route uses plus the
 * run's own thread, and null when there is no row this person may see here.
 * `resolveAttachmentParts` fails the turn on that null rather than letting a Bot read a file back
 * to somebody who cannot open it.
 *
 * The thread is the CLOSURE'S ARGUMENT rather than something baked in beside the actor, because one
 * of these is built per actor per request and then used for however many runs that request makes;
 * a thread captured here would be the first run's, silently, for all of them.
 *
 * A PURE READ. `attachedAt` is written by the send rather than by anything here; see
 * `markAttachmentsSentForActor` below.
 */
const loadAttachmentForActor =
  (actorId: string) => (id: string, threadId: string) =>
    loadAttachmentForTurn(database, { actorId, threadId }, id);

/**
 * That the files on a message went out in it, recorded when a turn turns out to be a send.
 *
 * Bound per actor and handed to the same two turn paths as the reader above, so a routine's send at
 * three in the morning is recorded exactly as a person's chat turn is. `inlineAttachments`
 * (copilot.ts) calls it with the ids on the message being asked about and no others: history is
 * replayed on every turn and by whoever is running it, so nothing behind that message is evidence
 * of a send.
 *
 * NARROWED BY ACTOR, and more strictly than the reader is. Reading is scoped to channel
 * membership, because members are meant to see each other's sent files; recording a send is scoped
 * to the UPLOADER, because `attachedAt` is what the sweeper, the upload cap and the withdrawal
 * route all read as "this file rode in a message somebody sent" — and a member who could write it
 * on a colleague's staged row would freeze that colleague's own withdrawal at 409 and leave the row
 * unsweepable. See `markAttachmentsSent` in channels/attachments.ts.
 *
 * AND NARROWED BY CONVERSATION, taking the thread as an argument for the reason the reader does.
 * A stamp written against a channel that never saw the file freezes the row the same way, and is
 * reached without any colleague being involved: one person, two channels of their own, a file
 * named from the wrong one.
 */
const markAttachmentsSentForActor =
  (actorId: string) => (ids: readonly string[], threadId: string) =>
    markAttachmentsSent(database, { actorId, threadId }, ids);

/*
 * What the deployment tells a remote Bot about the run it is starting.
 *
 * Signed here, where the encryption key lives, so the runtime module never holds a secret. The Bot
 * hands this back when it calls a tool, and it is where the Bot id and the person's name come
 * from: its own token proves which agent is calling, this proves who it is calling for, and
 * neither is read out of the request body any more.
 */
const signRunForActor =
  (actorId: string, initiator: AuditInitiator = PERSON_INITIATOR) =>
  (botId: string, runId: string, threadId?: string, handedOn?: unknown) => {
    // How deep this run is, and which request it descends from, when it was handed work. Only the
    // deployment's own signed statement for the same person counts; anything else is a run a person
    // started, which is depth zero.
    const from = readRunAssertion(handedOn, config.keyEncryptionKey);
    const inherited = from?.actorId === actorId ? from : undefined;
    return mintRunAssertion(
      {
        botId,
        actorId,
        runId,
        threadId,
        initiator,
        ...(inherited
          ? {
              depth: inherited.depth ?? 0,
              ...(inherited.request ? { request: inherited.request } : {}),
            }
          : {}),
      },
      config.keyEncryptionKey,
    );
  };

/*
 * Which vendors this deployment connects to, held by a Bot or not.
 *
 * A Bot holding no grants used to be told nothing about connectors at all, so it treated a
 * connected vendor as an ordinary website and browsed to it: a Bot with no Drive grant opened
 * Google's sign-in page and asked a person to sign in to an account the deployment had already
 * connected. Naming them lets it say which one it has not been granted instead.
 *
 * Read per request rather than held, because a connector added a minute ago has to count.
 * Let failures reach buildAgents, which reports the missing guidance once and keeps the run usable.
 */
const loadVendors = async () =>
  (await pluginStore.listServers()).map((server) => server.id);

/*
 * How a run's tools are narrowed to the ones it is about.
 *
 * A model picks the right tool reliably out of about ten, and a deployment of this template
 * clears that as soon as it connects a second vendor. Past it the wrong tool gets called, or
 * none does and the answer comes from memory, and neither says so. So a Bot holding more than a
 * handful is offered the tools of the skills that match the message rather than everything at
 * once. See `plugins/selection.ts`.
 *
 * This narrows the offer and nothing else. What a Bot may call is the grant, checked in
 * `callTool` with the policy and the audit row exactly as before, so every path through here can
 * be wrong without a Bot gaining anything. That is also why every failure below is silent and
 * lands on the whole catalogue: the narrowing is worth an accuracy point, never a capability.
 */
const selectionForActor = (actorId: string): ToolSelection => ({
  loadSkills: (botId) => grantedSkills({ store: pluginStore, botId }),
  // The deployment's own model and key, the same pair the intent router uses, so selection is
  // never a second thing to configure. It throws on a missing key, which reads as "could not
  // choose" and leaves the whole catalogue offered.
  choose: chooseSkills,
  record: async (botId, selection) => {
    await recordAuditEvent(bootAuditStore, {
      eventType: "mcp.tools_discovered",
      targetType: "bot",
      targetId: botId,
      actorUserId: actorId,
      payload: {
        bot: botId,
        reason: selection.reason,
        granted: selection.granted,
        offered: selection.offered.length,
        skills: selection.skills,
      },
    });
  },
});

// Every run dials the stored endpoint again, so the check that was applied when it was
// registered has to be applied to wherever it redirects now.
// Absent computer configuration means nothing opted into private hosts, which is the safe
// reading and the same one `createApp` takes.
const agentFetch = createAgentFetch({
  allowPrivateHosts: config.computer?.allowPrivateHosts === true,
  // Named addresses are reachable on every hop, not only the one that was registered.
  allowedHosts: config.agentEndpointAllowedHosts,
  // The refusal is what the run already knows; this is what the deployment knows. Written here
  // rather than in `endpoint.ts` so that file keeps deciding and nothing else, the way the
  // target check it reuses does.
  onRefusal: ({ address, reason }) => {
    void recordAuditEvent(bootAuditStore, {
      eventType: "agent.dial_refused",
      targetType: "agent_endpoint",
      targetId: address,
      payload: { address, reason },
    }).catch((error) => {
      // A trail that cannot be written must not take a refusal down with it: the request is
      // already refused by the time this runs, and the alternative to a logged failure here is
      // an unhandled rejection.
      console.error("Could not record a refused agent dial.", error);
    });
  },
});

/**
 * Who a routine acts as, resolved the way {@link resolveRequestActor} resolves it.
 *
 * THE ROLE IS READ, NOT ASSUMED. Which coworkers exist is decided per person and an administrator
 * sees Bots a user does not, so hardcoding `role: "user"` here would hide an administrator's own Bots
 * from their own routine — the routine would fail with "that Bot is no longer registered" for a Bot
 * sitting in front of them in chat. This asks the same repository the request path asks, so a routine
 * sees exactly the coworkers its owner sees.
 */
const actorFor = async (ownerUserId: string): Promise<AgentActor> => {
  // One person, and they are an administrator. The id stays the routine owner's rather than being
  // rewritten to DEV_ACTOR's: in this mode they are the same person, and if they ever were not,
  // silently borrowing the dev actor's identity would be worse than finding nothing.
  if (config.singleUser) return { id: ownerUserId, role: DEV_ACTOR.role };
  const roles = await roleRepository.rolesForUser(ownerUserId);
  if (!roles.includes("admin") && !roles.includes("user")) {
    throw new Error("A routine requires an authorized owner.");
  }
  return {
    id: ownerUserId,
    role: roles.includes("admin") ? "admin" : "user",
  };
};

/**
 * One Bot, built for a routine's turn, as its owner.
 *
 * Per turn rather than per boot, for the same reason the request path rebuilds: a Bot registered or
 * edited since the last firing has to count, and a private coworker must be absent for everybody but
 * its owner. No header and no request are involved — the owner is asserted by construction, from the
 * routine row — which is the whole point of doing it here rather than adding an impersonation path to
 * a public route.
 */
const buildAgentFor = async ({
  ownerUserId,
  agentId,
  initiator,
}: {
  ownerUserId: string;
  agentId: string;
  initiator: AuditInitiator;
}) => {
  const actor = await actorFor(ownerUserId);
  const agents = await resolveRuntimeAgents(
    () => loadAgentsForActor(actor),
    runtimeModel,
    resolveRuntimeModelApiKey,
    stallGuard,
    loadToolsForActor(actor.id, initiator),
    signRunForActor(actor.id, initiator),
    config.computer ? COMPUTER_GUIDANCE : undefined,
    loadVendors,
    selectionForActor(actor.id),
    agentFetch,
    undefined,
    // Only the Bot this routine names. Same reason as the hop delivery: the roster is still read in
    // full so a Bot this owner cannot see is still absent, but the other Bots are neither built nor
    // asked what they hold.
    agentId,
    // The owner's own standing instructions. A routine is their work done while they are asleep, so
    // it is written the way they asked for it to be written, exactly as their chat turn would be.
    loadInstructionsForActor(actor.id),
    initiator,
    // The same reader the request path gets, bound to the owner the routine runs as, so a file
    // attached in a channel reads the same way on a routine's turn as it does on the person's own —
    // and is refused the same way when the owner is not in that channel.
    loadAttachmentForActor(actor.id),
    // And the same recorder, so the files on a routine's own message stop counting as staged the
    // moment it sends them, exactly as a person's do.
    markAttachmentsSentForActor(actor.id),
  );
  const agent = agents[agentId];
  if (!agent) {
    /*
     * Named, and raised rather than swallowed. The routine's Bot was deleted, or made private by
     * somebody else, or the owner lost the role that could see it. The runner turns this into a
     * failed run row with this sentence on it, the first failure is said once in the channel, and
     * the fatigue rule switches the routine off after ten — which is exactly the right handling for
     * a routine pointed at something that is not coming back.
     */
    const error = new Error(
      `That digital employee is no longer registered, so this routine has nothing to run: ${agentId}.`,
    );
    error.name = "RoutineBotNotRegistered";
    throw error;
  }
  return agent;
};

/*
 * The pair a headless turn is driven through, built ONCE.
 *
 * Not the runtime's own pair: `mountCopilotRuntime` keeps its client and its runner inside
 * `CopilotRuntime` and hands neither back, and reaching into that object would be a worse seam than
 * building our own from the same three settings. Built from `config.runtime.intelligence`, which is
 * required and not optional — `RuntimeCapabilities` has exactly one mode and every Intelligence field
 * with it (`config.ts:10-22`), and `loadConfig` refuses to boot without them — so there is no
 * not-in-Intelligence-mode branch to write here. If a second mode is ever added, THIS is the line that
 * has to grow a guard, and the routine runner must then be left off `createApp` entirely.
 *
 * One runner for the process, reused across firings: it opens a socket per run and holds no idle
 * connection, but its `threads` map is per instance, and a runner per turn would fragment the
 * already-running check that keeps two turns off one thread. See `routines/run-turn.ts`.
 */
const routineIntelligence = observeIntelligenceAuthentication(
  new CopilotKitIntelligence({
    apiUrl: config.runtime.intelligence.apiUrl,
    wsUrl: config.runtime.intelligence.gatewayWsUrl,
    apiKey: config.runtime.intelligence.apiKey,
  }),
);
const routineAgentRunner = new IntelligenceAgentRunner({
  url: routineIntelligence.ɵgetRunnerWsUrl(),
  authToken: routineIntelligence.ɵgetRunnerAuthToken(),
});

/*
 * Notifications to phones and browsers: only when the deployment has been given keys for them. The store
 * exists either way, so a person's devices are never lost to a restart without them.
 */
const pushStore = createPushStore(database);
const pushSender = config.webPush
  ? createPushSender({
      store: pushStore,
      send: webPushSend({
        publicKey: config.webPush.publicKey,
        privateKey: config.webPush.privateKey,
        subject: config.webPush.subject,
      }),
    })
  : undefined;

const routineRunner = createRoutineRunner({
  routineStore,
  channelStore,
  ...(pushSender
    ? { notify: (userId, message) => pushSender.notify(userId, message) }
    : {}),
  runTurn: createTurnRunner({
    intelligence: routineIntelligence,
    runner: routineAgentRunner,
    buildAgentFor,
  }),
});

/**
 * The runtime, and the two things beside it a hop needs.
 *
 * `agentFor` builds the addressed Bot exactly the way a person's run builds it, and `history` reads
 * the conversation through the same client. Taken from here rather than assembled again, because a
 * Bot built by parallel wiring drifts the first time one of these arguments changes, and the drift is
 * invisible: it runs, and quietly holds different tools or a different role from the one the person
 * is talking to.
 */
const modelForActor = createModelForActor(
  modelConnectionStore,
  agentFetch,
  starterModel,
);

const runSlots = createRunSlots(database);
// Which payment provider takes the money. "manual" until one is chosen: staff set plans by hand.
// "sandbox" runs the whole flow with a signed fake and no money, for demonstrations and tests.
const billing: BillingProvider = billingFromEnvironment(process.env, {
  appUrl: config.appUrl ?? config.publicUrl,
});
const runGateOptions = {
  accounts: accountStore,
  slots: runSlots,
  cloud: { gate: cloudGate, meter: cloudMeter },
};

const copilotRuntime = mountCopilotRuntime(
  config,
  runtimeModel,
  loadAgentsForActor,
  resolveRuntimeModelApiKey,
  identifyUser,
  identifyActor,
  stallGuard,
  loadToolsForActor,
  signRunForActor,
  undefined,
  loadVendors,
  selectionForActor,
  agentFetch,
  /*
   * What a Bot may reach past itself for: another Bot, and a person. Made per run and per person.
   *
   * Per person because which Bots may be reached is decided against the roster that person can
   * see: a Bot must never be able to address one they cannot, or this becomes a way around agent
   * visibility. Per run because the caps need to know how deep the chain already is and where an
   * answer belongs, and both of those are the deployment's own statement about the run rather than
   * anything the model can edit.
   */
  createRunTools({
    keyEncryptionKey: config.keyEncryptionKey,
    handoff: config.handoff,
    desk: handoffDesk,
    botsReachableFrom: (botId) => pluginStore.botsReachableFrom(botId),
    auditStore: bootAuditStore,
    team: teamToolDependencies,
  }),
  // A run started or ended on a thread; light the channel it belongs to. Fire-and-forget, keyed by
  // thread, and a scratch thread maps to no channel and signals nowhere.
  (input) => {
    void channelStore.signalBusy(input.threadId, input.busy).catch(() => {});
  },
  // What this person has told every coworker of theirs, in every channel. See user-instructions.ts.
  loadInstructionsForActor,
  // The files on a message, put in front of the model rather than left as links it cannot follow —
  // and only the ones the person whose run this is could open themselves.
  loadAttachmentForActor,
  // And that those files went out in a send, written by the person who sent them and only for rows
  // they uploaded. See markAttachmentsSentForActor.
  markAttachmentsSentForActor,
  // The model this person chose for themselves, if they chose one. See models/for-actor.ts.
  modelForActor,
  // The plan's limit on how many Bots work at once. See accounts/run-gate.ts.
  (actor) => (botId, agent) =>
    new RunGateAgent(agent, { actorId: actor.id, botId }, runGateOptions),
);

/**
 * Delivering hops, on every replica.
 *
 * A loop rather than a schedule, because a hop is somebody waiting for an answer rather than
 * housekeeping: the culler's minute-granularity CronJob would be an unexplainable pause in a
 * conversation. Every replica sweeps, and the queue decides which of them gets which hop, so adding a
 * replica adds delivery capacity rather than contention.
 *
 * ALWAYS, NOT ONLY WHERE HANDING WORK BETWEEN EMPLOYEES IS SWITCHED ON. It used to be gated on the
 * two caps, because a deployment that set either to zero never had a hop to deliver. It does now: the
 * outcome of a call held for a person's approval is delivered into its conversation through this
 * same queue (approvals/held.ts), and a deployment that switched hand-offs off still has employees
 * whose calls wait for a person. The wake-up below keeps the idle cost to the backstop poll.
 */
/**
 * The queue's own wake-up.
 *
 * Held at module scope so the shutdown below can give its connection back.
 */
let workOfferedListener: WorkOfferedListener | undefined;

{
  const runner = createHandoffRunner({
    queue: createWorkQueue(database),
    owner: workOwner("handoff"),
    auditStore: bootAuditStore,
    /*
     * The signed statement of the run the addressed Bot is about to start, carrying how deep the
     * chain has gone. Minted here, where the key lives, and one deeper than the run that asked.
     */
    sign: (work) => signHandoffDeliveryRun(work, config.keyEncryptionKey),
    delivery: createHandoffDelivery({
      /*
       * Built as the person, WITH THEIR ROLE. The desk resolved it to decide the hop was allowed; a
       * delivery that then rebuilt them as an ordinary user could not find the Bot the desk had just
       * agreed to, and the person was told it never answered.
       */
      agentFor: async ({ actorId, botId, fromBotId }) => {
        const actor = await actorFor(actorId).catch(() => null);
        if (!actor) {
          throw new Error(
            "who this is for could not be confirmed, so the digital employee was not run",
          );
        }
        return copilotRuntime.agentFor({
          actor,
          botId,
          initiator: { kind: "handoff", id: fromBotId },
        });
      },
      history: copilotRuntime.history,
      lock: copilotRuntime.threadLock,
      /*
       * A scratch thread of the addressed Bot's own, one per hop.
       *
       * An Intelligence thread has exactly one agent, so a second Bot cannot answer inside the first
       * Bot's conversation however it asks. Its turn runs here instead, unmapped to any channel, and
       * what it said comes back to the conversation that asked through the relay — in the asking
       * Bot's voice, which is the only voice that thread admits. Minted with the deployment's own
       * identity, like every thread this deployment starts.
       */
      mintThreadId: () => threadIdentity.mint(),
      /*
       * The roster, told that a relayed answer landed. The delivery knows only the thread it ran
       * in; this resolves which channel shows that thread — a scratch thread maps to nothing and
       * announces nowhere, which is the point of a scratch thread.
       */
      announce: async (input) => {
        const [mapped] = await database
          .select({ channelId: intelligenceChannelMappings.channelId })
          .from(intelligenceChannelMappings)
          .where(eq(intelligenceChannelMappings.threadId, input.threadId))
          .limit(1);
        if (!mapped) return;
        const actor = await actorFor(input.actorId).catch(() => null);
        if (!actor) return;
        await channelStore.recordActivity(actor, mapped.channelId, {
          text: input.text,
          agentId: input.agentId,
          at: new Date(),
        });
      },
      // The asking conversation shown as working while a hop runs in it. Keyed by thread, resolved
      // to its channel by the store; a scratch thread maps to none and signals nowhere.
      setBusy: (input) => channelStore.signalBusy(input.threadId, input.busy),
      newRunId: () => randomUUID(),
      // The same address and the same token the runtime uses. Assembling either from configuration
      // produced a runner every join was refused for, because the thread's active run is a lock the
      // platform issues rather than something an API key can claim.
      runner: new IntelligenceAgentRunner(
        copilotRuntime.runnerConnection(),
      ) as never,
    }),
  });

  const sweep = async () => {
    try {
      const report = await runner.sweep();
      if (report.delivered.length > 0 || report.skipped.length > 0) {
        console.info(JSON.stringify({ type: "bot-handoff", ...report }));
      }
    } catch (error) {
      // A sweep that failed must not take the loop with it: the next one may find the database back.
      console.warn(
        "[handoff] a sweep could not run:",
        error instanceof Error ? error.message : error,
      );
    }
  };

  /*
   * ONE SWEEP AT A TIME ON THIS REPLICA, from both callers below. A sweep poked while one is
   * running is remembered rather than started, and runs once the current one ends — a wake-up
   * that arrived mid-sweep may be for a hop the running sweep's claim already missed.
   */
  let sweeping = false;
  let sweepAgain = false;
  const kick = async () => {
    if (sweeping) {
      sweepAgain = true;
      return;
    }
    sweeping = true;
    try {
      do {
        sweepAgain = false;
        await sweep();
      } while (sweepAgain);
    } finally {
      sweeping = false;
    }
  };

  /*
   * Woken by the queue itself, from any replica: a person is waiting through every hop, and the
   * poll below would spend up to two seconds per leg doing nothing. The poll stays as the
   * backstop — a notification is a latency optimisation, and one lost in transit costs one
   * interval, never the work. See repeatAfterEach for why an interval must not be used: an
   * interval would start another sweep every two seconds while a five-minute delivery runs, each
   * claiming a different batch, and this replica's concurrent agent runs would grow with the
   * backlog rather than stopping at the limit it was asked for.
   */
  workOfferedListener = await startWorkOfferedListener(
    config.databaseUrl,
    (kind) => {
      if (kind === HANDOFF_KIND) void kick();
    },
  );
  repeatAfterEach(kick, 2_000);
}

/*
 * And dropping the hops that are over, whether or not the capability is switched on.
 *
 * OUTSIDE THE GATE ABOVE, deliberately. A deployment that switches handing work off still has
 * whatever it made while it was on, and rows that stop being reaped are rows that stay at the head
 * of the queue: switched back on a month later, the first thing that happens is a month-old question
 * being delivered to somebody who has long since stopped waiting. Reaping is housekeeping about the
 * past rather than part of the feature.
 *
 * Every replica reaps; the statement is a delete by age, so two doing it is the same as one doing it.
 * Its own loop rather than a phase of the sweep, so an hour of failing to reap never delays an answer.
 */
const reaper = createHandoffRunner({
  queue: createWorkQueue(database),
  owner: workOwner("reaper"),
  sign: () => "",
  auditStore: bootAuditStore,
  // Never called: `reap` deletes rows by age and claims nothing.
  delivery: {
    deliver: async () => {
      throw new Error("the reaper does not deliver hops");
    },
  },
});
repeatAfterEach(
  async () => {
    try {
      const purged = await reaper.reap();
      if (purged > 0) {
        console.info(JSON.stringify({ type: "bot-handoff-reaped", purged }));
      }
    } catch (error) {
      console.warn(
        "[handoff] hops that are over could not be dropped:",
        error instanceof Error ? error.message : error,
      );
    }
  },
  60 * 60 * 1_000,
);

/*
 * Naming conversations, in the API process rather than `worker/`, which the single-image container
 * does not run. Its own loop, so a slow model never delays a hop.
 */
const channelSummaries = {
  database,
  queue: createWorkQueue(database),
  transcript: routineIntelligence,
  title: withPersonalModel(
    createChannelTitler({
      model: runtimeModel.defaultModel,
      resolveApiKey: resolveRuntimeModelApiKey,
    }),
    async (userId) => (await modelForActor(userId))?.connection,
  ),
  owner: workOwner("summariser"),
};
repeatAfterEach(async () => {
  try {
    await offerChannelsAwaitingSummary(channelSummaries);
    const report = await summariseClaimedChannels(channelSummaries);
    if (report.written.length > 0) {
      console.info(
        JSON.stringify({ type: "channel-summaries", written: report.written }),
      );
    }
    // Same pass: one statement, deletes by age, and two replicas running it changes nothing.
    await forgetSettledSummaries(channelSummaries);
  } catch (error) {
    // Never fatal, and never loud enough to drown the log: a deployment with no model configured
    // reaches this on every pass, and it has not gone wrong, it simply has no titles.
    console.warn(
      "[channels] conversations could not be named:",
      error instanceof Error ? error.message : error,
    );
  }
}, 10_000);

const app = createApp(
  config,
  auth,
  roleRepository,
  createAuditReader(database),
  createCredentialAdminService(
    config.keyEncryptionKey,
    credentialStore,
    createAuditStore(database, auditShipping),
  ),
  createPackageStatusReader(database),
  // The runtime call: the model, per-actor agent loading, and the two identity
  // functions are how a run is attributed to a person.
  copilotRuntime.handler,
  // The only path to an acting call.
  computerGateway,
  policyStore,
  // Bots as durable objects, and the channels they run in.
  agentProfileStore,
  channelStore,
  channelEvents,
  // The same store the boot row uses, so a Bot's own refusal lands in the trail beside its actions.
  bootAuditStore,
  componentStore,
  // MCP servers and packaged skills. Judged by the same policy the computer actions are, read
  // fresh on every call for the same reason: a rule added a moment ago applies to the next call.
  pluginStore,
  // Components authored in the browser. Their governance is the component store's; this owns only
  // the source, which is the part a rebuild would otherwise have owned.
  sandboxedStore,
  // How a thread that has no channel is named, so the direct Bot chat is in the same namespace.
  threadIdentity,
  // Who has signed in, and what an administrator may do about them.
  peopleStore,
  // The enterprise identity providers registered here. Read as facts about the deployment rather
  // than through Better Auth's own listing, which answers per person. See identity-provider-store.ts.
  identityProviderStore,
  // Chooses the coworker for an untagged message, on the deployment's own model and key.
  intentRouter,
  // What a browsing turn's screen looked like when it finished, so the transcript can show it later.
  pageFrameStore,
  // What a due routine actually does: a turn, run as its owner, into the thread they will open.
  routineRunner,
  // A person's own standing instructions: the list, and a switch to stop one.
  routineStore,
  // Where each person is in first-run onboarding, read by /api/me and written by the wizard.
  createOnboardingStore(database),
  // The same store every run reads through `loadInstructionsForActor`, so the screen a person edits
  // and the prompt their coworker is built from can never be two different pieces of text.
  userInstructionsStore,
  // The same database every other store here is built from, so a channel's staged and sent files
  // live behind the same connection as the messages that reference them.
  database,
  // Native host-folder sessions are session-only: grants disappear with this server process and the
  // desktop worker must authenticate with a fresh token for this run.
  hostAccessBroker,
  process.env.OPENBOT_DESKTOP_HOST_TOKEN,
  async ({ name, args, botId, actorId, initiator, run }) => {
    if (name.startsWith("team_")) {
      // Built per call, with the signed run, so asking a colleague knows which conversation it is in.
      const tool = (
        await teamTools({ deps: teamToolDependencies, botId, actorId, run })
      ).find((candidate) => candidate.name === name);
      if (!tool) {
        return {
          text: `${REFUSAL_MARKER} That tool is not available to this digital employee.`,
          isError: true,
        };
      }
      const text = await tool.execute(args);
      return { text, isError: text.startsWith(REFUSAL_MARKER) };
    }
    if (name.startsWith("memory_")) {
      const tool = memoryTools({ store: memoryStore, botId, actorId }).find(
        (candidate) => candidate.name === name,
      );
      if (!tool) {
        return {
          text: `${REFUSAL_MARKER} That tool is not available to this digital employee.`,
          isError: true,
        };
      }
      const text = await tool.execute(args);
      return { text, isError: text.startsWith(REFUSAL_MARKER) };
    }
    if (!name.startsWith("host_")) return null;
    const tool = hostAccessTools({
      broker: hostAccessBroker,
      botId,
      actorId,
      auditStore: bootAuditStore,
      ...(initiator ? { initiator } : {}),
    }).find((candidate) => candidate.name === name);
    if (!tool) {
      return {
        text: `${REFUSAL_MARKER} That host tool is not available for this digital employee right now.`,
        isError: true,
      };
    }
    const text = await tool.execute(args);
    return { text, isError: text.startsWith(REFUSAL_MARKER) };
  },
  // The app directory, behind the same client the plugin store and the transport already share.
  // Absent without a key, which leaves the routes reporting no broker rather than listing apps
  // nobody could connect.
  composio ? { broker: composio.broker } : undefined,
  process.env.OPENBOT_MODEL_OAUTH_FILE?.trim()
    ? createProviderOAuthProxy(process.env.OPENBOT_MODEL_OAUTH_FILE.trim())
    : undefined,
  createUserPreferencesStore(database),
  {
    store: createVoiceSessionStore(database, channelStore),
    summarize: createVoiceSummarizer({
      model: runtimeModel,
      resolveApiKey: resolveRuntimeModelApiKey,
    }),
    channels: channelStore,
  },
  {
    store: modelConnectionStore,
    encryptionKey: config.keyEncryptionKey,
    fetchImpl: agentFetch,
    ...(starterModel ? { starter: starterModel } : {}),
    ...(config.offlineModel ? { offline: config.offlineModel } : {}),
    // The roster the person talks to is the roster they may choose a model for.
    botVisible: async (actor, botId) =>
      (
        await loadAgentsForActor({
          id: actor.id,
          role: actor.role === "admin" ? "admin" : "user",
        })
      ).some((agent) => agent.id === botId && agent.type !== "unavailable"),
    allowPrivateHosts: config.computer?.allowPrivateHosts === true,
    ...(config.agentEndpointAllowedHosts
      ? { allowedHosts: config.agentEndpointAllowedHosts }
      : {}),
  },
  {
    store: accountStore,
    billing,
    webhook: createBillingWebhook({
      database,
      accounts: accountStore,
      providers: new Map([[billing.id, billing]]),
    }),
  },
  marketplaceStore,
  {
    database,
    accounts: accountStore,
    billing,
    // The conversation service, which holds the conversations this person has had.
    conversations: hubConversations({
      apiUrl: config.runtime.intelligence.apiUrl,
      apiKey: config.runtime.intelligence.apiKey,
    }),
    // An integration vendor asked to forget the person's connected apps, where one is configured.
    ...(composio
      ? {
          revokeIntegration: (request) => composio.broker.revoke(request),
        }
      : {}),
  },
  {
    config: config.cloud,
    gate: cloudGate,
    store: cloudStore,
    meter: cloudMeter,
    database,
  },
  // Which version of the terms each person accepted; asked of customers only when the deployment
  // requires it (TERMS_ACCEPTANCE=required).
  createTermsStore(database, {
    version: TERMS_VERSION,
    required: config.termsAcceptance === "required",
  }),
  // What an administrator sees first: counts, the settings read back, this month's cloud cost.
  {
    store: createOverviewStore(database),
    facts: async () =>
      deploymentFacts({
        config,
        billing,
        billingMode: accountStore.billingMode,
        cloudPriced: (await cloudStore.rates()) !== null,
      }),
    ...(config.cloud.mode === "off"
      ? {}
      : {
          cloud: {
            mode: config.cloud.mode,
            store: cloudStore,
            meter: cloudMeter,
          },
        }),
  },
  // Notifications: a person's devices, and whether this deployment can send to them.
  pushSender && config.webPush
    ? {
        store: pushStore,
        sender: pushSender,
        publicKey: config.webPush.publicKey,
        extraHosts: config.webPush.allowedHosts,
      }
    : undefined,
  // What a digital employee asked to change about another's work, waiting for its owner.
  approvalStore,
  // What each digital employee keeps in mind, for its owner to read and correct.
  memoryStore,
  // Whether a person is in the conversation a browser names, for a held action's outcome.
  createConversationOwnership(database),
);

// Numbers about the service and the business, for whoever runs it: on a port of its own, and only
// when one is configured (docs/ark/13-azure-hosting.md, "What to watch").
registerBusinessMetrics(serverMetrics, database);
if (config.metricsPort) {
  serveMetrics(serverMetrics, config.metricsPort);
  console.log(
    JSON.stringify({ type: "metrics-listening", port: config.metricsPort }),
  );
}

/**
 * The live screen, proxied.
 *
 * Proxied rather than connected directly. `agent-computer` authenticates its callers with a
 * shared token, not with a person's session, and it must never be reachable from a browser. So the
 * socket terminates here, behind the same session guard as every other route, and this process opens
 * a second socket inward carrying the token.
 *
 * Not a Hono route because an upgrade is not a request/response: Bun hands it over before Hono sees a
 * body, so it is handled in `fetch` ahead of the app.
 */
const toStreamUrl = (baseUrl: string, botId: string) =>
  // The Bot travels in the query, because a websocket upgrade carries no custom header for the
  // computer to read and every call it serves is per Bot. The secret travels the same way and for the
  // same reason, this socket is the one a person can type into, so it is the last thing that should
  // be reachable without it.
  `${baseUrl.replace(/^http/, "ws").replace(/\/$/, "")}/stream?bot=${encodeURIComponent(botId)}&token=${encodeURIComponent(config.computer?.token ?? "")}`;

/**
 * Which Bot's screen. The Bot is named in the path and its computer is located the same way every
 * other call locates it, so the live stream cannot point at a different Bot's browser.
 */
const streamPathBotId = (pathname: string): string | null => {
  const match = pathname.match(/^\/api\/computers\/([^/]+)\/stream$/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
};

/** What each proxied socket carries: where to connect inward, and the socket once opened. */
type StreamData = { upstream: string; inward?: WebSocket };

/**
 * Bun takes exactly one WebSocket handler for the server, and two features need one: the app proxies
 * the computer stream, and it pushes channel activity through Hono's adapter. So this one
 * dispatches on what the upgrade attached, a proxy socket carries `upstream`, a Hono socket does
 * not, rather than either feature quietly taking the slot and breaking the other on connect.
 */
type ChannelSocket = Parameters<typeof channelSocket.open>[0];
type SocketData = StreamData | ChannelSocket["data"];

const isProxiedStream = (data: SocketData): data is StreamData =>
  typeof (data as StreamData).upstream === "string";

// Hono owns the socket's data once it has upgraded it; this hands its own back to it.
const asChannelSocket = (ws: { data: SocketData }) =>
  ws as unknown as ChannelSocket;

// Whether this process may be sent requests: its database answers, and it has not been told to stop.
// `/health` stays the question of whether it is alive and does not ask the database. Answered here, before
// the application, so it cannot be held up by anything the application does.
const lifecycle = { draining: false };
const readiness = createReadiness({
  ping: () => database.execute(sql`select 1`),
  draining: () => lifecycle.draining,
});

const serverOptions = {
  port,
  // The largest thing legitimately sent here is a conversation with attachments inlined (up to 32 MB
  // of files, a third more as base64). Bun's own ceiling is 128 MB, which is a reason for nobody;
  // JSON endpoints are held to far less by `jsonBodyLimit`.
  maxRequestBodySize: MAX_REQUEST_BYTES,
  async fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/ready" && request.method === "GET") {
      const answer = await readiness();
      return Response.json(
        { status: answer.status },
        { status: answer.ok ? 200 : 503 },
      );
    }
    if (url.pathname === "/api/audio/transcriptions") {
      server.timeout(request, DICTATION_HTTP_IDLE_SECONDS);
    }
    if (url.pathname === "/api/voice/calls") server.timeout(request, 30);
    if (url.pathname === "/api/voice/sessions") server.timeout(request, 30);
    const streamBotId = streamPathBotId(url.pathname);
    if (
      streamBotId !== null &&
      request.headers.get("upgrade")?.toLowerCase() === "websocket"
    ) {
      if (!config.computer) {
        return new Response("No computer is configured.", { status: 503 });
      }
      // Whose page opened this socket, before anything else: a handshake carries the cookie. Applied by
      // hand, like the session guard, because the app's middleware does not run on this path.
      if (!originAllowed(request.headers, streamOrigins)) {
        return new Response("This request came from another website.", {
          status: 403,
        });
      }
      // The session guard, applied by hand because middleware does not run on an upgrade. An
      // unauthenticated socket here would be the whole point of the proxy defeated.
      const actor = await resolveRequestActor(request).catch(() => null);
      if (!actor) {
        return new Response("Sign in first.", { status: 401 });
      }
      // And which Bot, which the guard above does not answer. This socket carries that Bot's screen,
      // so signing in is not enough: without this, anybody signed in watches anybody's Bot work.
      if (
        !(await agentProfileStore
          .get({ id: actor.id, role: actor.role }, streamBotId)
          .catch(() => null))
      ) {
        return new Response("There is no such digital employee.", {
          status: 404,
        });
      }
      /*
       * Through the gateway, not the provider.
       *
       * `gateway.locate` runs checkComputerAddress; `provider.locate` does not, and the URL built
       * below carries COMPUTER_TOKEN in its query string. A provider that answered with a foreign
       * host was handed the deployment's computer token, which is the case that check was written
       * for. Every acting path already went through the gateway; this one did not.
       */
      let upstream: string;
      try {
        const streamBase = computerGateway
          ? await computerGateway.locate(streamBotId)
          : undefined;
        if (!streamBase) {
          return new Response("No computer address is configured.", {
            status: 503,
          });
        }
        upstream = toStreamUrl(streamBase, streamBotId);
      } catch (error) {
        // Said out loud rather than falling back to another Bot's computer, which is the failure this
        // whole path exists to prevent.
        return new Response(
          error instanceof Error
            ? error.message
            : "That digital employee's computer could not be reached.",
          { status: 502 },
        );
      }
      if (server.upgrade(request, { data: { upstream } })) {
        return undefined as unknown as Response;
      }
      return new Response("Expected a WebSocket upgrade.", { status: 400 });
    }
    return app.fetch(request, { server });
  },
  websocket: {
    open(ws) {
      if (!isProxiedStream(ws.data)) {
        channelSocket.open(asChannelSocket(ws));
        return;
      }
      const inward = new WebSocket(ws.data.upstream);
      ws.data.inward = inward;
      // Frames outward, input inward. Buffered by neither side: a frame the browser is too slow for
      // should be dropped, not queued, because a stale frame is worse than a missing one.
      inward.onmessage = (event) => {
        try {
          ws.send(String(event.data));
        } catch {
          inward.close();
        }
      };
      inward.onclose = () => ws.close();
      inward.onerror = () => ws.close();
    },
    message(ws, raw) {
      if (!isProxiedStream(ws.data)) {
        channelSocket.message(asChannelSocket(ws), raw);
        return;
      }
      if (ws.data.inward?.readyState === 1) ws.data.inward.send(String(raw));
    },
    close(ws, code, reason) {
      if (!isProxiedStream(ws.data)) {
        channelSocket.close(asChannelSocket(ws), code, reason);
        return;
      }
      ws.data.inward?.close();
    },
  },
} satisfies Parameters<typeof serve<SocketData>>[0];

/*
 * One listener per address in LISTEN_HOSTS, or one on every interface when it is unset. The desktop
 * sets loopback: in single-user mode every request is the computer's one administrator, and this
 * listened on every interface, so anyone on the same network reached an administrator's API.
 */
const hosts = listenHosts(process.env.LISTEN_HOSTS);
const servers =
  hosts.length > 0
    ? hosts.map((hostname) => serve<SocketData>({ ...serverOptions, hostname }))
    : [serve<SocketData>(serverOptions)];

// Writes down every route this process registered, for the security tests (server/tests/security), which
// need the real inventory: `createApp` registers a route only when the store behind it was given, so an
// app built anywhere else has fewer routes than this one. Off unless asked for, and it reads nothing but
// the route table. Done here rather than by importing this file, because importing the entry point as a
// module changes when its top-level awaits settle, and a dependency that loads CommonJS then fails
// intermittently ("require() async module") under Bun, which the entry point itself never does.
if (process.env.ARK_DUMP_ROUTES) {
  await Bun.write(
    process.env.ARK_DUMP_ROUTES,
    JSON.stringify(
      app.routes
        .filter(
          (route) =>
            ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(route.method) &&
            !route.path.includes("*"),
        )
        .map((route) => ({ method: route.method, path: route.path })),
    ),
  );
}

if (config.singleUser) {
  // Loud, every boot. A server that is not checking who is asking should never be a quiet default.
  console.warn(
    "No identity provider is configured, so every request is treated as " +
      `${DEV_ACTOR.email} (administrator). Configure GOOGLE_OAUTH_*, ` +
      "MICROSOFT_OAUTH_* or OKTA_OAUTH_* before anybody else can reach this.",
  );
}

// Leaving is not exiting: a deploy replaces every pod, and exiting on the spot would end every reply
// being streamed to somebody. The process keeps serving while it is taken out of rotation, stops
// listening, waits for what is under way, then closes the rest (shared/drain.ts).
//
// Each listener holds a connection of its own for the life of the process. Released on the way out, so
// a watch-mode restart does not leave two behind on every reload.
const drain = createDrain({
  pending: () =>
    servers.reduce((sum, listening) => sum + listening.pendingRequests, 0),
  stopListening: () => {
    for (const listening of servers) void listening.stop();
  },
  closeAll: () => {
    for (const listening of servers) void listening.stop(true);
  },
  cleanup: () =>
    Promise.allSettled([
      channelActivityListener.stop(),
      policyListener.stop(),
      // Started only where handing work between Bots is switched on, so it is often not there.
      workOfferedListener?.stop() ?? Promise.resolve(),
      Promise.resolve(retentionSweeps.stop()),
    ]),
  exit: (code) => process.exit(code),
  log: (line) => console.log(line),
  settleMs: config.shutdown.settleMs,
  graceMs: config.shutdown.graceMs,
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    lifecycle.draining = true;
    void drain.begin(signal);
  });
}

console.info(`OpenBot server listening on http://127.0.0.1:${port}`);
