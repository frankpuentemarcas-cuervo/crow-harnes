import type { AlertAISettings, AlertAIStatus, AttentionClassification, Notice, RemoteEvent } from '../shared/types'
import { classifyAttention, fallbackClassification, type AIConfiguration } from './attention-classifier.ts'
import type { AttentionAudit, AuditRef, ClassifierDiagnostic } from '../shared/alert-diagnostics'

interface NoticeStore {
  recordEvent(hostId: string, event: RemoteEvent, classification?: AttentionClassification): Notice | undefined
  updateClassification(hostId: string, id: string, classification: AttentionClassification): Notice | undefined
}
interface Settings {
  snapshot(): AlertAISettings
  configuration(): AIConfiguration
}
interface Job { hostId: string; event: RemoteEvent; generation: number; controller: AbortController; auditRef?: AuditRef; receivedAt: number }
type Classifier = (config: AIConfiguration, message: string, cancel?: AbortSignal, observe?: (diagnostic: ClassifierDiagnostic) => void) => Promise<AttentionClassification>
const rules = (event: RemoteEvent): AttentionClassification => ({ source: 'rules', decision: event.requiresAttention ? 'actionable' : 'informational', detail: 'Clasificación local por reglas; IA desactivada.' })

// One bounded queue shared by every host. Never block SSH polling or PTYs on AI.
export class AttentionService {
  private jobs: Job[] = []
  private active = new Set<Job>()
  private generation = 0
  private cooldownUntil = 0
  private testController?: AbortController
  private status: AlertAIStatus = { state: 'idle', detail: 'Sin análisis todavía.' }
  private readonly store: NoticeStore
  private readonly settings: Settings
  private readonly emit: (notice: Notice) => void
  private readonly emitStatus: (status: AlertAIStatus) => void
  private readonly classify: Classifier
  private readonly now: () => number
  private readonly audit?: AttentionAudit

  constructor(store: NoticeStore, settings: Settings, emit: (notice: Notice) => void, emitStatus: (status: AlertAIStatus) => void, classify: Classifier = (config, message, cancel, observe) => classifyAttention(config, message, fetch, 15000, cancel, observe), now = Date.now, audit?: AttentionAudit) {
    this.store = store
    this.settings = settings
    this.emit = emit
    this.emitStatus = emitStatus
    this.classify = classify
    this.now = now
    this.audit = audit
  }

  enabled(): boolean { return this.settings.snapshot().enabled }
  snapshot(): AlertAIStatus { return { ...this.status } }

  receive(hostId: string, event: RemoteEvent): void {
    const enabled = this.enabled() && event.kind === 'turn-complete'
    let initial = rules(event)
    if (enabled) {
      initial = !event.message?.trim() ? fallbackClassification('No llegó el texto final. Actualizá crowd Linux y verificá los hooks del agente.')
        : event.messageTruncated ? fallbackClassification('La respuesta supera el límite de análisis; revisá esta terminal.')
        : this.now() < this.cooldownUntil ? fallbackClassification('Free LLM está temporalmente en pausa tras un error. Revisá esta terminal.')
        : this.jobs.length + this.active.size >= 40 ? fallbackClassification('La cola de IA está llena; revisá esta terminal.')
        : { source: 'pending', decision: 'uncertain', detail: 'Analizando la última respuesta con Free LLM…' }
    }
    const notice = this.store.recordEvent(hostId, event, initial)
    if (!notice) return // Cursor dedupe also prevents duplicate model calls/sounds.
    let auditRef: AuditRef | undefined
    try { auditRef = this.audit?.begin(hostId, event, enabled ? this.settings.snapshot().model : '(reglas locales)') } catch { /* Never block agents on diagnostic I/O. */ }
    this.auditUpdate(auditRef, { classification: initial, noticeEmitted: true, finishedAt: initial.source === 'pending' ? undefined : new Date(this.now()).toISOString() })
    this.emit(notice)
    if (initial.source === 'fallback') this.setStatus({ state: 'error', detail: initial.detail })
    if (initial.source !== 'pending') return
    this.jobs.push({ hostId, event, generation: this.generation, controller: new AbortController(), auditRef, receivedAt: this.now() })
    this.drain()
  }

  reset(): void {
    this.generation++
    this.cooldownUntil = 0
    this.testController?.abort()
    for (const job of [...this.jobs, ...this.active]) {
      job.controller.abort()
      this.auditUpdate(job.auditRef, { explanation: 'Análisis cancelado al cambiar la configuración de Free LLM.' })
      this.finish(job, rules(job.event))
    }
    this.jobs = []
    this.setStatus({ state: 'idle', detail: 'Configuración guardada; aplica a las próximas respuestas.' })
  }

