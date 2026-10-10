# Crow Android companion — source MVP

Real Capacitor/React/xterm Android client for Crow on **Windows**. Linux hosts remain behind the open, awake Windows gateway. Local web bundle and Capacitor sync passed after explicit build authorization. **Native compilation and APK generation run in CI**, not on this SDK-less workstation. No emulator or phone validation has been performed.

## Debug APK CI

`.github/workflows/android-validation.yml` supports manual `workflow_dispatch` and reusable `workflow_call`. It installs Java21/SDK36/build-tools36.0.0 **on the GitHub runner only**, executes package tests and native JVM tests, bundles local assets, assembles and verifies a debug APK, then uploads:

- Artifact `crow-android`: `Crow-Companion-0.1.0-debug.apk` and `Crow-Companion-0.1.0-debug.apk.sha256` (standard SHA256 checksum format).
- Artifact `crow-android-test-reports`: JVM test results, manifest/badging and public signature metadata.

This APK is a **signed, debuggable TEST build**, not a production/Play Store release. No production signing identity or secrets are created. GitHub runner debug keys are ephemeral: a later APK may have a different signing certificate and require uninstall/reinstall. Uninstall removes local Keystore pairing, requiring a fresh Windows invitation. The CI signature, manifest and local asset checks do not prove camera/TLS/IME behavior on a real phone.

## Validate without building

From `C:\dev\crow-harnes\packages\android-companion`:

```powershell
npm ci --ignore-scripts --registry=https://registry.npmjs.org
npm run typecheck
npm test
```

Tests execute real JS enrollment validation, terminal byte encoding/replay cursor, readonly grants, input limits, quota freshness and static native security/project checks. Static checks do **not** prove Android compilation, TLS handshakes or device behavior. Java JUnit policy tests are included under `android/app/src/test/java/dev/crow/companion`; they remain unexecuted.

`npm run dev` offers a local UI development page, but native pairing/network calls deliberately have **no browser implementation or fake production data**. Camera and secure networking require Android.

## Android Studio handoff

Pinned official Capacitor8.5.3 Android template includes Gradle wrapper8.14.3, AGP8.13.0, Java21, compile/target SDK36, min SDK26. Official QR plugin `@capacitor/barcode-scanner@3.1.3` uses camera only when the user taps scan; denied/cancelled scanning supports JSON paste/file import.

1. Supply Android Studio2025.2.1+ and its Java21/SDK36 tooling yourself. This task installed **no OS SDK/JDK**. `java`, `javac`, `adb`, `gradle` were not in PATH; JAVA_HOME, ANDROID_HOME and ANDROID_SDK_ROOT were unset when checked.
2. Run `npm run build`, then `npm run sync:android` inside this package. This bundles local UI into Android assets and refreshes plugin metadata. No `server.url` or remote live-reload origin should be added to shipped config.
3. Open the package's `android` project in Android Studio. Set local SDK location there, run the supplied Java tests and device acceptance tests below, then compile/install using your signing setup.

There is no checked-in JS bundle, APK, keystore signing credential or real gateway credential. Local `npm run build` and `npm run sync:android` populated ignored app assets successfully; release validation regenerates them from source. CI success must be checked before claiming APK readiness. The initial Vite bundle is ~935 kB minified (~269 kB gzip); code-splitting is a later optimization, not a native-build gate.

## Pairing and transport

1. In Windows Crow, enable **individual user access**. Legacy/unsecured mode refuses Android enrollment; do not use a shared administrator credential.
2. Start Android gateway, select authorized projects and opt-in capabilities, and generate the version1 invitation. Scan its QR or paste/import the complete JSON. Invitations are short-lived, single-use, and contain no reusable bearer credential.
3. Choose **one exact offered endpoint** explicitly. LAN requires comparing the whole certificate's colon-delimited SHA256 fingerprint against Windows and confirming it. The leaf certificate must be unexpired and its SAN must match the selected hostname/IP.
4. For a remote-public endpoint, native OkHttp uses the system CA roots and the gateway's exact configured public origin. There is no redirect, origin-changing fallback, TLS-ignore option or direct SSH connection.

Profiles are separate per Windows/enrollment endpoint. Switching gateways clears stale sessions/quotas/alerts. To choose another endpoint, generate a fresh invitation and pair it explicitly; reusable credentials never migrate silently. Device links expire after12h and after desktop gateway restart/deactivation. Revocation/expiry requires explicit re-pairing, not an automatic repair/retry.

Remote networking such as Tailscale Serve, public certificate issuance, Windows firewall/power policies and DNS are **manual external prerequisites**, not changed by the app. A remote endpoint must forward HTTPS/WSS to this exact Crow gateway and have its public origin configured in Windows. Local self-signed trust is scoped to the native pinned client; the WebView does not override SSL errors.

## Native boundary

`CrowGatewayPlugin` stores device credentials in app-private AES-GCM ciphertext protected by an AndroidKeystore key. Profile ID is AEAD-associated data. Neither pair nor profile listing returns credentials to JavaScript. HTTP API/WSS Authorization headers are injected natively; no query tokens, localStorage, provider keys or plaintext token persistence. Unexpected private response fields are rejected. Android backup/device-transfer extraction is disabled and the FileProvider is not exported.

`EndpointPolicy` only allows exact HTTPS origins without userinfo/path/query/fragment, checks LAN pins and validity, and keeps OkHttp's default hostname verification. HTTP API paths/methods are allowlisted. No redirects or automatic connection/POST retries. Pairing uses `invitationCode/deviceName`; WSS uses `/api/v1/stream`, while input/resize use native authenticated HTTP with the streamId received in ready.

Generation and stream identity guards discard late responses/events after forget/disconnect/background. Native input is serial. Failed ambiguous sends invalidate the connection rather than replay queued input. UI rejects input above2048 UTF8 bytes without splitting/retrying it.

## Supported and intentionally absent

- Home, searchable authorized host/project sessions, two-step normal-mode Claude/Codex creation, wake, confirmed process close, detach/back and read-only foreign terminals.
- Real xterm output, sequence-deduplicated replay/reconnect with capped backoff, actual Android keyboard/visual viewport fitting, explicit **Adaptar terminal** for shared PTY resize (never background resize).
- User-gesture clipboard selection copy and confirmation for paste/multiline sends; sending may execute exact reviewed line breaks.
- Authorized foreground notices; real opt-in multi-account quota aliases, sample timestamps, stale/missing samples without invented percentages.
- No background FCM/push, ERP integration, credential recovery service, automatic LAN/remote endpoint failover or direct Android→Linux connection.

## Release acceptance still required

On a real device verify pinned SAN match/mismatch, changed/expired leaf refusal, CA/public-origin failure, forbidden redirects, revocation during pending HTTP/WSS, Keystore persistence with backups excluded, unpair/race handling, camera permission denial, background/foreground stream replay, multiline input byte limit, large font/TalkBack, Android back/modal focus, IME/safe areas, simultaneous Windows/Android resize and multiple accounts/gateways.

Dependency audit: patched critical Capacitor origin-proxy advisory [GHSA-rvm3-566m-v7fv](https://github.com/advisories/GHSA-rvm3-566m-v7fv) by using8.5.3 (reported vulnerable range8.0.0–8.3.4). Remaining `npm audit` findings were3 moderate **CLI dev-only xcode/uuid** dependencies, not Android runtime dependencies; no forced dependency downgrade/major update was applied. Official references: [Capacitor environment](https://capacitorjs.com/docs/getting-started/environment-setup), [official scanner](https://github.com/ionic-team/capacitor-barcode-scanner), [OkHttp](https://github.com/square/okhttp).
