import { Plus, Settings2 } from 'lucide-react'
import type { AccountUsage, AccountUsageWindow } from '../../shared/account-usage'
import type { AccountUsageModel } from './useAccountUsage'
import { quotaSampleIsStale, quotaWindowIsStale } from './account-usage-model'
import './account-usage.css'

export const accountProviderLabel = (provider: AccountUsage['provider']): string => provider === 'claude' ? 'Claude Code' : 'Codex'
export const accountStatusLabel: Record<AccountUsage['status'], string> = {
  'signed-out': 'Sin sesión', ready: 'Actualizado', stale: 'Datos anteriores', error: 'Error de consulta',
  'signing-in': 'Iniciando sesión…', unsupported: 'Consulta no disponible', 'rate-limited': 'Límite de consultas'
}
export const quotaDateLabel = (timestamp: number): string => new Date(timestamp).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

export function quotaSampleLabel(account: AccountUsage, now: number): string {
  if (!account.updatedAt || !Number.isFinite(account.updatedAt)) return 'Sin lectura de cuotas'
  const age = Math.max(0, now - account.updatedAt)
  const relative = age < 60_000 ? 'hace menos de 1 min' : age < 3_600_000 ? `hace ${Math.floor(age / 60_000)} min` : age < 86_400_000 ? `hace ${Math.floor(age / 3_600_000)} h` : `hace ${Math.floor(age / 86_400_000)} días`
  return `${relative} · ${quotaSampleIsStale(account, now) ? 'lectura anterior' : 'última lectura'}`
}

export function AccountQuotaWindow({ account, quota, now }: { account: AccountUsage; quota: AccountUsageWindow; now: number }): React.JSX.Element {
  const known = Number.isFinite(quota.usedPercent)
  const value = known ? Math.max(0, Math.min(100, quota.usedPercent)) : undefined
  const stale = quotaWindowIsStale(account, quota, now)
  return <div className={`quota-dock-window ${known && value! >= 80 ? 'quota-warning' : ''}`}>
    <div className="quota-dock-window-line"><span title={quota.label}>{quota.label}</span><strong>{known ? `${Math.round(value!)}% usado` : 'Sin datos'}</strong></div>
    {known && <progress max={100} value={value} aria-label={`${account.label} · ${quota.label}: cuota utilizada${stale ? ', lectura anterior' : ''}`} />}
    <small>{stale ? 'Lectura anterior · ' : ''}{known ? `${Math.round(100 - value!)}% disponible` : 'Uso no disponible'}{quota.resetsAt ? ` · reinicia ${quotaDateLabel(quota.resetsAt)}` : ' · reinicio no informado'}</small>
  </div>
}

/** A global account view, never a selector for the agent's authentication. */
export function AccountUsageDock({ model, onManage, compact = false }: { model: AccountUsageModel; onManage(): void; compact?: boolean }): React.JSX.Element {
  const { accounts, loading, busy, error, now } = model
  const exhausted = accounts.filter(account => account.windows.some(quota => Number.isFinite(quota.usedPercent) && quota.usedPercent >= 100)).length
  const unavailable = accounts.filter(account => account.status !== 'ready' || quotaSampleIsStale(account, now) || !account.windows.length).length
  return <section className={`account-usage-dock ${compact ? 'compact' : ''}`} aria-label="Cuotas de cuentas globales">
    <div className="quota-dock-heading"><div><strong>Cuentas <span>{accounts.length}</span></strong><small>{exhausted ? `${exhausted} con cuota agotada` : unavailable ? `${unavailable} con datos pendientes / anteriores` : 'Claude / Codex · globales'}</small></div><button className="icon-button" aria-label="Administrar cuentas y cuotas" title="Administrar cuentas y cuotas" onClick={onManage}><Settings2 size={16} /></button></div>
    {error && <p className="quota-dock-error" role="alert">{error}</p>}
    {loading && !accounts.length && <p className="quota-dock-empty" role="status">Cargando cuentas…</p>}
    {!loading && !accounts.length && <div className="quota-dock-empty"><p>Tu consumo, siempre a mano.</p><button className="secondary-button small-button" onClick={onManage}><Plus size={14} />Agregar Claude / Codex</button><small>Sin cuentas registradas; uso desconocido.</small></div>}
    {!!accounts.length && <div className="quota-dock-list" tabIndex={0} aria-label="Consumo por cuenta; desplazá para ver todas">
      {accounts.map(account => <article className="quota-dock-account" key={account.id}>
        <div className="quota-dock-account-title"><strong title={account.label}>{account.label}</strong><span>{accountProviderLabel(account.provider)}</span></div>
        {account.status !== 'ready' && <p className="quota-dock-state">{accountStatusLabel[account.status]}</p>}
        {account.windows.length ? account.windows.map(quota => <AccountQuotaWindow key={quota.id} account={account} quota={quota} now={now} />) : <p className="quota-dock-state">Uso no disponible · no equivale a 0%</p>}
        <div className="quota-dock-sample" title={account.updatedAt ? `Consulta: ${new Date(account.updatedAt).toLocaleString()}` : undefined}>{quotaSampleLabel(account, now)}</div>
        {account.error && <p className="quota-dock-error">{account.error}</p>}
      </article>)}
    </div>}
    <div className="quota-dock-footer"><button onClick={onManage}>{accounts.length ? '+ Agregar cuenta / detalles' : 'Administrar cuentas'}</button><span aria-live="polite">{busy ? 'Consultando…' : 'Cada 3 min'}</span></div>
  </section>
}
