import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
const source = name => readFileSync(new URL(`../android/app/src/main/java/dev/crow/companion/${name}.java`, import.meta.url), 'utf8')
test('bearer only native; pair resolves public profile, never result credential', () => {
  const native = source('CrowGatewayPlugin'), ts = readFileSync(new URL('../src/native.ts', import.meta.url), 'utf8')
  assert.match(native, /header\("Authorization", "Bearer " \+ credential\)/)
  assert.match(native, /call\.resolve\(new JSObject\(\)\.put\("profile", profile\)\)/)
  const pairSection = native.slice(native.indexOf('@PluginMethod public void pair'), native.indexOf('@PluginMethod public void listProfiles'))
  assert.doesNotMatch(pairSection, /call\.resolve\([^\n]*(?:credential|result)\)/)
  assert.doesNotMatch(ts, /credential:|token:/)
  assert.match(native, /EndpointPolicy\.path\(path, method\)/)
})
test('TLS leaf pinned with validity, secure URL and default hostname check; no global TLS modification', () => {
  const native = source('CrowGatewayPlugin'), policy = source('EndpointPolicy')
  assert.match(native, /followRedirects\(false\)\.followSslRedirects\(false\)\.retryOnConnectionFailure\(false\)/)
  assert.match(policy, /chain\[0\]\.checkValidity\(\)/); assert.match(policy, /MessageDigest\.isEqual/); assert.match(policy, /getUserInfo\(\)/); assert.match(policy, /getRawQuery\(\)/)
  assert.doesNotMatch(native + source('MainActivity'), /hostnameVerifier\(|setDefaultSSLSocketFactory|setDefaultHostnameVerifier|onReceivedSslError|\.proceed\(\)/)
  assert.match(native, /stream\.serverId == null \|\| !stream\.writable/)
})
test('private AES-GCM Keystore storage, backup and exported provider disabled', () => {
  const store = source('CredentialStore'), manifest = readFileSync(new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8')
  assert.match(store, /AndroidKeyStore/); assert.match(store, /AES\/GCM\/NoPadding/); assert.match(store, /updateAAD\(id\.getBytes/); assert.match(store, /Context\.MODE_PRIVATE/)
  assert.match(manifest, /android:allowBackup="false"/); assert.match(manifest, /android:fullBackupContent="false"/); assert.match(manifest, /android:usesCleartextTraffic="false"/)
  assert.match(manifest, /<provider[\s\S]*?android:exported="false"/)
})
test('bundled UI only, camera user gesture, no fake keyboard/direct fetch credential storage', () => {
  const config = readFileSync(new URL('../capacitor.config.ts', import.meta.url), 'utf8'), main = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8'), terminal = readFileSync(new URL('../src/TerminalView.tsx', import.meta.url), 'utf8')
  assert.match(config, /allowNavigation: \[\]/); assert.doesNotMatch(config, /server:\s*\{[^}]*\burl:/)
  assert.match(main, /CapacitorBarcodeScanner\.scanBarcode/); assert.match(main, /onClick=\{\(\) => void scan\(\)\}/)
  assert.doesNotMatch(main + terminal, /localStorage|sessionStorage|fetch\(|new WebSocket/)
  assert.match(terminal, /from: cursor\.seq/); assert.match(terminal, /Adaptar terminal/); assert.match(terminal, /PasteConfirmation/)
})
test('complete official native project contains Gradle wrapper and registered bridge', () => { for (const path of ['android/gradlew', 'android/gradlew.bat', 'android/gradle/wrapper/gradle-wrapper.jar', 'android/settings.gradle', 'android/capacitor.settings.gradle', 'android/app/capacitor.build.gradle']) assert.equal(existsSync(new URL(`../${path}`, import.meta.url)), true, path); assert.match(source('MainActivity'), /registerPlugin\(CrowGatewayPlugin\.class\)/) })
