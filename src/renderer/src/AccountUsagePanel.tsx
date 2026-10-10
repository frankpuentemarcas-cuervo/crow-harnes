import { useState } from 'react'
import { LogIn, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import type { AccountProvider, AccountUsage } from '../../shared/account-usage'
import type { AccountUsageModel } from './useAccountUsage'
import { quotaSampleIsStale, quotaWindowIsStale } from './account-usage-model'
import { Modal } from './Modal'
import { useConfirm } from './ConfirmDialog'
import './account-usage.css'

const statusLabel: Record<AccountUsage['status'], string> = {
  'signed-out': 'Sin sesión', ready: 'Actualizado', stale: 'Datos anteriores', error: 'Error de consulta',
  'signing-in': 'Iniciando sesión…', unsupported: 'Consulta no disponible', 'rate-limited': 'Límite de consultas'
}
const providerLabel = (provider: AccountProvider): string => provider === 'claude' ? 'Claude Code' : 'Codex'
const dateLabel = (timestamp: number): string => new Date(timestamp).toLocaleString()

export function AccountUsagePanel({ onClose, model }: { onClose(): void; model: AccountUsageModel }): React.JSX.Element {
  const confirm = useConfirm()
  const { accounts, busy, loading, error, now } = model
  const [provider, setProvider] = useState<AccountProvider>('claude')
  const [label, setLabel] = useState('')

  async function remove(account: AccountUsage): Promise<void> {
    if (busy) return
    if (!await confirm({ message: `¿Quitar “${account.label}” y su sesión local de Crow? No cambia tus cuentas ni sesiones en otros programas.`, accept: 'Quitar cuenta', danger: true })) return
    await model.remove(account.id)
  }

  return <Modal titleId="accounts-title" className="account-usage-dialog" onClose={onClose}>
    <div className="dialog-heading"><h2 id="accounts-title">Cuentas · uso de cuotas</h2><button className="icon-button" aria-label="Cerrar cuentas" onClick={onClose}><X size={18} /></button></div>
    <p>Registrá varias cuentas, independientemente de tus hosts. Cada inicio de sesión usa un perfil separado de Crow.</p>
    <p className="account-security-note">Iniciar sesión abre el navegador o la terminal oficial. Necesitás la CLI del proveedor instalada en este equipo; si falta, instalala y reiniciá Crow antes de reintentar.</p>
    <form className="account-add-form" onSubmit={event => {
      event.preventDefault()
      void model.add({ provider, label: label.trim() }).then(added => { if (added) setLabel('') })
    }}>
      <label>Proveedor<select value={provider} disabled={!!busy} onChange={event => setProvider(event.target.value as AccountProvider)}><option value="claude">Claude Code</option><option value="codex">Codex</option></select></label>
      <label>Nombre de la cuenta<input required maxLength={80} placeholder="Personal, trabajo…" value={label} disabled={!!busy} onChange={event => setLabel(event.target.value)} /></label>
      <button className="primary-button" disabled={!!busy || !label.trim()}><Plus size={16} aria-hidden="true" /> Agregar</button>
    </form>
    {error && <div className="inline-error" role="alert">{error}</div>}
    <div role="status" aria-live="polite" className="account-panel-status">{loading ? 'Cargando cuentas…' : busy ? 'Consultando…' : `${accounts.length} cuentas registradas · actualización cada 3 minutos mientras Crow esté visible, incluso con este panel cerrado.`}</div>
    <div className="account-list">
      {!loading && accounts.length === 0 && <p className="empty-small">Agregá una cuenta y luego iniciá sesión para consultar sus cuotas.</p>}
      {accounts.map(account => <article className="account-card" key={account.id} aria-labelledby={`account-${account.id}`}>
        <div className="account-card-heading"><div><h3 id={`account-${account.id}`}>{account.label}</h3><small>{providerLabel(account.provider)}{account.identity ? ` · ${account.identity}` : ''}</small></div><span className={`account-state ${account.status}`}>{statusLabel[account.status]}</span></div>
        <small>Fuente: {account.provider === 'codex' ? 'Codex app-server' : 'Claude OAuth · no documentada'}</small>
        {account.windows.length === 0 ? <p className="empty-small">Uso no disponible. No equivale a 0 % de consumo.</p> : account.windows.map(window => <div className="account-quota" key={window.id}>
          <div><span>{window.label}</span><strong>{Number.isFinite(window.usedPercent) ? `${Math.round(window.usedPercent)} % usado` : 'Uso no disponible'}</strong></div>
          {Number.isFinite(window.usedPercent) && <progress max={100} value={Math.max(0, Math.min(100, window.usedPercent))} aria-label={`${window.label}: cuota utilizada`} />}
          {Number.isFinite(window.usedPercent) && <small>{Math.round(Math.max(0, 100 - window.usedPercent))} % disponible · cada ventana es independiente.</small>}
          {quotaWindowIsStale(account, window, now) && <small>Lectura anterior · actualizá para confirmar el consumo de esta ventana.</small>}
          {window.resetsAt && <small>Renueva: {dateLabel(window.resetsAt)}</small>}
        </div>)}
        {account.updatedAt && <small>Última consulta: {dateLabel(account.updatedAt)}{quotaSampleIsStale(account, now) && account.windows.length > 0 ? ' · datos anteriores' : ''}</small>}
        {account.error && <p className="inline-error">{account.error}</p>}
        {account.retryAt && <small>Próximo intento disponible: {dateLabel(account.retryAt)}</small>}
        <div className="account-actions">
          <button className="secondary-button" disabled={!!busy || account.status === 'signing-in'} onClick={() => void model.login(account.id)}><LogIn size={15} aria-hidden="true" />{account.status === 'signed-out' ? 'Iniciar sesión' : 'Reconectar'}</button>
          <button className="secondary-button" disabled={!!busy || ['signed-out', 'signing-in', 'unsupported'].includes(account.status) || !!account.retryAt && account.retryAt > now} onClick={() => void model.refresh(account.id)}><RefreshCw size={15} aria-hidden="true" />Actualizar</button>
          <button className="icon-button" aria-label={`Quitar cuenta ${account.label}`} title="Quitar cuenta" disabled={!!busy || account.status === 'signing-in'} onClick={() => void remove(account)}><Trash2 size={16} /></button>
        </div>
      </article>)}
    </div>
    <p className="account-security-note">Crow no muestra tokens ni contraseñas. Las cuotas dependen del proveedor; no son el consumo de una terminal ni del caché de prompts.</p>
  </Modal>
}
