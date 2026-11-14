import * as http from 'node:http'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { HubRegistry } from './registry'
import { HubAuth } from './auth'
import { TaskManager } from './task-manager'
import { HubEventBus } from './event-bus'
import { attachWebSocket, acceptKey, type WsConnection } from './ws'
import type { AppManifest, ApiResponse, HubEvent, RegisteredApp } from './sdk-types'

export const HUB_PORT = 19840
const HEARTBEAT_TIMEOUT_MS = 75_000
const SWEEP_INTERVAL_MS = 20_000
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 120

/**
 * HubServer — the Local Agent Hub HTTP/WS surface.
 *
 * Owns the registry, task engine, auth and event fan-out. Third-party software
 * talks to this server; Muse Pet internals talk to it through `dispatch()` and
 * the event bus.
 */
export class HubServer {
  public readonly port: number
  private server: http.Server | null = null
  private sockets = new Map<string, WsConnection>()
  private rateBuckets = new Map<string, { count: number; resetAt: number }>()
  private sweepTimer: NodeJS.Timeout | null = null
  private approvals = new Map<string, { resolve: (approved: boolean) => void }>()

  public readonly registry: HubRegistry
  public readonly tasks: TaskManager
  public readonly bus = new HubEventBus()
  private readonly auth: HubAuth

  constructor(
    private opts: {
      port?: number
      stateFilePath: string
      /** Execute a task inside the owning app. Resolves when the app acks. */
      executeTask: (taskId: string, appId: string, toolId: string, params: any) => Promise<void>
      /** Ask the user to approve a write task. Resolves true/false. */
      requestApproval: (taskId: string, appId: string, toolId: string, params: any) => Promise<boolean>
      now?: () => number
    }
  ) {
    this.port = opts.port ?? HUB_PORT
    this.auth = new HubAuth({ signingKey: this.loadOrCreateSigningKey() })
    this.registry = new HubRegistry({
      onOffline: (appId) => {
        const cancelled = this.tasks.cancelAppTasks(appId)
        this.publish({ eventId: randomUUID(), sourceAppId: 'hub', type: 'app.offline', timestamp: Date.now(), payload: { appId, cancelled } })
      },
      onRegistered: (app) => {
        this.publish({
          eventId: randomUUID(),
          sourceAppId: 'hub',
          type: 'app.registered',
          timestamp: Date.now(),
          payload: { appId: app.manifest.appId, name: app.manifest.name, tools: app.manifest.tools.length },
        })
      },
    })
    this.tasks = new TaskManager({ now: opts.now })
    this.tasks.onAny((event) => {
      this.publish(event)
    })
    this.restoreTrustedTools()
  }

  // ---------------------------------------------------------------- lifecycle

