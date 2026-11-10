import { ipcMain, app, session } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { WindowManager } from './window-manager'
import { MuseClient, extractMuseSessionCookies, MUSE_PARTITION } from './muse-client'
import { SessionStore } from './session-store'
import { ProxyManager } from './proxy-manager'
import type { ChatMessage, PetBubblePayload, ProxyConfig } from '../types'

export function registerIpcHandlers(
  windowManager: WindowManager,
  museClient: MuseClient,
  sessionStore: SessionStore,
  proxyManager: ProxyManager
) {
  const historyFilePath = path.join(app.getPath('userData'), 'chat_history.json')
  let messageHistory: ChatMessage[] = []
  let unreadCount = 0

  const loadPersistedHistory = () => {
    try {
      if (fs.existsSync(historyFilePath)) {
        const parsed = JSON.parse(fs.readFileSync(historyFilePath, 'utf-8'))
        if (Array.isArray(parsed)) {
          messageHistory = parsed
        }
      }
    } catch {
      // ignore
    }
  }

  const savePersistedHistory = () => {
    try {
      fs.writeFileSync(
        historyFilePath,
        JSON.stringify(messageHistory.slice(-100), null, 2),
        'utf-8'
      )
    } catch {
      // ignore
    }
  }

  const sendPetBubble = (payload: PetBubblePayload | null) => {
    const petWin = windowManager.getPetWindow()
    if (petWin && !petWin.isDestroyed()) {
      petWin.webContents.send('pet:speech-bubble', payload)
    }
  }

  const broadcastMessagesSynced = () => {
    const chatWin = windowManager.getChatWindow()
    if (chatWin && !chatWin.isDestroyed()) {
      chatWin.webContents.send('chat:messages-synced', messageHistory)
    }
  }

  loadPersistedHistory()
  museClient.startCloudMessageWatcher()

  // Receive background cloud message updates (e.g., from muse.ai web or initial cloud history)
  museClient.onCloudMessagesUpdated((cloudMessages, newAssistantMsg) => {
    if (cloudMessages.length > 0 && messageHistory.length === 0) {
      messageHistory = cloudMessages
      savePersistedHistory()
      broadcastMessagesSynced()
    } else if (newAssistantMsg) {
      const exists = messageHistory.some(
        (m) => m.id === newAssistantMsg.id || (m.role === 'assistant' && m.content === newAssistantMsg.content)
      )
      if (!exists) {
        messageHistory = cloudMessages
        savePersistedHistory()
        broadcastMessagesSynced()

        const chatWin = windowManager.getChatWindow()
        const isChatHidden = !chatWin || chatWin.isDestroyed() || !chatWin.isVisible()
        if (isChatHidden) {
          unreadCount++
        }
        windowManager.setAvatarState('talking')
        sendPetBubble({
          id: newAssistantMsg.id,
          text: newAssistantMsg.content,
          status: 'done',
          unreadCount,
          timestamp: Date.now(),
        })
        setTimeout(() => {
          if (windowManager.getAvatarState() === 'talking') {
            windowManager.setAvatarState('idle')
          }
        }, 3500)
      }
    }
  })

  // Pet Window events
  ipcMain.on('pet:toggle-chat', () => {
    windowManager.toggleChatWindow()
    const chatWin = windowManager.getChatWindow()
    if (chatWin && !chatWin.isDestroyed() && chatWin.isVisible()) {
      unreadCount = 0
    }
  })

  ipcMain.on('pet:dismiss-bubble', () => {
    unreadCount = 0
    sendPetBubble(null)
  })

  ipcMain.on('pet:set-ignore-mouse-events', (event, ignore: boolean) => {
    const win = windowManager.getPetWindow()
    if (win && !win.isDestroyed()) {
      win.setIgnoreMouseEvents(ignore, { forward: true })
    }
  })

  ipcMain.handle('avatar:get-state', () => {
    return windowManager.getAvatarState()
  })

  ipcMain.handle('avatar:get-assets', async () => {
    const cached = museClient.getCachedAvatarAssets()
    if (cached) {
      // Trigger background refresh if logged in
      if (sessionStore.getProfile().isLoggedIn) {
        museClient.syncAvatarAssets().catch(() => {})
      }
      return cached
    }
    if (sessionStore.getProfile().isLoggedIn) {
      return await museClient.syncAvatarAssets()
    }
    return null
  })

  museClient.onAvatarSynced((assets) => {
    const petWin = windowManager.getPetWindow()
    if (petWin && !petWin.isDestroyed()) {
      petWin.webContents.send('avatar:assets-updated', assets)
    }
    const chatWin = windowManager.getChatWindow()
    if (chatWin && !chatWin.isDestroyed()) {
      chatWin.webContents.send('auth:status-changed', sessionStore.getProfile())
    }
  })

  // Chat Window events
  ipcMain.on('chat:hide', () => {
    windowManager.hideChatWindow()
  })

  ipcMain.handle('chat:get-messages', async () => {
    if (messageHistory.length === 0 && sessionStore.getProfile().isLoggedIn) {
      const cloud = await museClient.fetchCloudMessages(false)
      if (cloud.length > 0) {
        messageHistory = cloud
        savePersistedHistory()
      }
    }
    return messageHistory
  })

  ipcMain.handle('chat:sync-messages', async () => {
    if (sessionStore.getProfile().isLoggedIn) {
      const cloud = await museClient.fetchCloudMessages(false)
      if (cloud.length > 0) {
        messageHistory = cloud
        savePersistedHistory()
        broadcastMessagesSynced()
      }
    }
    return messageHistory
  })

  ipcMain.handle('chat:clear-messages', () => {
    messageHistory = []
    unreadCount = 0
    savePersistedHistory()
    sendPetBubble(null)
    return true
  })

  ipcMain.on('chat:stop-generation', () => {
    museClient.stopActiveRequest()
    windowManager.setAvatarState('idle')
  })

  ipcMain.handle('chat:send-message', async (_event, content: string) => {
    const chatWin = windowManager.getChatWindow()
    const bubbleId = String(Date.now())

    // Record user message
    messageHistory.push({
      id: bubbleId + '-u',
      role: 'user',
      content,
      timestamp: Date.now(),
    })
    savePersistedHistory()

    // Pet enters thinking state + shows thinking speech bubble
    windowManager.setAvatarState('thinking')
    sendPetBubble({
      id: bubbleId,
      text: '正在思考...',
      status: 'thinking',
      unreadCount,
      timestamp: Date.now(),
    })

    let hasStartedTalking = false
    let runningText = ''

    await museClient.sendChatMessage(
      content,
      (chunk) => {
        if (!hasStartedTalking) {
          hasStartedTalking = true
          windowManager.setAvatarState('talking')
        }
        runningText += chunk
        if (chatWin && !chatWin.isDestroyed()) {
          chatWin.webContents.send('chat:stream-chunk', chunk)
        }
        sendPetBubble({
          id: bubbleId,
          text: runningText,
          status: 'streaming',
          unreadCount,
          timestamp: Date.now(),
        })
      },
      (fullText) => {
        windowManager.setAvatarState('idle')
        const finalContent = fullText || runningText
        if (chatWin && !chatWin.isDestroyed()) {
          chatWin.webContents.send('chat:stream-end', finalContent)
        }
        if (finalContent) {
          messageHistory.push({
            id: bubbleId + '-a',
            role: 'assistant',
            content: finalContent,
            timestamp: Date.now(),
            status: 'done',
          })
          savePersistedHistory()

          const isChatHidden = !chatWin || chatWin.isDestroyed() || !chatWin.isVisible()
          if (isChatHidden) {
            unreadCount++
          }
          sendPetBubble({
            id: bubbleId,
            text: finalContent,
            status: 'done',
            unreadCount,
            timestamp: Date.now(),
          })
        } else {
          sendPetBubble(null)
        }
      },
      (error) => {
        windowManager.setAvatarState('error')
        if (chatWin && !chatWin.isDestroyed()) {
          chatWin.webContents.send('chat:stream-error', error)
        }
        sendPetBubble({
          id: bubbleId,
          text: `通信异常: ${error}`,
          status: 'error',
          unreadCount,
          timestamp: Date.now(),
        })
        setTimeout(() => {
          if (windowManager.getAvatarState() === 'error') {
            windowManager.setAvatarState('idle')
          }
        }, 3000)
      }
    )
  })

  // Auth events
  ipcMain.handle('auth:get-status', () => {
    return sessionStore.getProfile()
  })

  ipcMain.handle('auth:open-login', async () => {
    // First check: does the persist:meta_muse session already have hatch_sess?
    // (The hidden museWindow may have it from a previous chat session.)
    try {
      const existingCookies = await extractMuseSessionCookies()
      if (existingCookies && existingCookies.includes('hatch_sess')) {
        const cached = museClient.getCachedAvatarAssets()
        const profile = {
          isLoggedIn: true,
          name: 'Meta Muse User',
          agentName: cached?.agentName,
          avatarUrl: cached?.staticImageUrl,
        }
        sessionStore.save(existingCookies, profile)
        const chatWin = windowManager.getChatWindow()
        if (chatWin && !chatWin.isDestroyed()) {
          chatWin.webContents.send('auth:status-changed', profile)
        }
        museClient.syncAvatarAssets().catch(() => {})
        console.log('[auth:open-login] Used existing session cookies (hatch_sess found).')
        return
      }
    } catch (e) {
      console.warn('[auth:open-login] Could not read existing session cookies:', e)
    }

    // Otherwise open the visible auth window
    windowManager.openAuthWindow(async (cookies) => {
      const cached = museClient.getCachedAvatarAssets()
      const profile = {
        isLoggedIn: true,
        name: 'Meta Muse User',
        agentName: cached?.agentName,
        avatarUrl: cached?.staticImageUrl,
      }
      sessionStore.save(cookies, profile)
      const chatWin = windowManager.getChatWindow()
      if (chatWin && !chatWin.isDestroyed()) {
        chatWin.webContents.send('auth:status-changed', profile)
      }
      museClient.syncAvatarAssets().catch(() => {})
    })
  })

  ipcMain.handle('auth:logout', async () => {
    sessionStore.clear()
    try {
      const ses = session.fromPartition(MUSE_PARTITION)
      await ses.clearStorageData({ storages: ['cookies'] })
    } catch (e) {
      console.warn('Failed to clear partition cookies on logout:', e)
    }
    const chatWin = windowManager.getChatWindow()
    const emptyProfile = { isLoggedIn: false }
    if (chatWin && !chatWin.isDestroyed()) {
      chatWin.webContents.send('auth:status-changed', emptyProfile)
    }
  })

  // Manual Cookie Injection
  ipcMain.handle('auth:save-manual-cookie', async (_event, cookie: string) => {
    const cached = museClient.getCachedAvatarAssets()
    const profile = {
      isLoggedIn: true,
      name: 'Meta Muse User',
      agentName: cached?.agentName,
      avatarUrl: cached?.staticImageUrl,
    }
    sessionStore.save(cookie, profile)
    const chatWin = windowManager.getChatWindow()
    if (chatWin && !chatWin.isDestroyed()) {
      chatWin.webContents.send('auth:status-changed', profile)
    }
    museClient.syncAvatarAssets().catch(() => {})
    return true
  })

  // Proxy Configuration & Network Test
  ipcMain.handle('proxy:get-config', () => {
    return proxyManager.getConfig()
  })

  ipcMain.handle('proxy:set-config', async (_event, config: ProxyConfig) => {
    return await proxyManager.setConfig(config)
  })

  ipcMain.handle('proxy:test-connection', async () => {
    return await proxyManager.testConnection()
  })

  // App quit
  ipcMain.on('app:quit', () => {
    app.quit()
  })
}
