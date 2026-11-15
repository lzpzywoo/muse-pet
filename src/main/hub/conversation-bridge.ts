import type { PcObservation } from '../pc-status-bridge'
import type { LocalToolCall, TaskStatus } from './sdk-types'
import { extractLocalToolCall } from './local-tool-call'

export interface HubConversationContext { account: string; conversation: string; sourceMessageId: string }
export interface HubTaskOutcome { status: TaskStatus; result?: unknown; error?: unknown }
export interface HubConversationDelivery extends HubConversationContext {
  taskId: string
  body: string
  options?: { image: string }
}
export interface HubConversationClaim extends HubConversationContext {
  key: string
  call: LocalToolCall
  taskId?: string
  state: 'claimed' | 'bound' | 'pending' | 'sending' | 'sent' | 'uncertain' | 'cancelled'
  delivery?: HubConversationDelivery
  reason?: string
}
export interface HubConversationLedger { version: 1; seen: string[]; claims: HubConversationClaim[] }
export interface HubConversationIO {
  load(): HubConversationLedger | null
  /** Must atomically replace durable state, or throw without changing it. */
  save(ledger: HubConversationLedger): void
  dispatch(call: LocalToolCall, context: HubConversationContext): Promise<{ taskId: string } & Partial<HubTaskOutcome>>
  /** Must recheck account/conversation/readiness immediately before composer effects. */
  send(delivery: HubConversationDelivery): Promise<void>
  isNotSubmitted(error: unknown): boolean
  /** Optional live guards, checked in addition to the latest observation. */
  account?(): string
  available?(): boolean
  onDelivery?(delivery: HubConversationDelivery): void
}

