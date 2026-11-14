import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto'
import type { RiskLevel } from './sdk-types'

/**
 * Auth — issues and verifies hub session tokens and enforces the
 * read-only / write-safe / write-dangerous permission ladder.
 */
export class HubAuth {
  private tokens = new Map<string, { appId: string; issuedAt: number }>()

  constructor(
    private opts: {
      now?: () => number
      /** Secret used to sign tokens; persisted by the caller. */
      signingKey?: string
    } = {}
  ) {
    if (!opts.signingKey) {
      this.opts.signingKey = randomBytes(32).toString('hex')
    }
  }

  public get signingKey(): string {
    return this.opts.signingKey!
  }

  private now() {
    return this.opts.now?.() ?? Date.now()
  }

  public issueToken(appId: string): string {
    const issuedAt = this.now()
    const payload = JSON.stringify({ appId, issuedAt })
    const signature = createHmac('sha256', this.opts.signingKey!).update(payload).digest('hex')
    const token = Buffer.from(JSON.stringify({ p: payload, s: signature })).toString('base64url')
    this.tokens.set(token, { appId, issuedAt })
    return token
  }

  public verifyToken(token: string | undefined): string | null {
    if (!token) return null
    try {
      const decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))
      if (!decoded || typeof decoded.p !== 'string' || typeof decoded.s !== 'string') return null
      const expected = createHmac('sha256', this.opts.signingKey!).update(decoded.p).digest('hex')
      const a = Buffer.from(decoded.s)
      const b = Buffer.from(expected)
      if (a.length !== b.length || !timingSafeEqual(a, b)) return null
      if (!this.tokens.has(token)) return null
      const parsedPayload = JSON.parse(decoded.p)
      return typeof parsedPayload.appId === 'string' ? parsedPayload.appId : null
    } catch {
      return null
    }
  }

  public revokeToken(token: string) {
    this.tokens.delete(token)
  }

  public revokeApp(appId: string) {
    for (const [token, meta] of [...this.tokens.entries()]) {
      if (meta.appId === appId) this.tokens.delete(token)
    }
  }

  /**
   * Decide whether a tool call may run immediately.
   * - read-only: always allowed
   * - write-safe: allowed when the user trusted the tool
   * - write-dangerous: never auto-approved
   */
  public evaluate(riskLevel: RiskLevel, trusted: boolean): 'allow' | 'approve' {
    if (riskLevel === 'read-only') return 'allow'
    if (riskLevel === 'write-safe' && trusted) return 'allow'
    return 'approve'
  }
}
