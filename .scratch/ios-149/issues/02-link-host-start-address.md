# Start address is the Ark Link host; bundle id blackark.arkagent

Status: claimed

- `ARK_LINK_URL` replaces `ARK_APP_URL` for iOS: https, no path, a domain name.
- Bundle id is the constant `blackark.arkagent`. `ARK_IOS_APP_ID` (team.bundle) becomes
  `ARK_IOS_TEAM_ID`, optional, needed only by the signed release.
- `ARK_IOS_URL_SCHEME` optional: the system-browser hand-off serves hosted deployments with Google
  sign-in, which the Ark Link app does not reach (see 04).

## Comments