  stop(): void {
    this.generation++
    this.testController?.abort()
    for (const job of [...this.jobs, ...this.active]) {
      job.controller.abort()
      this.auditUpdate(job.auditRef, { classification: fallbackClassification('El análisis se interrumpió al cerrar Crow.'), finishedAt: new Date(this.now()).toISOString(), noticeEmitted: false })
    }
    this.jobs = []
  }

  async testConnection(): Promise<AlertAIStatus> {
    if (this.active.size || this.testController) throw new Error('Esperá a que termine el análisis actual antes de probar la conexión.')
    const controller = new AbortController()
    this.testController = controller
    this.setStatus({ state: 'working', detail: 'Probando tres respuestas ficticias; no se envían conversaciones reales.' })
    try {
      const config = this.settings.configuration()
      const cases = [
        ['¿Me autorizás a resetear las contraseñas de los usuarios de prueba? No puedo continuar sin tu aprobación.', 'actionable'],
        ['Los tests pasaron y el trabajo terminó. No necesito ninguna acción tuya.', 'informational'],
        ['Ya lancé el subagente de QA. Sigue trabajando y voy a continuar automáticamente.', 'informational']
      ] as const
      for (const [text, expected] of cases) {
        const result = await this.classify(config, text, controller.signal)
        if (controller.signal.aborted) throw new Error('Prueba cancelada al cambiar la configuración.')
        if (result.decision !== expected) throw new Error('El modelo no clasificó correctamente los ejemplos de prueba. Revisá tu cadena de Free LLM.')
      }
      this.cooldownUntil = 0
      this.setStatus({ state: 'ok', detail: 'Conexión y clasificación verificadas con 3 ejemplos ficticios.' })
    } catch (error) {
      if (!controller.signal.aborted) this.setStatus({ state: 'error', detail: error instanceof Error ? error.message : 'No se pudo probar Free LLM.' })
    } finally { this.testController = undefined; this.drain() }
    return this.snapshot()
  }

  private setStatus(status: AlertAIStatus): void { this.status = status; this.emitStatus(this.snapshot()) }

  private finish(job: Job, classification: AttentionClassification): void {
    const notice = this.store.updateClassification(job.hostId, job.event.id, classification)
    this.auditUpdate(job.auditRef, { classification, finishedAt: new Date(this.now()).toISOString(), noticeEmitted: !!notice })
    if (notice) this.emit(notice)
  }

  private auditUpdate(ref: AuditRef | undefined, patch: Parameters<AttentionAudit['update']>[1]): void {
    try { this.audit?.update(ref, patch) } catch { /* A full disk must not break an alert. */ }
  }

  private drain(): void {
    if (this.testController) return
    while (this.active.size < 2 && this.jobs.length) {
      const job = this.jobs.shift()!
      this.active.add(job)
      void this.run(job).catch(() => {
        this.setStatus({ state: 'error', detail: 'No se pudo guardar el resultado de la alerta en Windows.' })
      }).finally(() => { this.active.delete(job); this.drain() })
    }
  }

  private async run(job: Job): Promise<void> {
    let startedAt: number | undefined
    try {
      this.auditUpdate(job.auditRef, { queueMs: Math.max(0, this.now() - job.receivedAt) })
      if (this.now() - Date.parse(job.event.at) > 90000) {
        const detail = 'El análisis esperó demasiado en la cola. Revisá esta terminal.'
        this.finish(job, fallbackClassification(detail))
        this.setStatus({ state: 'error', detail })
        return // Local backlog is not a provider outage; do not pause fresh jobs.
      }
      if (this.now() < this.cooldownUntil) throw new Error('Free LLM está temporalmente en pausa tras un error.')
      this.setStatus({ state: 'working', detail: 'Analizando respuestas de agentes…' })
      startedAt = this.now()
      const result = await this.classify(this.settings.configuration(), job.event.message!, job.controller.signal, diagnostic => {
        if (job.generation === this.generation) this.auditUpdate(job.auditRef, diagnostic)
      })
      if (job.generation !== this.generation) return
      this.finish(job, result)
      this.setStatus({ state: result.decision === 'uncertain' ? 'error' : 'ok', detail: result.detail })
    } catch (error) {
      if (job.generation !== this.generation) return
      const detail = error instanceof Error ? error.message : 'No se pudo analizar la respuesta.'
      this.cooldownUntil = this.now() + 30000
      this.finish(job, fallbackClassification(`${detail} Alerta preventiva: revisá esta terminal.`))
      this.setStatus({ state: 'error', detail })
    } finally { if (startedAt !== undefined && job.generation === this.generation) this.auditUpdate(job.auditRef, { inferenceMs: Math.max(0, this.now() - startedAt) }) }
  }
}
