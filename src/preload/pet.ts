import { contextBridge, ipcRenderer } from 'electron'
import type { AvatarState, PetApi, PetBubblePayload } from '../types'

const petApi: PetApi = {
  toggleChat: () => {
    ipcRenderer.send('pet:toggle-chat')
  },
  onSyncAvatarState: (callback: (state: AvatarState) => void) => {
    const subscription = (_event: any, state: AvatarState) => callback(state)
    ipcRenderer.on('avatar:sync-state', subscription)
    return () => {
      ipcRenderer.removeListener('avatar:sync-state', subscription)
    }
  },
  getAvatarAssets: () => {
    return ipcRenderer.invoke('avatar:get-assets')
  },
  onAvatarAssetsUpdated: (callback) => {
    const subscription = (_event: any, assets: any) => callback(assets)
    ipcRenderer.on('avatar:assets-updated', subscription)
    return () => {
      ipcRenderer.removeListener('avatar:assets-updated', subscription)
    }
  },
  onSpeechBubble: (callback: (payload: PetBubblePayload | null) => void) => {
    const subscription = (_event: any, payload: PetBubblePayload | null) => callback(payload)
    ipcRenderer.on('pet:speech-bubble', subscription)
    return () => {
      ipcRenderer.removeListener('pet:speech-bubble', subscription)
    }
  },
  dismissBubble: () => {
    ipcRenderer.send('pet:dismiss-bubble')
  },
  setIgnoreMouseEvents: (ignore: boolean) => {
    ipcRenderer.send('pet:set-ignore-mouse-events', ignore)
  },
  getPosition: () => {
    return ipcRenderer.invoke('pet:get-position')
  },
  setPosition: (x: number, y: number) => {
    ipcRenderer.send('pet:set-position', { x, y })
  },
  close: () => {
    ipcRenderer.send('app:quit')
  },
  getAvatarState: () => {
    return ipcRenderer.invoke('avatar:get-state')
  },
  getPlugins: () => {
    return ipcRenderer.invoke('plugin:get-list')
  },
  onPluginsUpdated: (callback) => {
    const subscription = (_event: any, plugins: any) => callback(plugins)
    ipcRenderer.on('plugin:list-updated', subscription)
    return () => {
      ipcRenderer.removeListener('plugin:list-updated', subscription)
    }
  },
  getDisplayMode: () => {
    return ipcRenderer.invoke('pet:get-display-mode')
  },
  setDisplayMode: (mode) => {
    return ipcRenderer.invoke('pet:set-display-mode', mode)
  },
  onDisplayModeUpdated: (callback) => {
    const subscription = (_event: any, mode: any) => callback(mode)
    ipcRenderer.on('pet:display-mode-updated', subscription)
    return () => {
      ipcRenderer.removeListener('pet:display-mode-updated', subscription)
    }
  },
}

contextBridge.exposeInMainWorld('petApi', petApi)
