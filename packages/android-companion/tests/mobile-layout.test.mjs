import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')
const terminal = readFileSync(new URL('../src/TerminalView.tsx', import.meta.url), 'utf8')
const chat = readFileSync(new URL('../src/ChatView.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

test('server selection is shared between home and projects instead of buried on projects', () => {
  assert.match(app, /profile && bootstrap && <section className="host-picker"/)
  assert.ok(app.indexOf('className="host-picker"') < app.indexOf("page === 'Inicio'"))
  assert.match(app, /Sin conexión · reintentando automáticamente/)
})

test('terminal output keeps space by collapsing every terminal tool and keeping composer available', () => {
  assert.match(terminal, /<details className="terminal-control-panel"><summary aria-label="Mostrar u ocultar controles de terminal">Controles de terminal<\/summary>/)
  assert.match(terminal, /<details className="terminal-actions"><summary>Más acciones<\/summary>/)
  assert.ok(terminal.indexOf('className="terminal-control-panel"') < terminal.indexOf('className="compose"'))
  assert.match(styles, /@media\(max-height:560px\)/)
  assert.match(styles, /\.terminal-control-panel>summary\{[^}]*min-height:48px/)
  assert.match(styles, /\.terminal-scroll button\{min-height:48px/)
})

test('errors can be dismissed without concealing connection status', () => {
  assert.match(app, /className="error" role="alert"/)
  assert.match(app, /aria-label="Descartar aviso"/)
  assert.match(app, /connection-\$\{status\}/)
})

test('device authentication rejection leaves connecting state without retrying actions', () => {
  assert.match(app, /revocado\|vencido\|forgotten\|rechazó la autenticación del dispositivo\|HTTP 401/)
  assert.match(app, /setStatus\('revoked'\); setBootstrap\(null\)/)
  assert.match(app, /Acceso rechazado o vencido · revisá el vínculo/)
})

test('supported agent sessions can switch between Chat and Terminal without creating another session', () => {
  assert.match(app, /terminal\.chatAvailable === true \? <>[\s\S]*?className="session-mode-tabs" role="tablist"/)
  assert.match(app, /aria-controls="session-chat-panel"/)
  assert.match(app, /aria-labelledby="session-chat-tab"/)
  assert.match(app, /<ChatView profile=\{profile\} hostId=\{hostId\} session=\{terminal\}/)
  assert.match(app, /<TerminalView profile=\{profile\} hostId=\{hostId\} session=\{terminal\}/)
  assert.match(chat, /api<MobileChatPage>\(profile\.id, `\/api\/v1\/chat\?/)
  assert.match(chat, /Gateway\.send\(\{ connectionId: id, type: 'input'/)
  assert.match(chat, /Verificá la conversación antes de volver a intentar/)
  assert.match(chat, /CHAT_POLL_MS = 10000/)
  assert.match(chat, /frame\.type === 'state'[\s\S]*?fetchPage\('newer'\)/)
  assert.match(chat, /void sync\.request\('initial'\)/)
  assert.match(chat, /aria-live="off"/)
  assert.match(chat, /agentName\(session\.agent\)/)
  assert.match(app, /<ChatView profile=\{profile\} hostId=\{hostId\} session=\{terminal\} isActive=\{sessionMode === 'chat'\}/)
  assert.match(app, /<TerminalView profile=\{profile\} hostId=\{hostId\} session=\{terminal\} isActive=\{sessionMode === 'terminal'\}/)
  assert.match(app, /\{terminal\.chatAvailable === true && <ChatView/)
  assert.doesNotMatch(app, /sessionMode === 'chat' && terminal\.chatAvailable === true && <ChatView/)
  assert.match(styles, /\.session-mode-tabs button\{min-height:48px\}/)
})

test('terminal initializes only on first activation and keeps the same session view mounted', () => {
  assert.match(terminal, /const \[hasActivated, setHasActivated\] = useState\(isActive\)/)
  assert.match(terminal, /if \(!hasActivated \|\| !surface\.current\) return/)
  assert.match(terminal, /useEffect\(\(\) => \{ if \(isActive\) setHasActivated\(true\) \}, \[isActive\]\)/)
  assert.match(app, /className="session-mode-panel" hidden=\{sessionMode === 'chat' && terminal\.chatAvailable === true\}/)
})

test('closing a session restores focus to its connected opener or the page heading', () => {
  assert.match(app, /sessionOrigin\.current = origin === document\.body \? null : origin/)
  assert.match(app, /const originIsVisible = !!origin && origin\.isConnected && !origin\.closest\('\[hidden\]'\) && origin\.getClientRects\(\)\.length > 0/)
  assert.match(app, /if \(originIsVisible\) origin\.focus\(\)\s*else sessionHeading\.current\?\.focus\(\)/)
  assert.match(app, /<h1 ref=\{sessionHeading\} tabIndex=\{-1\}>/)
  assert.match(app, /onOpen=\{origin => openSession\(session, origin\)\}/)
  assert.match(app, /onClick=\{event => void openNotice\(notice, event\.currentTarget\)\}/)
  assert.match(app, /openSession\(value, origin\)/)
  assert.match(app, /onCreate\(agent: 'claude' \| 'codex', origin: HTMLButtonElement\): void/)
})

test('Chat transcript keeps natural touch scrolling and collapses to a bounded composer', () => {
  assert.match(chat, /chat-transcript/)
  assert.match(chat, /pendingOlderAnchor/)
  assert.match(chat, /chat-older/)
  assert.match(chat, /role="region" tabIndex=\{0\}[\s\S]*?aria-label="Mensajes de la conversación"/)
  assert.match(chat, /sendLock\.current = true/)
  assert.match(chat, /setAwaitingAgent\(true\)/)
  assert.match(chat, /singleLineChatInput\(draft\)/)
  assert.match(chat, /setTimeout\(\(\) => setRecoveryAvailable\(true\), 30000\)/)
  assert.match(chat, /Ya revisé Terminal; habilitar envío/)
  assert.match(chat, /role="status" aria-live="polite" aria-atomic="true">\{announcement\}/)
  assert.match(styles, /\.chat-transcript\{[^}]*overflow-y:auto[^}]*touch-action:pan-y/)
  assert.match(styles, /\.chat-compose textarea\{[^}]*max-height:150px/)
  assert.match(styles, /\.chat-code-block pre\{[^}]*overflow:auto/)
  assert.match(styles, /\.chat-recovery\{[^}]*border-radius:9px/)
})
