# Mobile apps

What is here and how to build it. Why it is this shape, what the stores require, and what the owner has
to provide are in [docs/ark/19-mobile.md](../docs/ark/19-mobile.md).

```
mobile/
  android/   The Google Play app: a Trusted Web Activity (Gradle project, no code of our own)
  ios/       The App Store app: a thin Capacitor shell around the site (the Xcode project is generated)
  scripts/   Check the deployment's names, and make or configure each app's project from them
  tests/     Tests for those checks
```

## Android

The app is Chrome with no address bar, showing the deployment's own site. It is tied to one site and
carries one package name, and neither is in the repository: a package name cannot be changed once it is
published, so it is the owner's to give.

### The names it needs

| Setting | What it is |
| --- | --- |
| `ARK_ANDROID_APP_ID` | The package name, such as `com.example.ark`. Permanent once published. |
| `ARK_APP_URL` | The site, `https://host`, with no path. A domain name, not an address. |
| `ARK_APP_NAME` | The name under the icon. Up to 30 letters, digits, spaces, dots, hyphens, underscores. |
| `ARK_ANDROID_VERSION_CODE` | A whole number that goes up with every upload to Google Play. |
| `ARK_ANDROID_VERSION_NAME` | Optional. Defaults to the repository's version. |

The colours come from `app/public/manifest.webmanifest`. The launcher icon is the company's tile, drawn as an
adaptive icon by `brand/render-icons.mjs` (ember background, the bars in front, a monochrome layer for themed
icons); phones too old for an adaptive icon get the company's 192 file, which is the site's own icon (a test
fails if the two drift).

### Build it by hand

Needs Java 21 and the Android SDK (platform 36, build-tools 36.0.0). `ANDROID_HOME` points at the SDK.

```sh
ARK_ANDROID_APP_ID=com.example.ark ARK_APP_URL=https://ark.example ARK_APP_NAME=Ark \
ARK_ANDROID_VERSION_CODE=1 bun mobile/scripts/prepare-android.ts

cd mobile/android
./gradlew assembleDebug            # an app you can install on a test phone
./gradlew lintRelease bundleRelease  # the bundle for Google Play
```

`prepare-android.ts` refuses a wrong or missing name with a sentence, before Gradle starts, and writes
`mobile/android/ark.properties` (not committed). The release is signed with the upload key if
`ARK_ANDROID_KEYSTORE_FILE` (a path), `ARK_ANDROID_KEYSTORE_PASSWORD`, `ARK_ANDROID_KEY_ALIAS` and
`ARK_ANDROID_KEY_PASSWORD` are in the environment, and is built unsigned, with a warning, if not. They are
read each time and written nowhere.

### Making Android drop the address bar

Android only removes it when the **site vouches for the app**. Set these on the server (docs/configuration.md)
and the site publishes `/.well-known/assetlinks.json`:

- `ARK_ANDROID_APP_ID`: the same package name.
- `ARK_ANDROID_CERT_SHA256`: the SHA-256 fingerprint of each key the app may be signed with. For an app
  uploaded to Google Play that is the Play Console's **App signing key certificate** (Play re-signs the
  app, so it is not your upload key's). To try a debug or sideloaded build, add that key's fingerprint
  too: `keytool -list -v -keystore <file> | grep SHA256`.

Check it from a phone: open `https://<site>/.well-known/assetlinks.json` and see the package and the
fingerprint. With a wrong fingerprint the app still opens, with an address bar, and says nothing.

### The release workflow

`.github/workflows/mobile-android.yml` builds and lints against made-up names on every change, and a
person can start it by hand to produce the signed bundle. For the by-hand run the owner sets, in a
GitHub environment named `mobile-release` (add required reviewers to it):

- variables `ARK_ANDROID_APP_ID`, `ARK_APP_URL`, `ARK_APP_NAME`;
- secrets `ARK_ANDROID_KEYSTORE_BASE64` (the upload key file, base64), `ARK_ANDROID_KEYSTORE_PASSWORD`,
  `ARK_ANDROID_KEY_ALIAS`, `ARK_ANDROID_KEY_PASSWORD`.

The bundle is kept as a build artifact. Uploading it to Google Play is done in the Play Console.

### Upgrading

