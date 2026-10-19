/**
 * The places a person's work lives, as the Connect your Data page lists them.
 *
 * A DIRECTORY, not a list of what works. Each entry says what ArkAgent has actually built for it:
 *
 *  - `connector` names a reviewed connector in this deployment's catalogue (server/src/plugins/catalogue.ts).
 *    That is the only thing that can ever make a row say "Connect".
 *  - An entry with no connector is on the list because people ask for it, and says "Not available yet".
 *    Listing a service is never a claim that it works: the catalogue was cut once for offering connectors
 *    nobody had tried, and this list must not put them back by another route.
 *
 * `setup` is what whoever runs the deployment has to do once before anybody can connect: register ArkAgent
 * as an app with the vendor, where the vendor gives no way to do it automatically. Until they have, the row
 * says "Needs setup" and says what.
 *
 * `untested` is true for a connector that has been written and tested against recorded answers only, and
 * never against a real account. It stays true until somebody has connected a real account and read a real
 * result, and the row says so in the meantime.
 */

export type DataService = {
  id: string;
  name: string;
  summary: string;
  /** The catalogue key of the connector ArkAgent has built for it, when there is one. */
  connector?: string;
  /** What has to be set up once, by whoever runs the deployment, before anybody can connect. */
  setup?: string;
  /** Built, but never tried against a real account. */
  untested?: boolean;
};

export const DATA_SERVICES: readonly DataService[] = [
  {
    id: "microsoft-365",
    name: "Microsoft 365",
    summary:
      "Outlook mail, Calendar, Teams chats and SharePoint and OneDrive files. Read only.",
    connector: "microsoft-365",
    setup:
      "An app registered in Microsoft Entra, with its client id and secret added by an administrator",
    untested: true,
  },
  {
    id: "google-drive",
    name: "Google Drive",
    summary: "Files in your Drive, including shared drives. Read only.",
    connector: "google-drive",
    setup:
      "A Google OAuth client, with its client id and secret added by an administrator",
  },
  {
    id: "gmail",
    name: "Gmail",
    summary: "Your mail.",
  },
  {
    id: "google-calendar",
    name: "Google Calendar",
    summary: "Your events and free time.",
  },
  {
    id: "notion",
    name: "Notion",
    summary: "The pages and databases you choose to share.",
    connector: "notion",
  },
  {
    id: "dropbox",
    name: "Dropbox",
    summary: "Your files.",
  },
  {
    id: "box",
    name: "Box",
    summary: "Your files.",
  },
  {
    id: "github",
    name: "GitHub",
    summary: "Repositories, issues and pull requests.",
  },
  {
    id: "linear",
    name: "Linear",
    summary: "Issues and projects.",
  },
  {
    id: "jira",
    name: "Jira and Confluence",
    summary: "Issues, projects and pages.",
  },
  {
    id: "asana",
    name: "Asana",
    summary: "Tasks and projects.",
  },
  {
    id: "slack",
    name: "Slack",
    summary: "Channels and messages you can see.",
  },
  {
    id: "salesforce",
    name: "Salesforce",
    summary: "Accounts, contacts and deals.",
  },
  {
    id: "hubspot",
    name: "HubSpot",
    summary: "Contacts, companies and deals.",
  },
];
