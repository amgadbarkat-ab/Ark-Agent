# Connect your Data

Settings, Connect your Data (it was "Connected accounts") lists the places a person's work lives, so their digital employees
can read them **as that person**: they only see what the person's own account can see. A person connects their own account;
nobody can connect one for them.

## What each row means

| Row says | Because |
| --- | --- |
| **Connected** | This person has connected their account. |
| **Connect** | The connector is built, turned on, and has an OAuth client behind it (or registers its own), so pressing it reaches the vendor. |
| **Needs setup** | The connector is built, but nobody has turned it on or added the app's client id and secret yet. An administrator sets it up once (Admin, Plugins); on a single-user desktop that is the person. |
| **Not yet** | On the list because people ask. There is no connector, so there is nothing to connect. Listing a service is never a claim it works. |

The list is `app/src/lib/data-services.ts`; where a row stands is decided by `dataServiceState` from what the deployment says
about the connector, nothing else. "Your own tools" at the bottom is where an administrator adds any MCP server.

The Grok connectors page (grok.com/connectors) could not be read from here (it needs a signed-in browser), so the list is the
usual set, not a copy of theirs. Send the names that are missing.

## Microsoft 365 (new, read only, **not yet tried with a real account**)

One connector, `microsoft-365`, for Outlook mail, the calendar, Teams chats and SharePoint and OneDrive files, over Microsoft
Graph (`server/src/plugins/microsoft-graph-rest.ts`). Six tools: `outlook_search_mail`, `outlook_read_mail`,
`calendar_list_events`, `teams_list_chats`, `teams_read_chat`, `sharepoint_search_files`. Every scope is a `.Read` one, so
Microsoft refuses a write whatever this code does. It is tested against recorded shapes of Graph's answers, never against a
real account, and the screens say so until somebody has done that.

To turn it on, whoever runs the deployment registers ArkAgent in Microsoft Entra once:

1. Entra admin centre, App registrations, New registration. Supported account types: accounts in any organizational directory
   and personal Microsoft accounts (Teams chats and SharePoint answer only for work and school accounts).
2. Redirect URI (type Web): the address shown on Admin, Plugins, Microsoft 365 (`<public url>/api/plugins/oauth/callback`).
3. API permissions, Microsoft Graph, delegated: `offline_access`, `User.Read`, `Mail.Read`, `Calendars.Read`, `Chat.Read`,
   `Files.Read.All`, `Sites.Read.All`.
4. Certificates and secrets: a client secret.
5. Admin, Plugins, Microsoft 365: turn it on and paste the application (client) id and the secret.
6. For other companies' staff to consent, the app needs publisher verification; for their own staff, an administrator of that
   company may have to approve the app once.

## Models page and links

Settings, Models now asks what is running on this computer instead of assuming it (`GET /api/models/local`): Ollama, LM Studio
and llama.cpp each say "Running" or "Not running" at their usual address, and the model ArkAgent downloaded is listed first as
"ArkAgent offline model". The desktop writes `ARK_OFFLINE_MODEL_LABEL` for that. A link to another website (such as "Get a
key") opens in the person's own browser from the desktop window, through one permission that opens web addresses and nothing
else (`desktop/src-tauri/capabilities/app-links.json`); in an ordinary browser it works as any link does.
