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
  type: 'powershell' | 'file_write'
  title: string
  command: string
  description: string
  status: 'pending' | 'approved' | 'denied' | 'executed' | 'error'
  output?: string
  executedAt?: number
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  attachments?: ChatAttachment[]
  pendingAction?: PendingSecretaryAction
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
  close: () => void
  getAvatarState: () => Promise<AvatarState>
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
}

declare global {
  interface Window {
    petApi?: PetApi
    chatApi?: ChatApi
  }
}
