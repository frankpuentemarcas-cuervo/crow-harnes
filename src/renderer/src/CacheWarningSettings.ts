import { createElement } from 'react'
import type { CacheWarningPreferences } from '../../shared/prompt-cache'

export function CacheWarningSettings({ value, onChange }: { value: CacheWarningPreferences; onChange: (value: CacheWarningPreferences) => void }): React.JSX.Element {
  return createElement('div', { className: 'cache-warning-settings' },
    createElement('label', null, createElement('input', { type: 'checkbox', checked: value.enabled, onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChange({ ...value, enabled: event.target.checked }) }), 'Avisos de caché Claude'),
    createElement('label', null, 'Anticipación', createElement('select', { 'aria-label': 'Anticipación del aviso de caché', value: value.warnSeconds, disabled: !value.enabled, onChange: (event: React.ChangeEvent<HTMLSelectElement>) => onChange({ ...value, warnSeconds: Number(event.target.value) }) },
      ...[15, 30, 60, 120, 300].map(seconds => createElement('option', { key: seconds, value: seconds }, seconds < 60 ? `${seconds} segundos` : `${seconds / 60} min`)))),
    createElement('small', null, 'Un aviso por vencimiento, sin sonido ni campanita de revisión. No envía mensajes al agente.')
  )
}
