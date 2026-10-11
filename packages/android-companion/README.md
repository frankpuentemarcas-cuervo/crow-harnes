# Crow Android companion — source MVP

Real Capacitor/React/xterm Android client for Crow on **Windows**. Linux hosts remain behind the open, awake Windows gateway. Local web bundle and Capacitor sync passed after explicit build authorization. **Native compilation and APK generation run in CI**, not on this SDK-less workstation. No emulator or phone validation has been performed.

Initial [Android CI run38074210670](https://github.com/frankpuentemarcas-cuervo/crow-harnes/actions/runs/38074210670) passed native compilation, 5 JVM policy tests and signed debug APK/manifest/local-bundle verification. The downloaded dispatch APK checksum was independently verified against its SHA256 file. Each release reruns this workflow and generates its own APK/checksum; a dispatch artifact is not automatically the release artifact.

## Debug APK CI

`.github/workflows/android-validation.yml` supports manual `workflow_dispatch` and reusable `workflow_call`. It installs Java21/SDK36/build-tools36.0.0 **on the GitHub runner only**, executes package tests and native JVM tests, bundles local assets, assembles and verifies a debug APK, then uploads:

- Artifact `crow-android`: `Crow-Companion-<package-version>-debug.apk` and its `.sha256` (standard SHA256 checksum format).
- Artifact `crow-android-test-reports`: JVM test results, manifest/badging and public signature metadata.

This APK is a **signed, debuggable TEST build**, not a production/Play Store release. No production signing identity or secrets are created. GitHub runner debug keys are ephemeral: a later APK may have a different signing certificate and require uninstall/reinstall. Uninstall removes local Keystore pairing, requiring a fresh Windows invitation. The CI signature, manifest and local asset checks do not prove camera/TLS/IME behavior on a real phone.

## Validate without building

From `C:\dev\crow-harnes\packages\android-companion`:

```powershell
npm ci --ignore-scripts --registry=https://registry.npmjs.org
npm run typecheck
npm test
```

Tests execute real JS enrollment validation, terminal byte encoding/replay cursor, readonly grants, input limits, quota freshness and static native security/project checks. Static checks do **not** prove Android compilation, TLS handshakes or device behavior. Java JUnit policy tests under `android/app/src/test/java/dev/crow/companion` passed **5/5 in CI**; they were not executed locally and do not replace real-device acceptance.

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

### Pangolin double authentication (test build; device acceptance pending)

Select Pangolin explicitly in Windows, supply your exact public HTTPS domain and a free fixed loopback port. Manually configure Newt/resource routing and valid TLS; keep Pangolin authentication enabled for that resource and the panel. The QR contains only the provider/auth-required flag and the existing five-minute Crow invitation, **not a resource key**.

On Android confirmation, a **native** dialog displays the exact domain and asks for that resource's token ID/token once. Compare the domain with Windows before entering values; never use admin/API/site/Newt credentials. These values do not enter JavaScript, profiles, QR, logs or public status. They are sent only to the selected HTTPS origin via `P-Access-Token-Id`/`P-Access-Token`; Crow's separate device bearer remains required after pairing. Native storage encrypts both layers with Android Keystore only after successful pairing. Cancel/failure clears input; redirects, cross-origin reuse and automatic POST retry remain forbidden. Revocation/rejection requires explicit re-enrollment; there is no token refresh or silent endpoint migration.

Provision a separate expiring/revocable Pangolin resource token for each phone (at most the Crow link's 12-hour lifetime). Revoke it in Pangolin too when retiring a phone: Crow revocation closes its own streams immediately, but does not call the Pangolin administration API. Changing providers/origins requires a fresh link. Neither entering configuration nor mocked tests proves remote connectivity; Windows/APK compilation and real-phone acceptance are still pending.

Crow API denials carry `X-Crow-Mobile-API: 1` (including rejected WSS upgrades): a Crow scope/action `403` preserves the link and does not retry. A `401`, or an outer Pangolin `403` without that marker, invalidates the native profile. Preserve this non-secret response header in the proxy; it distinguishes errors, **not authentication**. The native dialog is scrollable/resizes for IME and clears fields on cancellation/pause; actual Android layout/lifecycle acceptance remains pending.

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

Pangolin test build uses companion0.1.1-beta.1/versionCode2 and desktop0.1.32-beta.1. Its manual dispatch asserts all9 native JVM tests (4 Pangolin +5 endpoint policies), and uploads only Actions test artifacts, not a release or updater feed. This branch does not authorize installing over a running Crow instance or publishing; real-device acceptance is still required.
