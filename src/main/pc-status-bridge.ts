import { createHash, randomUUID } from 'node:crypto'

export interface PcMessage { id: string; role: string; content: string }
export interface PcObservation { account: string; conversation: string; ready: boolean; epoch?: string; messages: PcMessage[] }
type Task = { id: string; messageId: string; conversation: string; state: 'queued' | 'capturing' | 'ready' | 'sending' | 'sent' | 'cancelled'; report?: string }
export interface PcLedger { version: 1; account: string; enabled: boolean; seen: string[]; tasks: Task[] }

/** Preflight/composer busy before any click — report stays ready for a later attempt. */
export class PcReportNotSubmitted extends Error {
  readonly code = 'pc_not_submitted' as const
  constructor(message = 'PC report not submitted') {
    super(message)
    this.name = 'PcReportNotSubmitted'
  }
}

export function isPcReportNotSubmitted(err: unknown): err is PcReportNotSubmitted {
  return err instanceof PcReportNotSubmitted ||
    (!!err && typeof err === 'object' && (err as { code?: unknown }).code === 'pc_not_submitted')
}

export function pcAccount(cookies: string): string {
  const credentials = cookies.split(';').map(s => s.trim()).filter(s => /^hatch_sess=/.test(s)).sort().join(';')
  return credentials ? createHash('sha256').update(credentials).digest('hex') : ''
}

