import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { Modal } from './Modal'

type Confirmation = { message: string; accept?: string; danger?: boolean }
type Pending = Confirmation & { id: number; resolve(value: boolean): void }
const Context = createContext<(options: Confirmation) => Promise<boolean>>(() => Promise.resolve(false))
export const useConfirm = (): ((options: Confirmation) => Promise<boolean>) => useContext(Context)

export function ConfirmProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const pending = useRef<Pending[]>([])
  const nextId = useRef(0)
  const [current, setCurrent] = useState<Pending | null>(null)
  function finish(value: boolean): void {
    pending.current.shift()?.resolve(value)
    setCurrent(pending.current[0] || null)
  }
  useEffect(() => () => { for (const request of pending.current.splice(0)) request.resolve(false) }, [])
  return <Context.Provider value={options => new Promise(resolve => {
    const request = { ...options, id: ++nextId.current, resolve }
    pending.current.push(request)
    if (pending.current.length === 1) setCurrent(request)
  })}>{children}{current && <Modal key={current.id} titleId="confirm-title" className="confirm-dialog" initialFocus="[data-cancel]" onClose={() => finish(false)}>
    <h2 id="confirm-title">Confirmar acción</h2><p>{current.message}</p>
    <div className="dialog-actions"><span /><button data-cancel className="secondary-button" onClick={() => finish(false)}>Cancelar</button><button className={current.danger ? 'danger-button' : 'primary-button'} onClick={() => finish(true)}>{current.accept || 'Continuar'}</button></div>
  </Modal>}</Context.Provider>
}
