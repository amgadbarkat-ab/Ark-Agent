/**
 * Ark does not report usage to anyone.
 *
 * The CopilotKit SDK sends anonymous usage events to its vendor unless told not to, and reads that
 * choice from the environment once, when it is first imported. This module exists so the choice is
 * made in code rather than left to whoever writes the deployment's `.env`: it is imported before
 * anything that imports the SDK, so there is no moment at which telemetry could start.
 *
 * It sets the variable rather than only defaulting it. A deployment that really wants the vendor's
 * telemetry has to remove this import, which is a decision someone has to make on purpose.
 */
process.env.COPILOTKIT_TELEMETRY_DISABLED = "true";
process.env.DO_NOT_TRACK = "1";

export {};
