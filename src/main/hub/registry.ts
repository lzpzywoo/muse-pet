import { randomBytes, createHash } from 'node:crypto'
import type { AppManifest, RegisteredApp, ToolDefinition, RiskLevel } from './sdk-types'

/**
 * Registry — owns application lifecycle: registration, session tokens,
 * heartbeat tracking and offline detection.
 *
 * No HTTP or Electron concerns live here so the rules stay unit-testable.
 */
export class HubRegistry {
  private apps = new Map<string, RegisteredApp>()
  /** Persisted secrets per appId so restarts do not require re-pairing. */
  private secrets = new Map<string, string>()
  /** Tool IDs the user marked as trusted (skip approval cards). */
  private trustedTools = new Set<string>()

  constructor(
    private opts: {
      now?: () => number
      onOffline?: (appId: string) => void
      onRegistered?: (app: RegisteredApp) => void
    } = {}
  ) {}

  private now() {
    return this.opts.now?.() ?? Date.now()
  }

  public register(manifest: AppManifest): RegisteredApp {
    const validation = this.validateManifest(manifest)
    if (!validation.ok) {
      throw new Error(validation.error)
    }

    const appId = manifest.appId
    const sessionToken = randomBytes(24).toString('hex')
    const existing = this.apps.get(appId)

    const app: RegisteredApp = {
      manifest,
      sessionToken,
      registeredAt: existing?.registeredAt ?? this.now(),
      lastHeartbeat: this.now(),
      online: true,
      activeTasks: 0,
      autoApproveToolIds: existing?.autoApproveToolIds ?? [],
    }

    this.apps.set(appId, app)
    this.secrets.set(appId, manifest.secret)
    this.opts.onRegistered?.(app)
    return app
  }

  private validateManifest(manifest: AppManifest): { ok: boolean; error?: string } {
    if (!manifest || typeof manifest.appId !== 'string' || !/^[a-z0-9._-]{3,80}$/i.test(manifest.appId)) {
      return { ok: false, error: 'appId must be 3-80 chars of letters, digits, dot, underscore or hyphen.' }
    }
    if (!manifest.name || typeof manifest.name !== 'string') {
      return { ok: false, error: 'name is required.' }
    }
    if (!manifest.secret || typeof manifest.secret !== 'string' || manifest.secret.length < 8) {
      return { ok: false, error: 'secret must be at least 8 characters.' }
    }
    if (!Array.isArray(manifest.tools) || manifest.tools.length === 0) {
      return { ok: false, error: 'at least one tool must be declared.' }
    }
    for (const tool of manifest.tools) {
      if (!tool.toolId || !/^[a-z0-9._-]{2,60}$/i.test(tool.toolId)) {
        return { ok: false, error: `invalid toolId: ${String(tool.toolId)}` }
      }
      if (!tool.name || !tool.description) {
        return { ok: false, error: `tool ${tool.toolId} needs name and description.` }
      }
      if (!['read-only', 'write-safe', 'write-dangerous'].includes(tool.riskLevel)) {
        return { ok: false, error: `tool ${tool.toolId} has invalid riskLevel.` }
      }
    }
    const ids = manifest.tools.map((t) => t.toolId)
    if (new Set(ids).size !== ids.length) {
      return { ok: false, error: 'duplicate toolId in manifest.' }
    }
    return { ok: true }
  }

  public authenticate(appId: string, secret: string): RegisteredApp | null {
    const app = this.apps.get(appId)
    if (!app || !app.online) return null
    if (this.secrets.get(appId) !== secret) return null
    return app
  }

  public get(appId: string): RegisteredApp | undefined {
    return this.apps.get(appId)
  }

  public list(): RegisteredApp[] {
    return [...this.apps.values()]
  }

  public listOnline(): RegisteredApp[] {
    return this.list().filter((a) => a.online)
  }

  public unregister(appId: string): boolean {
    const existed = this.apps.delete(appId)
    this.secrets.delete(appId)
    return existed
  }

  public heartbeat(appId: string, status?: 'active' | 'busy' | 'paused'): RegisteredApp | null {
    const app = this.apps.get(appId)
    if (!app) return null
    app.lastHeartbeat = this.now()
    if (!app.online) {
      app.online = true
    }
    return app
  }

  public setActiveTasks(appId: string, count: number) {
    const app = this.apps.get(appId)
    if (app) app.activeTasks = Math.max(0, count)
  }

  /** Mark apps stale as offline when they stop heartbeating. */
  public sweepOffline(timeoutMs: number): string[] {
    const now = this.now()
    const newlyOffline: string[] = []
    for (const app of this.apps.values()) {
      if (app.online && now - app.lastHeartbeat > timeoutMs) {
        app.online = false
        newlyOffline.push(app.manifest.appId)
        this.opts.onOffline?.(app.manifest.appId)
      }
    }
    return newlyOffline
  }

  public trustTool(appId: string, toolId: string) {
    this.trustedTools.add(`${appId}/${toolId}`)
    const app = this.apps.get(appId)
    if (app && !app.autoApproveToolIds.includes(toolId)) {
      app.autoApproveToolIds.push(toolId)
    }
  }

  public untrustTool(appId: string, toolId: string) {
    this.trustedTools.delete(`${appId}/${toolId}`)
    const app = this.apps.get(appId)
    if (app) app.autoApproveToolIds = app.autoApproveToolIds.filter((t) => t !== toolId)
  }

  public isTrusted(appId: string, toolId: string): boolean {
    return this.trustedTools.has(`${appId}/${toolId}`)
  }

  public findTool(appId: string, toolId: string): ToolDefinition | null {
    const app = this.apps.get(appId)
    if (!app) return null
    return app.manifest.tools.find((t) => t.toolId === toolId) ?? null
  }

  public allTools(): Array<{ appId: string; appName: string; tool: ToolDefinition }> {
    const out: Array<{ appId: string; appName: string; tool: ToolDefinition }> = []
    for (const app of this.listOnline()) {
      for (const tool of app.manifest.tools) {
        out.push({ appId: app.manifest.appId, appName: app.manifest.name, tool })
      }
    }
    return out
  }

  /** Stable, non-reversible app fingerprint used for logs and diagnostics. */
  public fingerprint(appId: string): string {
    return createHash('sha256').update(`muse-hub:${appId}`).digest('hex').slice(0, 12)
  }

  public riskSummary(): Record<RiskLevel, number> {
    const summary: Record<RiskLevel, number> = { 'read-only': 0, 'write-safe': 0, 'write-dangerous': 0 }
    for (const entry of this.allTools()) summary[entry.tool.riskLevel]++
    return summary
  }
}
