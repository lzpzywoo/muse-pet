export type AvatarState = 'idle' | 'listening' | 'thinking' | 'talking' | 'error'

export type PetDisplayMode = 'smart' | 'full' | 'video'

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
  type: 'powershell' | 'file_write'
  title: string
  command: string
  description: string
  status: 'pending' | 'approved' | 'denied' | 'executed' | 'error'
  output?: string
  executedAt?: number
}

export interface SecretaryReminder {
  id: string
  title: string
  dueAt: number
  createdAt: number
  fired: boolean
  source: 'reminder' | 'focus' | 'meeting'
}

export interface SecretaryTodoItem {
  id: string
  text: string
  done: boolean
  createdAt: number
  completedAt?: number
}

export type WorkflowMacroId = 'work' | 'focus' | 'meeting' | 'off'

export interface WorkflowMacroConfig {
  id: WorkflowMacroId
  name: string
  description: string
  urls: string[]
  apps: string[]
  defaultMinutes?: number
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
  reminders: SecretaryReminder[]
  todos: SecretaryTodoItem[]
  workflows: Record<WorkflowMacroId, WorkflowMacroConfig>
  plugins: MusePlugin[]
  petDisplayMode?: PetDisplayMode
  lastBriefDate?: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
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
  getDisplayMode: () => Promise<PetDisplayMode>
  setDisplayMode: (mode: PetDisplayMode) => Promise<PetDisplayMode>
  onDisplayModeUpdated: (callback: (mode: PetDisplayMode) => void) => () => void
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
  // Proactive Briefing, Schedule & Workspace Workflows APIs
  getSecretaryState: () => Promise<SecretaryState>
  updateWorkflowConfig: (
    id: WorkflowMacroId,
    patch: Partial<WorkflowMacroConfig>
  ) => Promise<SecretaryState>
  addSecretaryReminder: (
    title: string,
    delayMinutes: number,
    source?: SecretaryReminder['source']
  ) => Promise<SecretaryState>
  removeSecretaryReminder: (id: string) => Promise<SecretaryState>
  addSecretaryTodo: (text: string) => Promise<SecretaryState>
  toggleSecretaryTodo: (id: string) => Promise<SecretaryState>
  removeSecretaryTodo: (id: string) => Promise<SecretaryState>
  onSecretaryStateUpdated: (callback: (state: SecretaryState) => void) => () => void
  // Self-Modifying UI & Live Plugin APIs
  installPlugin: (plugin: Omit<MusePlugin, 'id' | 'createdAt'> & { id?: string }) => Promise<SecretaryState>
  togglePlugin: (id: string) => Promise<SecretaryState>
  removePlugin: (id: string) => Promise<SecretaryState>
  resetAllPlugins: () => Promise<SecretaryState>
  setPetDisplayMode: (mode: PetDisplayMode) => Promise<SecretaryState>
}

declare global {
  interface Window {
    petApi?: PetApi
    chatApi?: ChatApi
  }
}
