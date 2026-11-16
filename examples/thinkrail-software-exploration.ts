import type { SoftwareExplorationDescriptor, ToolDefinition } from '../src/main/hub/sdk-types'

/** Inject ThinkRail's real read service; this example never scans folders or infers activity. */
export interface ThinkRailReadSource {
  listProjects(): Promise<{ total: number; projects: Array<{ projectId: string; name: string; closed?: boolean }> }>
  list(query?: { status?: 'all' | 'active'; limit?: number; sessionId?: string }): Promise<{ total: number; sessions: Array<{
    sessionId: string; projectId: string; workspaceId: string; name: string; status: string;
    projectName?: string; workspaceName?: string;
    currentTasks?: Array<{ id: string; title: string; status: string }>;
    planProgress?: { done: number; total: number; percentage: number | null };
  }> }>
}

type Reference = { ref: string; title: string; kind: 'guide' | 'collection' | 'entity' | 'query'; description?: string; inputSchema?: Record<string, unknown> }
type Envelope = {
  protocol: 'muse-software/1'; kind: 'overview' | 'directory' | 'resource';
  status: 'ok' | 'unsupported' | 'unavailable'; source: { id: string; kind: 'live' | 'documentation' };
  observedAt: string; data?: unknown; references?: Reference[]
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const querySchema = { type: 'object', properties: { status: { type: 'string', enum: ['all', 'active'] }, limit: { type: 'integer', minimum: 1, maximum: 10 } }, additionalProperties: false }
const rootReferences: Reference[] = [
  { ref: 'thinkrail:guide', title: 'ThinkRail 概念与状态说明', kind: 'guide' },
  { ref: 'thinkrail:projects', title: '真实项目列表', kind: 'collection' },
  { ref: 'thinkrail:sessions', title: '真实会话与当前任务', kind: 'query', description: '查询正在运行或需要输入的会话；再读取具体会话追查任务。', inputSchema: querySchema },
]

export function createThinkRailExploration(source: ThinkRailReadSource) {
  const exploration: SoftwareExplorationDescriptor = {
    version: 1, overviewToolId: 'software_overview', discoverToolId: 'software_discover', readToolId: 'software_read',
  }
  const tools: ToolDefinition[] = [
    { toolId: exploration.overviewToolId, name: '理解 ThinkRail', description: '先了解 ThinkRail 的用途、项目/工作区/会话/任务关系和只读探索入口。', category: 'query', riskLevel: 'read-only', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { toolId: exploration.discoverToolId, name: '发现 ThinkRail 资源', description: '按目录或关键词发现可读取资源，不执行开发任务。', category: 'query', riskLevel: 'read-only', inputSchema: { type: 'object', properties: { parentRef: { type: 'string' }, query: { type: 'string' } }, additionalProperties: false } },
    { toolId: exploration.readToolId, name: '读取 ThinkRail 资源', description: '按已发现 ref 读取真实数据或帮助；禁止文件路径、shell 和写操作。', category: 'query', riskLevel: 'read-only', inputSchema: { type: 'object', properties: { ref: { type: 'string', minLength: 1 }, arguments: { type: 'object' } }, required: ['ref'], additionalProperties: false } },
  ]
  const envelope = (kind: Envelope['kind'], data: unknown, references: Reference[] = [], live = false): Envelope => ({
    protocol: 'muse-software/1', kind, status: 'ok', source: { id: live ? 'thinkrail:real-reader' : 'thinkrail:software-guide', kind: live ? 'live' : 'documentation' },
    observedAt: new Date().toISOString(), data, references,
  })
  const unavailable = (): Envelope => ({ protocol: 'muse-software/1', kind: 'resource', status: 'unavailable', source: { id: 'thinkrail:real-reader', kind: 'live' }, observedAt: new Date().toISOString(), data: { message: '无法查询 ThinkRail 真实状态，请检查实际服务连接。未将错误当成零会话。' } })
  const unsupported = (kind: Envelope['kind']): Envelope => ({ protocol: 'muse-software/1', kind, status: 'unsupported', source: { id: 'thinkrail:software-guide', kind: 'documentation' }, observedAt: new Date().toISOString(), data: { message: '此资源或参数不在当前只读适配器支持范围内。' } })
  const guide = {
    purpose: 'ThinkRail 是用于协调 coding agent 的开发工作台。',
    concepts: { project: '项目', workspace: '项目下的工作环境', session: '工作区中的对话/Agent会话', task: '会话的任务计划项' },
    workflow: '先发现资源，读取 active 会话；需要细节时读取返回的 session ref。没有 active 会话时明确报告空结果，也可读取 all。',
    limitations: ['只读查询，不启动开发任务、不修改代码、不代点界面。', 'planProgress 表示 TODO 计划完成比例，不代表 Agent 执行百分比。', '不以目录时间、TASK 文件存在或进程存在推断会话正在运行。'],
  }
  async function execute(toolId: string, parameters: Record<string, unknown> = {}): Promise<Envelope> {
    if (!object(parameters)) throw new Error('parameters must be an object')
    if (toolId === exploration.overviewToolId) return envelope('overview', guide, rootReferences)
    if (toolId === exploration.discoverToolId) {
      const parent = parameters.parentRef ?? 'thinkrail:root'
      if (typeof parent !== 'string' || (parameters.query !== undefined && typeof parameters.query !== 'string')) return unsupported('directory')
      if (!['thinkrail:root', 'thinkrail:guide'].includes(parent)) return unsupported('directory')
      const query = String(parameters.query ?? '').trim().toLowerCase()
      const references = query ? rootReferences.filter(item => `${item.ref} ${item.title} ${item.description ?? ''}`.toLowerCase().includes(query)) : rootReferences
      return envelope('directory', { total: references.length }, references)
    }
    if (toolId !== exploration.readToolId) throw new Error(`unknown exploration tool ${toolId}`)
    if (typeof parameters.ref !== 'string' || (parameters.arguments !== undefined && !object(parameters.arguments))) return unsupported('resource')
    const ref = parameters.ref
    const args = (parameters.arguments ?? {}) as Record<string, unknown>
    if (ref === 'thinkrail:guide') return Object.keys(args).length ? unsupported('resource') : envelope('resource', guide, rootReferences)
    if (ref === 'thinkrail:projects') {
      if (Object.keys(args).length) return unsupported('resource')
      try {
        const result = await source.listProjects()
        return envelope('resource', { total: result.total, projects: result.projects.slice(0, 10).map(project => ({ projectId: project.projectId, name: project.name, closed: project.closed })) }, [rootReferences[2]], true)
      } catch { return unavailable() }
    }
    if (ref === 'thinkrail:sessions' || ref.startsWith('thinkrail:session:')) {
      const detail = ref.startsWith('thinkrail:session:')
      if (Object.keys(args).some(key => !['status', 'limit'].includes(key)) || (detail && Object.keys(args).length)) return unsupported('resource')
      const status = detail ? 'all' : args.status ?? 'active'
      const limit = detail ? 1 : args.limit ?? 5
      if (!['all', 'active'].includes(String(status)) || typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 10) return unsupported('resource')
      let sessionId: string | undefined
      if (detail) {
        try { sessionId = decodeURIComponent(ref.slice('thinkrail:session:'.length)) } catch { return unsupported('resource') }
        if (!sessionId || sessionId.length > 200 || /[\\/\0]/.test(sessionId)) return unsupported('resource')
      }
      try {
        const result = await source.list({ status: status as 'all' | 'active', limit, ...(sessionId ? { sessionId } : {}) })
        const sessions = result.sessions.slice(0, limit).map(session => ({
          sessionId: session.sessionId, projectId: session.projectId, workspaceId: session.workspaceId,
          name: session.name, status: session.status, projectName: session.projectName, workspaceName: session.workspaceName,
          currentTasks: session.currentTasks?.slice(0, 10), planProgress: session.planProgress,
        }))
        const references: Reference[] = detail ? [] : sessions.map(session => ({ ref: `thinkrail:session:${encodeURIComponent(session.sessionId)}`, title: session.name, kind: 'entity', description: '读取此真实会话的当前任务及计划进度。' }))
        return envelope('resource', { total: result.total, sessions, progressMeaning: 'planProgress 是任务计划完成比例，不是执行百分比。' }, references, true)
      } catch { return unavailable() }
    }
    return unsupported('resource')
  }
  return { exploration, tools, execute }
}
