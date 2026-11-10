import { contextBridge, ipcRenderer } from 'electron'
import type { ChatApi, ChatMessage, UserProfile } from '../types'

const chatApi: ChatApi = {
  sendMessage: (content: string): Promise<void> => {
    return ipcRenderer.invoke('chat:send-message', content)
  },
  stopGeneration: () => {
    ipcRenderer.send('chat:stop-generation')
  },
  onStreamChunk: (callback: (chunk: string) => void) => {
    const subscription = (_event: any, chunk: string) => callback(chunk)
    ipcRenderer.on('chat:stream-chunk', subscription)
    return () => {
      ipcRenderer.removeListener('chat:stream-chunk', subscription)
    }
  },
  onStreamEnd: (callback: (fullContent: string) => void) => {
    const subscription = (_event: any, fullContent: string) => callback(fullContent)
    ipcRenderer.on('chat:stream-end', subscription)
    return () => {
      ipcRenderer.removeListener('chat:stream-end', subscription)
    }
  },
  onStreamError: (callback: (error: string) => void) => {
    const subscription = (_event: any, error: string) => callback(error)
    ipcRenderer.on('chat:stream-error', subscription)
    return () => {
      ipcRenderer.removeListener('chat:stream-error', subscription)
    }
  },
  getMessages: (): Promise<ChatMessage[]> => {
    return ipcRenderer.invoke('chat:get-messages')
  },
  syncMessages: (): Promise<ChatMessage[]> => {
    return ipcRenderer.invoke('chat:sync-messages')
  },
  onMessagesSynced: (callback: (messages: ChatMessage[]) => void) => {
    const subscription = (_event: any, messages: ChatMessage[]) => callback(messages)
    ipcRenderer.on('chat:messages-synced', subscription)
    return () => {
      ipcRenderer.removeListener('chat:messages-synced', subscription)
    }
  },
  clearMessages: (): Promise<void> => {
    return ipcRenderer.invoke('chat:clear-messages')
  },
  hide: () => {
    ipcRenderer.send('chat:hide')
  },
  getAuthStatus: (): Promise<UserProfile> => {
    return ipcRenderer.invoke('auth:get-status')
  },
  openLogin: (): Promise<void> => {
    return ipcRenderer.invoke('auth:open-login')
  },
  logout: (): Promise<void> => {
    return ipcRenderer.invoke('auth:logout')
  },
  onAuthChanged: (callback: (profile: UserProfile) => void) => {
    const subscription = (_event: any, profile: UserProfile) => callback(profile)
    ipcRenderer.on('auth:status-changed', subscription)
    return () => {
      ipcRenderer.removeListener('auth:status-changed', subscription)
    }
  },
  saveManualCookie: (cookie: string) => {
    return ipcRenderer.invoke('auth:save-manual-cookie', cookie)
  },
  getProxyConfig: () => {
    return ipcRenderer.invoke('proxy:get-config')
  },
  setProxyConfig: (config: any) => {
    return ipcRenderer.invoke('proxy:set-config', config)
  },
  testProxyConnection: () => {
    return ipcRenderer.invoke('proxy:test-connection')
  },
  approveSecretaryAction: (actionId: string) => {
    return ipcRenderer.invoke('secretary:approve-action', actionId)
  },
  denySecretaryAction: (actionId: string) => {
    return ipcRenderer.invoke('secretary:deny-action', actionId)
  },
  runSecretaryCommand: (title: string, command: string) => {
    return ipcRenderer.invoke('secretary:run-command', { title, command })
  },
  captureScreenAndAsk: (prompt?: string) => {
    return ipcRenderer.invoke('secretary:capture-screen-and-ask', prompt)
  },
  openGmailFilter: (filterQuery: string) => {
    return ipcRenderer.invoke('secretary:open-gmail-filter', filterQuery)
  },
  onSecretaryActionUpdated: (callback) => {
    const subscription = (_event: any, action: any) => callback(action)
    ipcRenderer.on('secretary:action-updated', subscription)
    return () => {
      ipcRenderer.removeListener('secretary:action-updated', subscription)
    }
  },
}

contextBridge.exposeInMainWorld('chatApi', chatApi)
