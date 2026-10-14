# Crow Android companion — source MVP

Real Capacitor/React/xterm Android client for Crow on **Windows**. Linux hosts remain behind the open, awake Windows gateway. The source includes LAN, configured HTTPS and optional encrypted-relay endpoints. The initial CI run produced a signed debug APK, but that is a test artifact—not a production release—and does not establish real-phone acceptance. Local web bundle and Capacitor sync were previously verified; no emulator or phone validation has been performed.

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
2. Start the Android gateway; every project is selected by default, and you can deselect projects or capabilities before generating the current **version 2** invitation. If a host is offline, the project can still appear in Android as unavailable, but it receives no operational scope until you reconnect the host, confirm individual access, and generate a new invitation. It expires after five minutes, is single-use, and contains no reusable bearer credential. The current Android client rejects legacy version 1 invitations; generate a fresh QR if Windows presents one.
3. Scan the QR or paste/import its complete JSON. Choose **one exact offered endpoint** explicitly. LAN and relay endpoints require comparing the full colon-delimited SHA256 certificate fingerprint with Windows and confirming it. For LAN, the leaf certificate must be unexpired and its SAN must match the selected hostname/IP.
4. For a remote-public endpoint, native OkHttp uses system CA roots and the exact public origin configured in Windows. There is no redirect, origin-changing fallback, TLS-ignore option or direct SSH connection.

Profiles are separate per Windows enrollment. The default v2 device identity is a non-exportable Android Keystore signing key; the device authorization persists in Windows' protected trust store and has no fixed expiry (`expiresAt: null`). The 15-minute bearer is temporary, held only in native memory, and renewed by proving possession of that key. Gateway stop/restart clears active bearer access and streams, but does not by itself delete a v2 enrollment; on reconnect, the app obtains a new short-lived bearer if the device and its authorization remain valid. Revocation or an authorization/host identity change requires a new enrollment. Legacy v1 device records, where present, use a 12-hour expiry and are not accepted for pairing by the current Android client.

Remote access is not provisioned by pairing. Tailscale Serve or a public HTTPS reverse proxy, DNS/certificate, routing, Windows firewall and power policies remain external prerequisites; configure the exact public origin in Crow. The optional relay also requires a compatible relay service to be deployed and reachable, then its exact `wss://…/v1/tunnel` URL configured in Crow. Crow's Windows connector makes an outbound tunnel; Android selects the relay endpoint from the QR and pins the gateway's inner TLS certificate. Saving a relay URL does not deploy, validate or operate the relay service. Local self-signed trust is scoped to the native pinned client; the WebView does not override SSL errors.

### Pangolin double authentication (test build; device acceptance pending)

Select Pangolin explicitly in Windows, supply your exact public HTTPS domain and a free fixed loopback port. Manually configure Newt/resource routing and valid TLS; keep Pangolin authentication enabled for that resource and the panel. The version 2 QR contains only the provider/auth-required flag and the five-minute Crow invitation, **not a resource key**.

On Android confirmation, a **native** dialog displays the exact domain and asks for that resource's token ID/token once. Compare the domain with Windows before entering values; never use admin/API/site/Newt credentials. These values do not enter JavaScript, QR, logs or public status. They are sent only to the selected HTTPS origin via `P-Access-Token-Id`/`P-Access-Token`; Crow's distinct device bearer remains required after pairing and follows the v2 key-proof renewal flow. The proxy credentials are encrypted in native profile storage after successful pairing. Cancel/failure clears input; redirects, cross-origin reuse and automatic POST retry remain forbidden.

Set expiry and revocation for the Pangolin resource token according to Pangolin's policy; its lifetime is independent of Crow's device enrollment. Revoke it in Pangolin too when retiring a phone: Crow revocation closes its own streams immediately, but does not call the Pangolin administration API. Changing providers/origins requires a fresh link. Source support and CI checks do not prove remote connectivity or real-device behavior; device acceptance remains pending.

Crow API denials carry `X-Crow-Mobile-API: 1` (including rejected WSS upgrades): a Crow scope/action `403` preserves the link and does not retry. A `401`, or an outer Pangolin `403` without that marker, clears the current native bearer; v2 may obtain another only if key-proof renewal succeeds. Preserve this non-secret response header in the proxy; it distinguishes errors, **not authentication**. The native dialog is scrollable/resizes for IME and clears fields on cancellation/pause; actual Android layout/lifecycle acceptance remains pending.

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

The CI debug artifact is a signed test APK, not a production release or updater feed. CI compilation, JVM policy tests and artifact checks establish source/build properties only. A real phone has not yet verified camera pairing, certificate validation, the renewed key-based access flow, relay/Tailscale/Pangolin connectivity, background/foreground lifecycle or accessibility. Treat implementation in source, an APK artifact, and end-to-end device acceptance as separate milestones.