Three things move on their own schedule and need a look about once a year, or when Play says so:
Google Play's lowest accepted `targetSdk` (raised every August; it is `targetSdk 36` in
`android/app/build.gradle`), the Android Gradle plugin (`android/build.gradle`) with the Gradle version
(`android/gradle/wrapper/gradle-wrapper.properties`, which pins the download's checksum), and the
`androidbrowserhelper` library.

## iOS

The app is a window onto the deployment's own site: nothing of the web app is bundled, so it is always
the version the server is running. Apple has no equivalent of Android's Trusted Web Activity, so this is
a native shell (Capacitor) around a web view. Two things follow from that, and both are handled:

- **Google refuses to sign anybody in inside a web view.** Signing in opens the system browser at
  `/api/auth/native` on the server, which signs in with the chosen provider and sends a one-time code
  back to the app by opening its own address (`<scheme>://signed-in`). The code is bound to a secret
  that never leaves the phone, works once, and is exchanged for a session of the app's own. Google and
  Microsoft sign-in work this way; company sign-in (Okta, a registered identity provider) is not offered
  in the app yet.
- **Apple does not allow Web Push in a web view.** The app has no notifications yet. They would need
  Apple's own push service (APNs) and a second sending path on the server; see the decision record.

### The names it needs

| Setting | What it is |
| --- | --- |
| `ARK_IOS_APP_ID` | The Apple team id, a dot, then the bundle identifier: `ABCDE12345.com.example.ark`. The same value the server publishes in `apple-app-site-association`. The bundle identifier is permanent once published. |
| `ARK_APP_URL` | The site, `https://host`, with no path. |
| `ARK_APP_NAME` | The name under the icon. |
| `ARK_IOS_URL_SCHEME` | The address scheme the system browser returns to, such as `arkapp`. Set the same value on the server (`ARK_IOS_URL_SCHEME`), which is what makes the sign-in page exist. Another app can claim the same scheme, which is why the code in it is useless without the secret. |
| `ARK_IOS_BUILD_NUMBER` | A whole number that goes up with every upload to App Store Connect. |
| `ARK_IOS_VERSION_NAME` | Optional, up to three numbers (`1.4.0`). Defaults to the repository's version. |

The App Store icon is a brand asset the owner provides at `mobile/ios/brand/AppIcon-1024.png`: a PNG of
exactly 1024 by 1024 pixels with **no transparency** (the build checks and says what is wrong). Without
it the app carries Capacitor's placeholder icon, which the App Store refuses.

### Make the project

```sh
(cd mobile/ios && bun install)
ARK_IOS_APP_ID=ABCDE12345.com.example.ark ARK_APP_URL=https://ark.example ARK_APP_NAME=Ark \
ARK_IOS_URL_SCHEME=arkapp ARK_IOS_BUILD_NUMBER=1 bun mobile/scripts/prepare-ios.ts
```

This works on any machine (Capacitor makes the Xcode project without Xcode), checks the names first, and
starts the project afresh each time so nothing from an earlier deployment's names can be left in it.
It adds the address scheme and the export-compliance answer to `Info.plist`, copies the icon, and prints
the version settings to hand to `xcodebuild`. **Building needs a Mac.** Open
`mobile/ios/ios/App/App.xcodeproj`, or run the commands in `.github/workflows/mobile-ios.yml`.

### The release workflow

`.github/workflows/mobile-ios.yml` makes the project against made-up names and builds it for the
simulator on every change, and a person can start it by hand to archive and export the signed app. For
the by-hand run the owner sets, in the same `mobile-release` GitHub environment as Android:

- variables `ARK_IOS_APP_ID`, `ARK_APP_URL`, `ARK_APP_NAME`, `ARK_IOS_URL_SCHEME`;
- secrets `ARK_IOS_ASC_KEY_BASE64` (an App Store Connect API key, the `.p8` file, base64),
  `ARK_IOS_ASC_KEY_ID`, `ARK_IOS_ASC_ISSUER_ID`.

Xcode signs with that key (automatic signing, certificates and profiles managed by Apple), so no
certificate or profile is stored. The `.ipa` is kept as a build artifact; uploading it to TestFlight and
the store is done in App Store Connect.

### Not done, and why

- **The project has never been compiled.** Capacitor makes it here; Xcode builds it, and there is no
  Xcode here. The workflow's first run is the first build.
- **No offline page in the app.** It would need the web view's app-bound-domains setting for a service
  worker to run, and an app that cannot be tested here should not be given a setting that can make the
  whole window refuse to load.
- **Links into the site do not open the app** (universal links). They need an Associated Domains
  capability in the project. Signing in does not depend on them.
