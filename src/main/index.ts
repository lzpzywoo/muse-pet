import { app, globalShortcut, BrowserWindow } from 'electron'
import { WindowManager } from './window-manager'
import { SessionStore } from './session-store'
import { MuseClient, extractMuseSessionCookies } from './muse-client'
import { TrayManager } from './tray'
import { ProxyManager } from './proxy-manager'
import { registerIpcHandlers } from './ipc-handlers'

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  const windowManager = new WindowManager()
  const sessionStore = new SessionStore()
  const museClient = new MuseClient(sessionStore)
  const trayManager = new TrayManager(windowManager)
  const proxyManager = new ProxyManager()

  app.on('second-instance', () => {
    // Focus or show chat when a second instance tries to launch
    windowManager.toggleChatWindow()
  })

  app.whenReady().then(async () => {
    // Load encrypted session now that safeStorage is available after app.whenReady()
    sessionStore.init()
    if (!sessionStore.getProfile().isLoggedIn) {
      try {
        const existingCookies = await extractMuseSessionCookies()
        if (existingCookies && existingCookies.includes('hatch_sess')) {
          sessionStore.save(existingCookies, { isLoggedIn: true, name: 'Meta Muse User' })
        }
      } catch (e) {
        console.warn('Could not restore cookies from partition on startup:', e)
      }
    }

    // Apply proxy settings at startup (defaults to system proxy)
    await proxyManager.apply()

    // Register IPC channels
    registerIpcHandlers(windowManager, museClient, sessionStore, proxyManager)

    // Create windows
    windowManager.createPetWindow()
    windowManager.createChatWindow()

    // Sync avatar assets in background if logged in
    if (sessionStore.getProfile().isLoggedIn) {
      const cached = museClient.getCachedAvatarAssets()
      if (cached) {
        const cur = sessionStore.getProfile()
        if (!cur.avatarUrl || !cur.agentName) {
          sessionStore.save(sessionStore.getCookies(), {
            ...cur,
            agentName: cached.agentName || cur.agentName,
            avatarUrl: cached.staticImageUrl || cur.avatarUrl,
          })
        }
      }
      museClient.syncAvatarAssets().catch(() => {})
    }

    // Initialize tray
    trayManager.init()

    // Register global shortcut: Alt+Space, fallback to Ctrl+Shift+M
    let registered = globalShortcut.register('Alt+Space', () => {
      windowManager.toggleChatWindow()
    })

    if (!registered) {
      console.warn('Alt+Space is already registered by another tool, trying Ctrl+Shift+M...')
      registered = globalShortcut.register('CommandOrControl+Shift+M', () => {
        windowManager.toggleChatWindow()
      })
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        windowManager.createPetWindow()
        windowManager.createChatWindow()
      }
    })
  })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    trayManager.destroy()
  })

  // Prevent app from quitting when all windows are closed (runs in background tray)
  app.on('window-all-closed', () => {
    // Keep app alive in tray
  })
}
