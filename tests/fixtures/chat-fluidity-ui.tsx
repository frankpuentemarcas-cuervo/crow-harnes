import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ChatView } from '../../packages/android-companion/src/ChatView'
import '../../packages/android-companion/src/styles.css'
import { qa } from './chat-native.mock'
function Fixture() {
  const [session, setSession] = useState({ ...qa.info(), name: 'Named desktop console' }), [active, setActive] = useState(true)
  Object.assign(window, { __chatQA: { ...qa, active: setActive } })
  return <div className="app with-terminal"><div className="session-mode-panel" hidden={!active}><ChatView profile={{ id: 'qa', device: { capabilities: { input: true } } } as any} hostId="qa-host" session={session as any} isActive={active} onState={info => setSession(previous => ({ ...previous, ...info }))} onBack={() => {}} /></div></div>
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Fixture /></React.StrictMode>)
