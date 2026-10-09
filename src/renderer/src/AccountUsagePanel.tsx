import { useEffect, useRef, useState } from 'react'
import { LogIn, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import type { AccountProvider, AccountUsage } from '../../shared/account-usage'
import { Modal } from './Modal'
import { useConfirm } from './ConfirmDialog'
import './account-usage.css'

const statusLabel: Record<AccountUsage['status'], string> = {
  'signed-out': 'Sin sesión', ready: 'Actualizado', stale: 'Datos anteriores', error: 'Error de consulta',
  'signing-in': 'Iniciando sesión…', unsupported: 'Consulta no disponible', 'rate-limited': 'Límite de consultas'
}
const providerLabel = (provider: AccountProvider): string => provider === 'claude' ? 'Claude Code' : 'Codex'
const dateLabel = (timestamp: number): string => new Date(timestamp).toLocaleString()

export function AccountUsagePanel({ onClose }: { onClose(): void }): React.JSX.Element {
  const confirm = useConfirm()
  const [accounts, setAccounts] = useState<AccountUsage[]>([])
  const [provider, setProvider] = useState<AccountProvider>('claude')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const alive = useRef(true)
  const operation = useRef(false)
  const currentAccounts = useRef(accounts)
  currentAccounts.current = accounts

  function update(account: AccountUsage): void {
    if (!alive.current) return
    setAccounts(items => items.some(item => item.id === account.id) ? items.map(item => item.id === account.id ? account : item) : [...items, account])
  }

  async function run(key: string, action: () => Promise<void>): Promise<void> {
    if (operation.current) return
    operation.current = true
    setBusy(key)
    setError('')
    try { await action() } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : 'No se pudo completar la operación.') }
    finally { operation.current = false; if (alive.current) setBusy('') }
  }

  useEffect(() => {
    alive.current = true
    let stopped = false
    async function refreshAccounts(items: AccountUsage[]): Promise<void> {
      for (const account of items) {
        if (stopped) return
        if (!['ready', 'stale', 'error', 'rate-limited'].includes(account.status)) continue
        if (account.retryAt && account.retryAt > Date.now()) continue
        const refreshed = await window.crow.accountsRefresh(account.id)
        if (!stopped) update(refreshed)
      }
    }
    // Defer until after StrictMode's setup/cleanup replay, so the cancelled
    // first setup cannot retain the operation lock or lose the initial list.
    void Promise.resolve().then(async () => {
      if (stopped) return
      await run('load', async () => {
        const result = await window.crow.accountsList()
        if (stopped) return
        setAccounts(result)
        setLoading(false)
        await refreshAccounts(result)
      })
      if (!stopped) setLoading(false)
    })
    // Only this open panel polls. Never overlap a login or a previous refresh.
    const timer = setInterval(() => {
      if (document.visibilityState === 'hidden') return
      void run('poll', async () => {
        await refreshAccounts(currentAccounts.current)
        if (stopped) return
        const result = await window.crow.accountsList()
        if (!stopped) setAccounts(result)
      })
    }, 180_000)
    return () => { stopped = true; alive.current = false; clearInterval(timer) }
  }, [])

  async function remove(account: AccountUsage): Promise<void> {
    if (operation.current) return
    if (!await confirm({ message: `¿Quitar “${account.label}” y su sesión local de Crow? No cambia tus cuentas ni sesiones en otros programas.`, accept: 'Quitar cuenta', danger: true })) return
    await run(account.id, async () => {
      await window.crow.accountsRemove(account.id)
      if (alive.current) setAccounts(items => items.filter(item => item.id !== account.id))
    })
  }

  return <Modal titleId="accounts-title" className="account-usage-dialog" onClose={onClose}>
    <div className="dialog-heading"><h2 id="accounts-title">Cuentas · uso de cuotas</h2><button className="icon-button" aria-label="Cerrar cuentas" onClick={onClose}><X size={18} /></button></div>
    <p>Registrá varias cuentas, independientemente de tus hosts. Cada inicio de sesión usa un perfil separado de Crow.</p>
    <p className="account-security-note">Iniciar sesión abre el navegador o la terminal oficial. Necesitás la CLI del proveedor instalada en este equipo; si falta, instalala y reiniciá Crow antes de reintentar.</p>
    <form className="account-add-form" onSubmit={event => {
      event.preventDefault()
      void run('add', async () => {
        update(await window.crow.accountsAdd({ provider, label: label.trim() }))
        if (alive.current) setLabel('')
      })
    }}>
      <label>Proveedor<select value={provider} disabled={!!busy} onChange={event => setProvider(event.target.value as AccountProvider)}><option value="claude">Claude Code</option><option value="codex">Codex</option></select></label>
      <label>Nombre de la cuenta<input required maxLength={80} placeholder="Personal, trabajo…" value={label} disabled={!!busy} onChange={event => setLabel(event.target.value)} /></label>
      <button className="primary-button" disabled={!!busy || !label.trim()}><Plus size={16} aria-hidden="true" /> Agregar</button>
    </form>
    {error && <div className="inline-error" role="alert">{error}</div>}
    <div role="status" aria-live="polite" className="account-panel-status">{loading ? 'Cargando cuentas…' : busy ? 'Consultando…' : `${accounts.length} cuentas registradas · actualización cada 3 minutos mientras este panel esté abierto.`}</div>
    <div className="account-list">
      {!loading && accounts.length === 0 && <p className="empty-small">Agregá una cuenta y luego iniciá sesión para consultar sus cuotas.</p>}
      {accounts.map(account => <article className="account-card" key={account.id} aria-labelledby={`account-${account.id}`}>
        <div className="account-card-heading"><div><h3 id={`account-${account.id}`}>{account.label}</h3><small>{providerLabel(account.provider)}{account.identity ? ` · ${account.identity}` : ''}</small></div><span className={`account-state ${account.status}`}>{statusLabel[account.status]}</span></div>
        <small>Fuente: {account.provider === 'codex' ? 'Codex app-server' : 'Claude OAuth · no documentada'}</small>
        {account.windows.length === 0 ? <p className="empty-small">Uso no disponible. No equivale a 0 % de consumo.</p> : account.windows.map(window => <div className="account-quota" key={window.id}>
          <div><span>{window.label}</span><strong>{Number.isFinite(window.usedPercent) ? `${Math.round(window.usedPercent)} % usado` : 'Uso no disponible'}</strong></div>
          {Number.isFinite(window.usedPercent) && <progress max={100} value={Math.max(0, Math.min(100, window.usedPercent))} aria-label={`${window.label}: cuota utilizada`} />}
          {Number.isFinite(window.usedPercent) && <small>{Math.round(Math.max(0, 100 - window.usedPercent))} % disponible · cada ventana es independiente.</small>}
          {window.resetsAt && <small>Renueva: {dateLabel(window.resetsAt)}</small>}
        </div>)}
        {account.updatedAt && <small>Última consulta: {dateLabel(account.updatedAt)}{account.status !== 'ready' && account.windows.length > 0 ? ' · datos anteriores' : ''}</small>}
        {account.error && <p className="inline-error">{account.error}</p>}
        {account.retryAt && <small>Próximo intento disponible: {dateLabel(account.retryAt)}</small>}
        <div className="account-actions">
          <button className="secondary-button" disabled={!!busy || account.status === 'signing-in'} onClick={() => void run(account.id, async () => update(await window.crow.accountsLogin(account.id)))}><LogIn size={15} aria-hidden="true" />{account.status === 'signed-out' ? 'Iniciar sesión' : 'Reconectar'}</button>
          <button className="secondary-button" disabled={!!busy || ['signed-out', 'signing-in', 'unsupported'].includes(account.status) || !!account.retryAt && account.retryAt > Date.now()} onClick={() => void run(account.id, async () => update(await window.crow.accountsRefresh(account.id)))}><RefreshCw size={15} aria-hidden="true" />Actualizar</button>
          <button className="icon-button" aria-label={`Quitar cuenta ${account.label}`} title="Quitar cuenta" disabled={!!busy || account.status === 'signing-in'} onClick={() => void remove(account)}><Trash2 size={16} /></button>
        </div>
      </article>)}
    </div>
    <p className="account-security-note">Crow no muestra tokens ni contraseñas. Las cuotas dependen del proveedor; no son el consumo de una terminal ni del caché de prompts.</p>
  </Modal>
}