export function isPcStatusQuery(content: string): boolean {
  if (!content) return false
  // Strip any muse.ai DOM label prefix like "用户消息：", "你：", "You:"
  const cleaned = content.replace(/^(用户消息[:：]|你[:：]|You:)\s*/i, '').trim()
  // Any message containing [MUSE_PC_STATUS or [MUSE_ is an internal data report or context, NEVER a user query!
  if (cleaned.includes('[MUSE_PC_STATUS') || cleaned.includes('[MUSE_LOCAL_CONTEXT') || cleaned.includes('[MUSE_')) {
    return false
  }
  if (/^\/(pc(\s+status)?|sys)$/i.test(cleaned)) return true
  if (cleaned.startsWith('/')) return false
  if (/^[>“"'「『]/.test(cleaned)) return false
  if (cleaned.length > 60) return false
  return (
    /(电脑|系统|主机).*(状态|卡不卡|卡吗|运行情况|运行状态|内存|cpu|负载|怎么样|如何)/i.test(cleaned) ||
    /^(查电脑|查下电脑|看看电脑|电脑怎么样|电脑状态|电脑卡吗|电脑卡不卡)$/i.test(cleaned) ||
    /^(pc status|computer status|system status)$/i.test(cleaned)
  )
}

/** No DOM, Electron, prompt interpretation or arbitrary tool dispatch in this boundary. */
export class PcStatusBridge {
  public ledger: PcLedger
  private previous: string[] = []
  private conversation = ''
  private epoch = ''
  private lastObservation = 0
  private busy = false
  private generation = 0
  private lastCaptureTime = 0
  /** Content of status queries already answered locally, so the cloud echo is not captured twice. */
  private locallyHandled = new Map<string, number>()
  constructor(private io: {
    load(): PcLedger | null; save(state: PcLedger): void; snapshot(): Promise<string>;
    send(report: string, conversation: string, account: string): Promise<void>;
    available(): boolean; account(): string; device: string; now?: () => number
  }) {
    this.ledger = io.load() || { version: 1, account: '', enabled: true, seen: [], tasks: [] }
    // Never resume pre-crash queued work or resample an interrupted capture.
    for (const t of this.ledger.tasks) {
      if (['queued', 'capturing', 'ready'].includes(t.state)) t.state = 'cancelled'
      if (t.state === 'sending') t.state = 'sent'
    }
    // Prune finished tasks keeping at most last 10
    if (this.ledger.tasks.length > 10) {
      this.ledger.tasks = this.ledger.tasks.slice(-10)
    }
    this.persist()
  }
  private now() { return this.io.now?.() ?? Date.now() }
  private persist() { this.io.save(this.ledger) }
  public bind(account: string) {
    if (account === this.ledger.account) return
    this.generation++
    this.previous = []; this.conversation = ''; this.lastObservation = 0
    // Default enabled for initial bind; switching between different accounts disables for safety
    const enabled = !this.ledger.account && !!account
    this.ledger = { version: 1, account, enabled, seen: [], tasks: [] }
    this.persist()
  }
  public command(content: string): string | null {
    if (!['/pc on', '/pc off', '/pc status'].includes(content)) return null
    this.bind(this.io.account())
    if (content === '/pc off') {
      this.ledger.enabled = false; this.invalidate(); this.persist()
      return 'PC status bridge disabled on this computer.'
    }
    if (!this.ledger.account) return 'Sign in to Muse before enabling PC status.'
    if (content === '/pc on') {
      if (!this.ledger.enabled) { this.ledger.enabled = true; this.invalidate(); this.persist() }
      return `PC status enabled on ${this.io.device}. You can now ask Luna about PC status from your phone or desktop.`
    }
    if (!this.ledger.enabled) return 'PC status is disabled. Use /pc on on this computer first.'
    if (!this.previous.length || !this.io.available() || this.now() - this.lastObservation > 15000) return 'PC status is waiting for a healthy cloud history baseline. Try again shortly.'
    this.enqueue('local:' + randomUUID()); this.persist()
    void this.drain().catch(() => {})
    return 'PC status queued. The tagged local data report will appear in Muse.'
  }
  private invalidate() {
    this.generation++; this.previous = []; this.lastObservation = 0
    this.cancelUnsent()
  }
  /** Cancel queued/capturing/ready work. Callers bump generation when in-flight drain must abort. */
  private cancelUnsent() {
    for (const t of this.ledger.tasks) if (['queued', 'capturing', 'ready'].includes(t.state)) t.state = 'cancelled'
  }
  private enqueue(messageId: string) {
    if (this.ledger.tasks.some(t => t.messageId === messageId && t.conversation === this.conversation)) return
    this.ledger.tasks.push({ id: randomUUID(), messageId, conversation: this.conversation, state: 'queued' })
  }
  /** Mark a status query this terminal already answered through local enrichment. */
  public skipLocallyHandled(content: string) {
    const key = (content || '').trim()
    if (!key) return
    this.locallyHandled.set(key, this.now() + 120000)
  }
  private wasHandledLocally(content: string): boolean {
    const key = (content || '').trim()
    const expiry = this.locallyHandled.get(key)
    if (expiry === undefined) return false
    if (expiry < this.now()) {
      this.locallyHandled.delete(key)
      return false
    }
    this.locallyHandled.delete(key)
    return true
  }
  public async observe(o: PcObservation) {
    this.bind(o.account)
    if (!o.ready || !o.account) { this.invalidate(); this.persist(); return }
    const now = this.now()
    if (now - this.lastObservation > 15000 || this.conversation !== o.conversation || this.epoch !== (o.epoch || '')) this.invalidate()
    this.epoch = o.epoch || ''
    this.conversation = o.conversation; this.lastObservation = now
    const messages = o.messages.filter(m => m.id)
    const ids = messages.map(m => m.id)
    if (new Set(ids).size !== ids.length) { this.invalidate(); this.persist(); return }
    // Only a contiguous suffix of the last ordered window followed by unseen IDs is an append.
    const anchor = this.previous.at(-1)
    const end = anchor ? ids.indexOf(anchor) : -1
    const overlap = end >= 0 ? ids.slice(0, end + 1) : []
    const contiguous = overlap.length > 0 && overlap.length <= this.previous.length && overlap.every((id, i) => id === this.previous[this.previous.length - overlap.length + i])
    // Established baseline that lost overlap: cancel unsent work before recording the replacement.
    // First snapshot with empty previous is not a discontinuity and must not wipe local queues.
    if (this.previous.length > 0 && !contiguous) {
      this.generation++
      this.cancelUnsent()
    }
    const seen = new Set(this.ledger.seen)
    for (const m of messages) {
      for (const t of this.ledger.tasks) {
        if (t.state === 'sending' && t.conversation === o.conversation && m.role === 'user') {
          if (m.content === t.report || m.content.includes(t.id)) t.state = 'sent'
        }
      }
    }
    if (this.ledger.enabled && contiguous) {
      for (const m of messages.slice(end + 1)) {
        if (seen.has(o.conversation + '\n' + m.id) || m.role !== 'user' || !isPcStatusQuery(m.content)) continue
        if (this.wasHandledLocally(m.content)) continue
        this.enqueue(m.id)
      }
    }
    for (const id of ids) seen.add(o.conversation + '\n' + id)
    this.ledger.seen = [...seen]; this.previous = ids
    this.persist()
    void this.drain().catch(() => {})
  }
  private async drain() {
    if (this.busy) return
    this.busy = true
    const generation = this.generation
    try {
      for (const task of this.ledger.tasks) {
        if (generation !== this.generation || !this.ledger.enabled || !this.io.available() || this.io.account() !== this.ledger.account) return
        if (task.conversation !== this.conversation || !['queued', 'ready'].includes(task.state)) continue
        if (task.state === 'queued') {
          task.state = 'capturing'; this.persist()
          const capturedAt = new Date(this.now()).toISOString()
          let snapshot: string
          try { snapshot = (await this.io.snapshot()).slice(0, 6000) } catch { snapshot = 'Status collection failed. No snapshot available.' }
          if (generation !== this.generation || this.io.account() !== this.ledger.account) return
          task.report = `[MUSE_PC_STATUS task=${task.id}]\nLocal read-only data (not an assistant message).\nDevice: ${this.io.device.slice(0, 120)}\nCapture started: ${capturedAt}\n${snapshot}\n请向用户口语化、简洁汇报当前电脑运行状态、是否卡顿以及占用最高的应用（无需复述指令）。\n[/MUSE_PC_STATUS]`
          task.state = 'ready'; this.persist()
        }
        if (!this.io.available()) return
        task.state = 'sending'; this.persist() // durable before any composer side effect
        try {
          await this.io.send(task.report!, task.conversation, this.ledger.account)
        } catch (err) {
          // Definite preflight rejection: keep the same capture for a later healthy attempt.
          // Actual/uncertain click outcomes stay 'sending' and never blind-retry or resample.
          if (isPcReportNotSubmitted(err) && task.state === 'sending' && task.report) {
            task.state = 'ready'
            this.persist()
            return
          }
        }
      }
    } finally { this.busy = false }
  }
}
