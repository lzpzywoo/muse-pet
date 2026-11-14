/**
 * Muse Local Agent Hub — shared type definitions.
 *
 * These types are the contract between Muse Pet (the hub) and any third-party
 * software that integrates through the local HTTP/WS API. They are intentionally
 * dependency-free so they can be mirrored by SDKs in other languages.
 */

export type RiskLevel = 'read-only' | 'write-safe' | 'write-dangerous'
export type ToolCategory = 'query' | 'action' | 'vision' | 'system'

/** A single capability exposed by an integrated application. */
export interface ToolDefinition {
  toolId: string
  name: string
  description: string
  category: ToolCategory
  riskLevel: RiskLevel
  inputSchema: Record<string, any>
  outputSchema?: Record<string, any>
  requiresApproval?: boolean
}

/** Manifest submitted by an application when it registers with the hub. */
export interface AppManifest {
  appId: string
  name: string
  version: string
  description: string
  icon?: string
  secret: string
  tools: ToolDefinition[]
}

/** A registered application, including runtime state owned by the hub. */
export interface RegisteredApp {
  manifest: AppManifest
  sessionToken: string
  registeredAt: number
  lastHeartbeat: number
  online: boolean
  activeTasks: number
  /** Tools whose execution is trusted without an approval card. */
  autoApproveToolIds: string[]
}

export type TaskStatus =
  | 'pending'
  | 'awaiting_approval'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface TaskProgress {
  percentage?: number
  current?: number
  total?: number
  etaSeconds?: number
  message?: string
}

export interface TaskError {
  code: string
  message: string
}

export interface HubTask {
  taskId: string
  appId: string
  toolId: string
  parameters: Record<string, any>
  status: TaskStatus
  priority: 'low' | 'normal' | 'high'
  progress?: TaskProgress
  result?: any
  error?: TaskError
  createdAt: number
  updatedAt: number
  completedAt?: number
  approvedBy?: 'user' | 'auto'
  /** Origin of the task so Luna reports can attribute it correctly. */
  origin: 'user' | 'luna' | 'system'
}

export type HubEventType =
  | 'app.registered'
  | 'app.offline'
  | 'task.progress'
  | 'task.completed'
  | 'task.failed'
  | 'task.cancelled'
  | 'task.dispatched'
  | 'task.approval_required'
  | 'screen.captured'

export interface HubEvent {
  eventId: string
  sourceAppId: string | 'hub'
  type: HubEventType
  timestamp: number
  payload: any
}

/** Response envelope used by every HTTP endpoint. */
export interface ApiResponse<T = any> {
  ok: boolean
  data?: T
  error?: string
}

/** Structured instruction Luna can emit to call a local tool. */
export interface LocalToolCall {
  action: 'local_tool'
  appId: string
  toolId: string
  parameters: Record<string, any>
}