  private loadOrCreateSigningKey(): string {
    try {
      if (fs.existsSync(this.opts.stateFilePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.opts.stateFilePath, 'utf8'))
        if (typeof parsed.signingKey === 'string' && parsed.signingKey.length >= 32) {
          return parsed.signingKey
        }
      }
    } catch {
      /* regenerate */
    }
    return randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')
  }

  private persistState() {
    try {
      fs.mkdirSync(path.dirname(this.opts.stateFilePath), { recursive: true })
      fs.writeFileSync(
        this.opts.stateFilePath,
        JSON.stringify(
          {
            version: 1,
            signingKey: this.auth.signingKey,
            trusted: this.registry.listTrustedKeys(),
          },
          null,
          2
        ),
        { mode: 0o600 }
      )
    } catch {
      /* non-fatal */
    }
  }

  private restoreTrustedTools() {
    try {
      if (!fs.existsSync(this.opts.stateFilePath)) return
      const parsed = JSON.parse(fs.readFileSync(this.opts.stateFilePath, 'utf8'))
      if (!Array.isArray(parsed.trusted)) return
      for (const key of parsed.trusted) {
        if (typeof key !== 'string') continue
        const idx = key.indexOf('/')
        if (idx <= 0 || idx >= key.length - 1) continue
        this.registry.trustTool(key.slice(0, idx), key.slice(idx + 1))
      }
    } catch {
      /* non-fatal */
    }
  }

  public start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleHttp(req, res))

      this.server.on('upgrade', (req, socket) => {
        const key = req.headers['sec-websocket-key']
        if (typeof key !== 'string') {
          socket.destroy()
          return
        }
        socket.write(
          [
            'HTTP/1.1 101 Switching Protocols',
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Accept: ${acceptKey(key)}`,
            '\r\n',
          ].join('\r\n')
        )
        const conn = attachWebSocket(socket as any)
        this.handleUpgrade(req, conn)
      })

      this.server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          console.warn(`[Hub] port ${this.port} already in use; hub API unavailable`)
          resolve()
          return
        }
        reject(err)
      })

      this.server.listen(this.port, '127.0.0.1', () => {
        console.log(`[Hub] Local Agent Hub listening on http://127.0.0.1:${this.port}`)
        this.sweepTimer = setInterval(() => {
          this.registry.sweepOffline(HEARTBEAT_TIMEOUT_MS)
        }, SWEEP_INTERVAL_MS)
        this.persistState()
        resolve()
      })
    })
  }

  public stop() {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    for (const conn of this.sockets.values()) conn.close(1001, 'hub shutting down')
    this.sockets.clear()
    this.server?.close()
    this.server = null
  }

  // ------------------------------------------------------------------- HTTP

  private json<T>(res: http.ServerResponse, status: number, body: ApiResponse<T>) {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': 'http://127.0.0.1',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-App-Id',
    })
    res.end(text)
  }

  private rateLimited(appId: string): boolean {
    const now = Date.now()
    const bucket = this.rateBuckets.get(appId)
    if (!bucket || now > bucket.resetAt) {
      this.rateBuckets.set(appId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
      return false
    }
    bucket.count++
    return bucket.count > RATE_LIMIT_MAX
  }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`)
    if (req.method === 'OPTIONS') {
      this.json(res, 204, { ok: true })
      return
    }

    const authHeader = req.headers['authorization']
    const token = typeof authHeader === 'string' ? authHeader.replace(/^Bearer\s+/i, '') : undefined
    const appIdFromToken = this.auth.verifyToken(token)
    const headerAppId = req.headers['x-app-id']

    try {
      // ---- public discovery endpoints
      if (req.method === 'GET' && url.pathname === '/api/v1/tools') {
        this.json(res, 200, { ok: true, data: this.registry.allTools() })
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/apps') {
        this.json(res, 200, {
          ok: true,
          data: this.registry.list().map((a) => this.publicApp(a)),
        })
        return
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/v1/apps/')) {
        const appId = decodeURIComponent(url.pathname.split('/').pop()!)
        const app = this.registry.get(appId)
        if (!app) {
          this.json(res, 404, { ok: false, error: 'app not found' })
          return
        }
        this.json(res, 200, { ok: true, data: this.publicApp(app) })
        return
      }

      // ---- registration (carries its own secret, no bearer token yet)
      if (req.method === 'POST' && url.pathname === '/api/v1/register') {
        const body = await this.readBody(req)
        const manifest = JSON.parse(body) as AppManifest
        const app = this.registry.register(manifest)
        const sessionToken = this.auth.issueToken(app.manifest.appId)
        app.sessionToken = sessionToken
        this.persistState()
        this.json(res, 200, {
          ok: true,
          data: { sessionToken, hubVersion: 1, heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS },
        })
        return
      }

      // ---- authenticated endpoints
      if (!appIdFromToken || appIdFromToken !== headerAppId) {
        this.json(res, 401, { ok: false, error: 'invalid or missing session token' })
        return
      }
      if (this.rateLimited(appIdFromToken)) {
        this.json(res, 429, { ok: false, error: 'rate limit exceeded' })
        return
      }

      if (req.method === 'DELETE' && url.pathname.startsWith('/api/v1/register/')) {
        const target = decodeURIComponent(url.pathname.split('/').pop()!)
        if (target !== appIdFromToken) {
          this.json(res, 403, { ok: false, error: 'cannot unregister another app' })
          return
        }
        this.tasks.cancelAppTasks(target, 'app unregistered')
        this.registry.unregister(target)
        this.auth.revokeApp(target)
        this.json(res, 200, { ok: true })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/heartbeat') {
        const body = JSON.parse(await this.readBody(req))
        const app = this.registry.heartbeat(appIdFromToken, body.status)
        if (!app) {
          this.json(res, 404, { ok: false, error: 'app not registered' })
          return
        }
        this.registry.setActiveTasks(appIdFromToken, Number(body.activeTasks) || 0)
        this.json(res, 200, { ok: true, data: { online: true } })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/tasks') {
        const body = JSON.parse(await this.readBody(req))
        const tool = this.registry.findTool(appIdFromToken, body.toolId)
        if (!tool) {
          this.json(res, 404, { ok: false, error: `tool ${body.toolId} not found for this app` })
          return
        }
        const task = this.tasks.create({
          appId: appIdFromToken,
          toolId: body.toolId,
          parameters: body.parameters ?? {},
          priority: body.priority,
          origin: body.origin ?? 'user',
        })
        const decision = this.auth.evaluate(tool.riskLevel, this.registry.isTrusted(appIdFromToken, tool.toolId))
        if (decision === 'approve' || tool.requiresApproval) {
          this.tasks.markAwaitingApproval(task.taskId)
          this.json(res, 202, { ok: true, data: { taskId: task.taskId, status: task.status } })
          return
        }
        this.tasks.markDispatched(task.taskId)
        this.deliverTask(task.taskId, appIdFromToken, body.toolId, body.parameters ?? {})
        this.json(res, 200, { ok: true, data: { taskId: task.taskId, status: task.status } })
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/v1/tasks') {
        const appId = url.searchParams.get('appId') ?? undefined
        const status = (url.searchParams.get('status') as any) ?? undefined
        this.json(res, 200, { ok: true, data: this.tasks.list({ appId, status }) })
        return
      }

      const taskMatch = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)(\/(cancel|approve|reject|progress|complete|fail))?$/)
      if (taskMatch) {
        const taskId = decodeURIComponent(taskMatch[1])
        const sub = taskMatch[2]?.slice(1)
        const task = this.tasks.get(taskId)
        if (!task) {
          this.json(res, 404, { ok: false, error: 'task not found' })
          return
        }
        if (task.appId !== appIdFromToken && appIdFromToken !== 'hub') {
          this.json(res, 403, { ok: false, error: 'task belongs to another app' })
          return
        }

        if (req.method === 'GET' && !sub) {
          this.json(res, 200, { ok: true, data: task })
          return
        }

        const body = sub ? JSON.parse(await this.readBody(req)) : {}
        if (sub === 'progress') {
          this.tasks.updateProgress(taskId, body)
          this.json(res, 200, { ok: true })
          return
        }
        if (sub === 'complete') {
          this.tasks.complete(taskId, body.result)
          this.json(res, 200, { ok: true })
          return
        }
        if (sub === 'fail') {
          this.tasks.fail(taskId, body.error ?? { code: 'UNKNOWN', message: 'failed' })
          this.json(res, 200, { ok: true })
          return
        }
        if (sub === 'cancel') {
          this.tasks.cancel(taskId, body.reason)
          this.json(res, 200, { ok: true })
          return
        }
        if (sub === 'approve' || sub === 'reject') {
          this.resolveApproval(taskId, sub === 'approve')
          this.json(res, 200, { ok: true })
          return
        }
      }

      this.json(res, 404, { ok: false, error: 'unknown endpoint' })
    } catch (err: any) {
      this.json(res, 400, { ok: false, error: err?.message ?? 'bad request' })
    }
  }

  private publicApp(app: RegisteredApp) {
    return {
      appId: app.manifest.appId,
      name: app.manifest.name,
      version: app.manifest.version,
      description: app.manifest.description,
      online: app.online,
      activeTasks: app.activeTasks,
      lastHeartbeat: app.lastHeartbeat,
      tools: app.manifest.tools.map((t) => ({
        toolId: t.toolId,
        name: t.name,
        description: t.description,
        category: t.category,
        riskLevel: t.riskLevel,
        trusted: this.registry.isTrusted(app.manifest.appId, t.toolId),
      })),
    }
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let raw = ''
      req.on('data', (chunk) => {
        raw += chunk
        if (raw.length > 2 * 1024 * 1024) {
          reject(new Error('payload too large'))
          req.destroy()
        }
      })
      req.on('end', () => resolve(raw || '{}'))
      req.on('error', reject)
    })
  }

  // -------------------------------------------------------------- websocket

  private handleUpgrade(req: http.IncomingMessage, conn: WsConnection) {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`)
    const appId = url.searchParams.get('appId')
    const secret = url.searchParams.get('secret')
    if (!appId || !secret || !this.registry.authenticate(appId, secret)) {
      conn.close(1008, 'unauthorized')
      return
    }
    this.sockets.set(appId, conn)
    this.registry.heartbeat(appId)
    conn.onMessage((raw) => this.handleAppMessage(appId, raw))
    conn.onClose(() => {
      this.sockets.delete(appId)
    })
    conn.send(
      JSON.stringify({
        type: 'hub.connected',
        timestamp: Date.now(),
        payload: { appId, heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS },
      })
    )
  }

  private handleAppMessage(appId: string, raw: string) {
    try {
      const msg = JSON.parse(raw)
      if (msg.type === 'heartbeat') {
        this.registry.heartbeat(appId, msg.payload?.status)
        this.registry.setActiveTasks(appId, Number(msg.payload?.activeTasks) || 0)
        return
      }
      if (msg.type === 'task.progress') {
        this.tasks.updateProgress(msg.taskId, msg.payload ?? {})
        return
      }
      if (msg.type === 'task.completed') {
        this.tasks.complete(msg.taskId, msg.payload?.result)
        return
      }
      if (msg.type === 'task.failed') {
        this.tasks.fail(msg.taskId, msg.payload?.error ?? { code: 'UNKNOWN', message: 'failed' })
        return
      }
      if (msg.type === 'event') {
        this.publish({
          eventId: randomUUID(),
          sourceAppId: appId,
          type: msg.payload?.type ?? 'task.progress',
          timestamp: Date.now(),
          payload: msg.payload,
        })
      }
    } catch {
      /* malformed frames are ignored */
    }
  }

  /** Deliver one third-party task frame matching the documented WS contract. */
  private sendTaskDispatched(
    taskId: string,
    appId: string,
    toolId: string,
    parameters: Record<string, any>
  ): boolean {
    const conn = this.sockets.get(appId)
    if (!conn || !conn.isOpen) return false
    conn.send(
      JSON.stringify({
        type: 'task.dispatched',
        taskId,
        payload: { taskId, toolId, parameters },
        timestamp: Date.now(),
      })
    )
    return true
  }

  private publish(event: HubEvent) {
    this.bus.publish(event)
  }

  // --------------------------------------------------------- in-process API

  /**
   * Dispatch a tool call on behalf of Luna or the user.
   * Returns the taskId immediately; progress arrives via events.
   */
  public async dispatch(input: {
    appId: string
    toolId: string
    parameters: Record<string, any>
    origin?: 'user' | 'luna' | 'system'
  }): Promise<{ taskId: string; status: string }> {
    const tool = this.registry.findTool(input.appId, input.toolId)
    if (!tool) throw new Error(`tool ${input.toolId} not available on ${input.appId}`)
    const app = this.registry.get(input.appId)
    if (!app?.online) throw new Error(`${input.appId} is offline`)

    const task = this.tasks.create({ ...input, origin: input.origin ?? 'luna' })
    const decision = this.auth.evaluate(tool.riskLevel, this.registry.isTrusted(input.appId, input.toolId))
    if (decision === 'approve' || tool.requiresApproval) {
      this.tasks.markAwaitingApproval(task.taskId)
      const approved = await this.opts.requestApproval(task.taskId, input.appId, input.toolId, input.parameters)
      if (!approved) {
        this.tasks.cancel(task.taskId, 'user rejected')
        return { taskId: task.taskId, status: 'cancelled' }
      }
      task.approvedBy = 'user'
    }
    this.tasks.markDispatched(task.taskId)
    this.deliverTask(task.taskId, input.appId, input.toolId, input.parameters)
    return { taskId: task.taskId, status: task.status }
  }

  /** Prefer the live WS socket; fall back to the in-process executeTask hook (builtins). */
  private deliverTask(
    taskId: string,
    appId: string,
    toolId: string,
    parameters: Record<string, any>
  ) {
    if (this.sendTaskDispatched(taskId, appId, toolId, parameters)) return
    void this.opts.executeTask(taskId, appId, toolId, parameters).catch(() => {})
  }

  public waitForApproval(taskId: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.approvals.set(taskId, { resolve })
    })
  }

  /** Unblock a waitForApproval waiter (UI Allow/Deny or HTTP approve/reject). */
  public resolveApproval(taskId: string, approved: boolean): boolean {
    const pending = this.approvals.get(taskId)
    if (!pending) return false
    this.approvals.delete(taskId)
    pending.resolve(approved)
    return true
  }

  public trustTool(appId: string, toolId: string) {
    this.registry.trustTool(appId, toolId)
    this.persistState()
  }

  public untrustTool(appId: string, toolId: string) {
    this.registry.untrustTool(appId, toolId)
    this.persistState()
  }

  /** Human-readable capability list injected into Luna's context. */
  public describeToolsForLuna(): string {
    const tools = this.registry.allTools()
    if (tools.length === 0) return ''
    const lines = tools.map((entry, idx) => {
      const trust = this.registry.isTrusted(entry.appId, entry.tool.toolId) ? ' [已信任]' : ''
      return `${idx + 1}. ${entry.appName} (${entry.appId}) — ${entry.tool.name} [${entry.tool.riskLevel}]${trust}\n   toolId: ${entry.tool.toolId}\n   ${entry.tool.description}`
    })
    return [
      '当前电脑已接入以下本地软件能力（Muse Local Agent Hub）：',
      ...lines,
      '如需调用，请输出 JSON：{"action":"local_tool","appId":"...","toolId":"...","parameters":{...}}',
    ].join('\n')
  }
}