const terminal = (status: TaskStatus) => ['completed', 'failed', 'cancelled'].includes(status)
const keyFor = (account: string, conversation: string, id: string) => JSON.stringify([account, conversation, id])
const internal = (text: string) => /\[\/?MUSE_/i.test(text)
const stable = (id: string) => !!id.trim() && !/^cloud-\d+$/.test(id)

/** Durable at-most-once execution and conservative conversation-bound delivery. */
export class HubConversationBridge {
  private state: HubConversationLedger
  private current?: PcObservation
  private previous: string[] = []
  private baseline = false
  private sending = false
  private retryBlocked = new Set<string>()
  private dispatching = 0
  private early = new Map<string, HubTaskOutcome>()

  constructor(private io: HubConversationIO) {
    this.state = structuredClone(io.load() ?? { version: 1, seen: [], claims: [] })
    this.update(next => {
      for (const claim of next.claims) {
        if (claim.state === 'sending') {
          claim.state = 'uncertain'; claim.reason = 'Interrupted send; submission unknown'
        }
      }
    })
  }

  /** Snapshot only: callers cannot mutate the durable state through this property. */
  get ledger(): HubConversationLedger { return structuredClone(this.state) }

  private update(change: (next: HubConversationLedger) => void) {
    const next = structuredClone(this.state)
    change(next)
    this.io.save(structuredClone(next))
    this.state = next
  }

  async observe(observation: PcObservation): Promise<void> {
    const o = structuredClone(observation)
    this.retryBlocked.clear()
    const prior = this.current
    this.current = o // readiness/account changes interrupt an in-flight drain immediately
    const same = prior && prior.account === o.account && prior.conversation === o.conversation && prior.epoch === o.epoch
    if (!same || !o.account || !o.conversation) {
      this.baseline = false; this.previous = []
    }
    this.update(next => {
      for (const claim of next.claims) {
        if (claim.account !== o.account && !['sent', 'uncertain', 'cancelled'].includes(claim.state)) {
          claim.state = 'cancelled'; claim.reason = 'Account changed'
        }
      }
    })
    // Streaming snapshots must not consume unfinished assistant IDs or erase a same-epoch baseline.
    if (!o.ready || !o.account || !o.conversation) return
    const ids = o.messages.map(m => m.id)
    if (ids.some(id => !stable(id)) || new Set(ids).size !== ids.length) {
      this.baseline = false; this.previous = []; return
    }
    const anchor = this.previous.at(-1)
    const end = anchor ? ids.indexOf(anchor) : -1
    const overlap = Math.min(this.previous.length, end + 1)
    const continuous = this.baseline && end >= 0 && overlap > 0 &&
      ids.slice(end + 1 - overlap, end + 1).every((id, i) => id === this.previous[this.previous.length - overlap + i])
    const candidates: HubConversationClaim[] = []
    const seen = new Set(this.state.seen)
    if (continuous) {
      for (let i = end + 1; i < o.messages.length; i++) {
        const message = o.messages[i]
        const key = keyFor(o.account, o.conversation, message.id)
        const user = o.messages[i - 1]
        if (!seen.has(key) && message.role === 'user' && /^\/hub(?:\s+tools)?\s*$/i.test(message.content.trim())) {
          candidates.push({ key, account: o.account, conversation: o.conversation, sourceMessageId: message.id,
            call: { action: 'local_tool', appId: 'hub.catalog', toolId: 'list', parameters: {} }, state: 'claimed' })
          continue
        }
        const request = user?.content.replace(/\[MUSE_LOCAL_TOOLS\][\s\S]*?\[\/MUSE_LOCAL_TOOLS\]/gi, '').trim()
        if (seen.has(key) || message.role !== 'assistant' || user?.role !== 'user' || !request ||
            internal(request) || internal(message.content) || /^[\s]*[>“”"'「『]/.test(message.content)) continue
        const call = extractLocalToolCall(message.content)
        if (call) candidates.push({ key, account: o.account, conversation: o.conversation, sourceMessageId: message.id, call, state: 'claimed' })
      }
    }
    // Baseline and all claims become durable together, before any dispatch.
    this.update(next => {
      next.seen = [...new Set([...next.seen, ...ids.map(id => keyFor(o.account, o.conversation, id))])]
      next.claims.push(...candidates)
    })
    this.previous = ids; this.baseline = true
    for (const claim of candidates) {
      if (!this.eligible(claim) || this.state.claims.find(c => c.key === claim.key)?.state !== 'claimed') continue
      this.dispatching++
      try {
        const task = await this.io.dispatch(claim.call, this.context(claim))
        this.update(next => {
          const target = next.claims.find(c => c.key === claim.key)!
          target.taskId = task.taskId
          if (target.state === 'claimed') target.state = 'bound'
        })
        const outcome = this.early.get(task.taskId) ?? (task.status ? task as HubTaskOutcome : undefined)
        this.early.delete(task.taskId)
        if (outcome) await this.finish(task.taskId, outcome)
      } catch (error) {
        // Dispatch may already have executed. Retain the durable claim forever.
        this.update(next => {
          const target = next.claims.find(c => c.key === claim.key)!
          target.reason = 'Dispatch failed or outcome unknown'
        })
      } finally {
        if (--this.dispatching === 0) this.early.clear()
      }
    }
    await this.drain()
  }

  /** Safe from the Hub bus, including synchronous builtin completion during dispatch. */
  async finish(taskId: string, outcome: HubTaskOutcome): Promise<void> {
    if (!terminal(outcome.status)) return
    const claim = this.state.claims.find(c => c.taskId === taskId)
    if (!claim) {
      if (this.dispatching) this.early.set(taskId, structuredClone(outcome))
      return
    }
    if (claim.state !== 'bound') return
    const delivery = this.format(claim, outcome)
    this.update(next => {
      const target = next.claims.find(c => c.key === claim.key)!
      target.delivery = delivery; target.state = 'pending'
    })
    await this.drain()
  }

  private context(c: HubConversationContext): HubConversationContext {
    return { account: c.account, conversation: c.conversation, sourceMessageId: c.sourceMessageId }
  }

  private eligible(c: HubConversationContext) {
    const o = this.current
    return !!o?.ready && o.account === c.account && o.conversation === c.conversation &&
      (!this.io.account || this.io.account() === c.account) && (!this.io.available || this.io.available())
  }

  private format(claim: HubConversationClaim, outcome: HubTaskOutcome): HubConversationDelivery {
    let image: string | undefined
    let text: string
    try {
      text = JSON.stringify({ taskId: claim.taskId, appId: claim.call.appId, toolId: claim.call.toolId, ...outcome }, (key, value) => {
        if (typeof value === 'string' && /^data:image\/[^;]+;base64,/i.test(value)) {
          image ??= value
          return '[image attached]'
        }
        if (/base64/i.test(key)) return '[binary data omitted]'
        return value
      })
    } catch { text = JSON.stringify({ taskId: claim.taskId, status: outcome.status, error: 'Result could not be serialized' }) }
    // Keep the entire body bounded and syntactically valid JSON, even on truncation.
    const payload = text.length <= 5600 ? text : JSON.stringify({ truncated: true, preview: text.slice(0, 2700) })
    return {
      ...this.context(claim), taskId: claim.taskId!,
      body: `[MUSE_LOCAL_TOOL_RESULT]\n${payload}\n[/MUSE_LOCAL_TOOL_RESULT]`,
      ...(image ? { options: { image } } : {}),
    }
  }

  private async drain(): Promise<void> {
    if (this.sending) return
    this.sending = true
    try {
      for (;;) {
        const claim = this.state.claims.find(c => c.state === 'pending' && !this.retryBlocked.has(c.key) && this.eligible(c))
        if (!claim?.delivery) return
        this.update(next => { next.claims.find(c => c.key === claim.key)!.state = 'sending' })
        let state: HubConversationClaim['state'] = 'sent'
        let reason: string | undefined
        try { await this.io.send(structuredClone(claim.delivery)) }
        catch (error) {
          state = this.io.isNotSubmitted(error) ? 'pending' : 'uncertain'
          reason = state === 'pending' ? 'Not submitted; waiting for a later observation' : 'Submission unknown; automatic retry blocked'
        }
        this.update(next => {
          const target = next.claims.find(c => c.key === claim.key)!
          if (target.state !== 'cancelled') { target.state = state; target.reason = reason }
        })
        if (state === 'sent') {
          try { this.io.onDelivery?.(structuredClone(claim.delivery)) } catch { /* UI notification cannot affect delivery. */ }
        }
        if (state === 'pending') { this.retryBlocked.add(claim.key); return }
      }
    } finally { this.sending = false }
  }
}
