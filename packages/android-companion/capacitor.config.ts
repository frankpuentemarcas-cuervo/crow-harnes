import type { CapacitorConfig } from '@capacitor/cli'
const config: CapacitorConfig = {
  appId: 'dev.crow.companion', appName: 'Crow', webDir: 'dist',
  server: { hostname: 'localhost', androidScheme: 'https', cleartext: false, allowNavigation: [] },
  android: { allowMixedContent: false, captureInput: true, webContentsDebuggingEnabled: false },
  plugins: { CapacitorHttp: { enabled: false }, Keyboard: { resizeOnFullScreen: true } }
}
export default config
