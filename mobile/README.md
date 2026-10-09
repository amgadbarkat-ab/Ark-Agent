# Mobile apps

What is here and how to build it. Why it is this shape, what the stores require, and what the owner has
to provide are in [docs/ark/19-mobile.md](../docs/ark/19-mobile.md).

```
mobile/
  android/   The Google Play app: a Trusted Web Activity (Gradle project, no code of our own)
  scripts/   Checks the deployment's names and writes the file the Android build reads
  tests/     Tests for those checks
```

The iOS shell is not here yet (see the decision record).

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

The colours come from `app/public/manifest.webmanifest` and the icon from `app/public/icons/icon-192.png`,
so the app and the site look the same by construction (a test fails if the icon copy drifts).

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
