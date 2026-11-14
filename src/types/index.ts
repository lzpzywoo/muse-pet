export type AvatarState = 'idle' | 'listening' | 'thinking' | 'talking' | 'error'

export interface AvatarAssets {
  agentName?: string
  staticImageUrl?: string
  videos?: {
    default?: string
    working?: string
    resume?: string
  }
  updatedAt?: number
}

export interface ChatAttachment {
  type: 'image' | 'video'
  url: string
  title?: string
}

export interface PendingSecretaryAction {
  id: string
  /** hub_tool = Local Agent Hub write gate; never executes PowerShell. */
  type: 'powershell' | 'file_write' | 'hub_tool'
  title: string
  command: string
  description: string
  status: 'pending' | 'approved' | 'denied' | 'executed' | 'error'
  output?: string
  executedAt?: number
  /** Present when type === 'hub_tool'. */
  hubAppId?: string
  hubToolId?: string
}

export interface MusePlugin {
  id: string
  name: string
  description: string
  category: 'theme' | 'widget' | 'pet' | 'bundle'
  enabled: boolean
  chatCss?: string
  chatHtml?: string
  chatJs?: string
  petCss?: string
  petHtml?: string
  petJs?: string
  createdAt: number
}

export interface SecretaryState {
  plugins: MusePlugin[]
}

export interface CloudBrowserMessage {
  messageId: string
  sourceUrl: string
}

export type OpenCloudBrowserResult = { ok: true } | { ok: false; error: string }

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  browser?: CloudBrowserMessage
  attachments?: ChatAttachment[]
  pendingAction?: PendingSecretaryAction
  appliedPlugin?: MusePlugin
  timestamp: number
  status?: 'pending' | 'streaming' | 'done' | 'error'
}

export interface UserProfile {
  isLoggedIn: boolean
  name?: string
  agentName?: string
  avatarUrl?: string
  email?: string
}

export interface PetBubblePayload {
  id: string
  text: string
  status: 'thinking' | 'streaming' | 'done' | 'error'
  unreadCount?: number
  timestamp: number
}

export interface PetApi {
  toggleChat: () => void
  onSyncAvatarState: (callback: (state: AvatarState) => void) => () => void
  getAvatarAssets: () => Promise<AvatarAssets | null>
  onAvatarAssetsUpdated: (callback: (assets: AvatarAssets) => void) => () => void
  onSpeechBubble: (callback: (payload: PetBubblePayload | null) => void) => () => void
  dismissBubble: () => void
  setIgnoreMouseEvents: (ignore: boolean) => void
  getPosition: () => Promise<{ x: number; y: number }>
  setPosition: (x: number, y: number) => void
  close: () => void
  getAvatarState: () => Promise<AvatarState>
  getPlugins: () => Promise<MusePlugin[]>
  onPluginsUpdated: (callback: (plugins: MusePlugin[]) => void) => () => void
}

export type ProxyMode = 'system' | 'custom' | 'direct'

export interface ProxyConfig {
  mode: ProxyMode
  customRules?: string // e.g. "http://127.0.0.1:7890" or "socks5://127.0.0.1:1080"
}

export interface NetworkTestResult {
  success: boolean
  status?: number
  latencyMs?: number
  message?: string
}

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface MuseScheduledTask {
  title: string
  schedule: string
}

export interface MuseActivityEntry {
  day: string
  time: string
  title: string
  summary: string
}

export interface MuseCloudGoal {
  title: string
  description: string
}

export interface MuseCloudIdea {
  title: string
  description: string
}

export interface MuseCloudFileItem {
  name: string
  type: 'folder' | 'file'
  modified?: string
  size?: string
}

export interface MuseCloudSnapshot {
  agentName: string
  identityVibe?: string
  scheduledTasks: MuseScheduledTask[]
  activities: MuseActivityEntry[]
  goals: MuseCloudGoal[]
  ideas: MuseCloudIdea[]
  files: MuseCloudFileItem[]
  updatedAt: number
}

export type MuseCloudConsoleTarget = 'main' | 'wardrobe' | 'library' | 'goals' | 'ideas'

/** Live status of Muse's Hatch VM cloud browser task banner */
export interface MuseCloudBrowserStatus {
  active: boolean
  title?: string
  url?: string
  summary?: string
  updatedAt: number
}

export interface MuseHubEvent {
  eventId: string
  sourceAppId: string
  type: string
  timestamp: number
  payload: any
}

export interface MuseHubToolInfo {
  toolId: string
  name: string
  description: string
  category: 'query' | 'action' | 'vision' | 'system'
  riskLevel: 'read-only' | 'write-safe' | 'write-dangerous'
  trusted: boolean
}

export interface MuseHubAppInfo {
  appId: string
  name: string
  version: string
  description: string
  online: boolean
  activeTasks: number
  lastHeartbeat: number
  builtin: boolean
  tools: MuseHubToolInfo[]
}

export interface MuseHubTaskInfo {
  taskId: string
  appId: string
  toolId: string
  parameters: Record<string, any>
  status: 'pending' | 'awaiting_approval' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
  priority: 'low' | 'normal' | 'high'
  progress?: { percentage?: number; message?: string }
  result?: any
  error?: { code: string; message: string }
  createdAt: number
  updatedAt: number
  completedAt?: number
  origin: 'user' | 'luna' | 'system'
}

export interface MuseHubState {
  port: number
  apps: MuseHubAppInfo[]
  tasks: MuseHubTaskInfo[]
  toolSummary: string
}

export interface MuseLocalToolCall {
  action: 'local_tool'
  appId: string
  toolId: string
  parameters: Record<string, any>
}

export interface ChatApi {
  sendMessage: (content: string) => Promise<void>
  stopGeneration: () => void
  onStreamChunk: (callback: (chunk: string) => void) => () => void
  onStreamEnd: (callback: (fullContent: string) => void) => () => void
  onStreamError: (callback: (error: string) => void) => () => void
  getMessages: () => Promise<ChatMessage[]>
  syncMessages: () => Promise<ChatMessage[]>
  onMessagesSynced: (callback: (messages: ChatMessage[]) => void) => () => void
  clearMessages: () => Promise<void>
  hide: () => void
  getBounds: () => Promise<WindowBounds>
  setBounds: (bounds: Partial<WindowBounds>) => Promise<WindowBounds>
  resetBounds: () => Promise<WindowBounds>
  onBoundsChanged: (callback: (bounds: WindowBounds) => void) => () => void
  getAuthStatus: () => Promise<UserProfile>
  openLogin: () => Promise<void>
  logout: () => Promise<void>
  onAuthChanged: (callback: (profile: UserProfile) => void) => () => void
  saveManualCookie: (cookie: string) => Promise<boolean>
  getProxyConfig: () => Promise<ProxyConfig>
  setProxyConfig: (config: ProxyConfig) => Promise<boolean>
  testProxyConnection: () => Promise<NetworkTestResult>
  // Local Secretary Agent APIs
  approveSecretaryAction: (actionId: string) => Promise<PendingSecretaryAction>
  denySecretaryAction: (actionId: string) => Promise<PendingSecretaryAction>
  runSecretaryCommand: (title: string, command: string) => Promise<PendingSecretaryAction>
  captureScreenAndAsk: (prompt?: string) => Promise<void>
  openGmailFilter: (filterQuery: string) => Promise<void>
  onSecretaryActionUpdated: (callback: (action: PendingSecretaryAction) => void) => () => void
  // Secretary State (plugins only)
  getSecretaryState: () => Promise<SecretaryState>
  onSecretaryStateUpdated: (callback: (state: SecretaryState) => void) => () => void
  // Self-Modifying UI & Live Plugin APIs
  installPlugin: (plugin: Omit<MusePlugin, 'id' | 'createdAt'> & { id?: string }) => Promise<SecretaryState>
  togglePlugin: (id: string) => Promise<SecretaryState>
  removePlugin: (id: string) => Promise<SecretaryState>
  resetAllPlugins: () => Promise<SecretaryState>
  // Muse Cloud Hub & Native Console APIs
  getCloudSnapshot: (forceRefresh?: boolean) => Promise<MuseCloudSnapshot>
  readCloudFile: (fileName: string) => Promise<{ fileName: string; content: string }>
  openCloudConsole: (target?: MuseCloudConsoleTarget) => Promise<boolean>
  openCloudBrowser: (identity: CloudBrowserMessage) => Promise<OpenCloudBrowserResult>
  getCloudBrowserStatus: () => Promise<MuseCloudBrowserStatus>
  onCloudBrowserStatus: (callback: (status: MuseCloudBrowserStatus) => void) => () => void
  // Muse Local Agent Hub APIs
  getHubState: () => Promise<MuseHubState>
  dispatchHubTool: (call: MuseLocalToolCall) => Promise<{ ok: boolean; taskId?: string; status?: string; error?: string }>
  runHubTool: (appId: string, toolId: string, params?: Record<string, any>) => Promise<{ ok: boolean; taskId?: string; status?: string; result?: any; error?: string }>
  setHubToolTrusted: (appId: string, toolId: string, trusted: boolean) => Promise<{ ok: boolean }>
  cancelHubTask: (taskId: string) => Promise<{ ok: boolean }>
  removeHubApp: (appId: string) => Promise<{ ok: boolean; error?: string }>
  onHubEvent: (callback: (event: MuseHubEvent) => void) => () => void
}

declare global {
  interface Window {
    petApi?: PetApi
    chatApi?: ChatApi
  }
}
