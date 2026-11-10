import { BrowserWindow, screen, app, session } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import type { AvatarState, WindowBounds } from '../types'
import { MUSE_PARTITION } from './muse-client'

export class WindowManager {
  private petWindow: BrowserWindow | null = null
  private chatWindow: BrowserWindow | null = null
  private authWindow: BrowserWindow | null = null
  private currentAvatarState: AvatarState = 'idle'
  private stateFilePath: string
  private chatBoundsFilePath: string
  private hasCustomChatPosition = false
  private chatWindowReady = false

  constructor() {
    this.stateFilePath = path.join(app.getPath('userData'), 'pet_position.json')
    this.chatBoundsFilePath = path.join(app.getPath('userData'), 'chat_bounds.json')
  }

  private loadSavedChatBounds(): Partial<WindowBounds> | null {
    try {
      if (fs.existsSync(this.chatBoundsFilePath)) {
        const raw = fs.readFileSync(this.chatBoundsFilePath, 'utf-8')
        return JSON.parse(raw)
      }
    } catch {
      // ignore
    }
    return null
  }

  private saveChatBounds(bounds: WindowBounds) {
    try {
      fs.writeFileSync(this.chatBoundsFilePath, JSON.stringify(bounds))
    } catch {
      // ignore
    }
  }

  private loadSavedPosition(): { x: number; y: number } | null {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const raw = fs.readFileSync(this.stateFilePath, 'utf-8')
        return JSON.parse(raw)
      }
    } catch {
      // ignore
    }
    return null
  }

  private savePosition(x: number, y: number) {
    try {
      fs.writeFileSync(this.stateFilePath, JSON.stringify({ x, y }))
    } catch {
      // ignore
    }
  }

  public getPetWindow() {
    return this.petWindow
  }

  public getChatWindow() {
    return this.chatWindow
  }

  public getAvatarState(): AvatarState {
    return this.currentAvatarState
  }

  public setAvatarState(state: AvatarState) {
    this.currentAvatarState = state
    if (this.petWindow && !this.petWindow.isDestroyed()) {
      this.petWindow.webContents.send('avatar:sync-state', state)
    }
  }

  public createPetWindow(): BrowserWindow {
    if (this.petWindow && !this.petWindow.isDestroyed()) {
      return this.petWindow
    }

    const primaryDisplay = screen.getPrimaryDisplay()
    const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize

    const windowWidth = 300
    const windowHeight = 420
    const defaultX = screenWidth - windowWidth - 20
    const defaultY = screenHeight - windowHeight - 20

    const savedPos = this.loadSavedPosition()
    let initialX = defaultX
    let initialY = defaultY

    if (savedPos && savedPos.x >= 0 && savedPos.x < screenWidth && savedPos.y >= 0 && savedPos.y < screenHeight) {
      initialX = Math.min(savedPos.x, screenWidth - windowWidth - 10)
      initialY = Math.min(savedPos.y, screenHeight - windowHeight - 10)
    }

    const petPreload = path.join(__dirname, '../preload/pet.js')

    this.petWindow = new BrowserWindow({
      width: windowWidth,
      height: windowHeight,
      x: initialX,
      y: initialY,
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      hasShadow: false,
      webPreferences: {
        preload: petPreload,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: false,
      },
    })

    this.petWindow.on('moved', () => {
      if (this.petWindow && !this.petWindow.isDestroyed()) {
        const [x, y] = this.petWindow.getPosition()
        this.savePosition(x, y)
      }
    })

    // Default to click-through with mousemove forwarding so transparent areas around the pet
    // and empty bubble space above never block clicks on underlying desktop/windows.
    this.petWindow.setIgnoreMouseEvents(true, { forward: true })

    // Load URL
    if (process.env.VITE_DEV_SERVER_URL) {
      this.petWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}pet.html`)
    } else {
      this.petWindow.loadFile(path.join(__dirname, '../../dist/pet.html'))
    }

    this.petWindow.on('closed', () => {
      this.petWindow = null
    })

    return this.petWindow
  }

  public createChatWindow(): BrowserWindow {
    if (this.chatWindow && !this.chatWindow.isDestroyed()) {
      return this.chatWindow
    }

    const chatPreload = path.join(__dirname, '../preload/chat.js')
    const savedBounds = this.loadSavedChatBounds()
    const primaryDisplay = screen.getPrimaryDisplay()
    const { width: screenW, height: screenH } = primaryDisplay.workAreaSize

    const initW = Math.min(screenW - 24, Math.max(460, savedBounds?.width || 640))
    const initH = Math.min(screenH - 24, Math.max(380, savedBounds?.height || 560))

    const hasValidSavedPos =
      savedBounds &&
      typeof savedBounds.x === 'number' &&
      typeof savedBounds.y === 'number' &&
      savedBounds.x >= -100 &&
      savedBounds.x < screenW - 80 &&
      savedBounds.y >= 0 &&
      savedBounds.y < screenH - 80

    const initX = hasValidSavedPos
      ? savedBounds!.x!
      : Math.max(16, Math.round((screenW - initW) / 2))
    const initY = hasValidSavedPos
      ? savedBounds!.y!
      : Math.max(24, Math.min(screenH - initH - 24, Math.round(screenH * 0.16)))

    this.hasCustomChatPosition = Boolean(hasValidSavedPos)
    this.chatWindowReady = false

    this.chatWindow = new BrowserWindow({
      x: initX,
      y: initY,
      width: initW,
      height: initH,
      minWidth: 460,
      minHeight: 380,
      maxWidth: screenW,
      maxHeight: screenH,
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      show: false,
      paintWhenInitiallyHidden: true,
      backgroundColor: '#00000000',
      skipTaskbar: false,
      resizable: true,
      hasShadow: false,
      webPreferences: {
        preload: chatPreload,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: false,
        backgroundThrottling: false,
      },
    })

    this.chatWindow.once('ready-to-show', () => {
      this.chatWindowReady = true
    })
    this.chatWindow.webContents.once('did-finish-load', () => {
      this.chatWindowReady = true
    })

    const notifyBoundsChanged = () => {
      if (this.chatWindow && !this.chatWindow.isDestroyed()) {
        const b = this.chatWindow.getBounds()
        this.saveChatBounds(b)
        this.chatWindow.webContents.send('chat:bounds-changed', b)
      }
    }

    this.chatWindow.on('resized', notifyBoundsChanged)
    this.chatWindow.on('moved', () => {
      this.hasCustomChatPosition = true
      notifyBoundsChanged()
    })

    if (process.env.VITE_DEV_SERVER_URL) {
      this.chatWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}chat.html`)
    } else {
      this.chatWindow.loadFile(path.join(__dirname, '../../dist/chat.html'))
    }

    this.chatWindow.on('blur', () => {
      // Auto-hide when losing focus (optional, or kept open)
    })

    this.chatWindow.on('closed', () => {
      this.chatWindow = null
      this.chatWindowReady = false
    })

    return this.chatWindow
  }

  public toggleChatWindow() {
    if (!this.chatWindow || this.chatWindow.isDestroyed()) {
      this.createChatWindow()
    }

    if (!this.chatWindow) return

    if (this.chatWindow.isVisible()) {
      this.chatWindow.hide()
      if (this.currentAvatarState === 'listening') {
        this.setAvatarState('idle')
      }
    } else {
      const revealWindow = () => {
        if (!this.chatWindow || this.chatWindow.isDestroyed()) return
        if (!this.hasCustomChatPosition) {
          this.positionChatNearPet()
        }
        this.chatWindow.show()
        this.chatWindow.focus()
        if (this.currentAvatarState === 'idle') {
          this.setAvatarState('listening')
        }
      }

      if (this.chatWindowReady || !this.chatWindow.webContents.isLoading()) {
        revealWindow()
      } else {
        this.chatWindow.once('ready-to-show', revealWindow)
      }
    }
  }

  public getChatBounds(): WindowBounds {
    if (!this.chatWindow || this.chatWindow.isDestroyed()) {
      return { x: 0, y: 0, width: 640, height: 560 }
    }
    return this.chatWindow.getBounds()
  }

  public setChatBounds(partial: Partial<WindowBounds>): WindowBounds {
    if (!this.chatWindow || this.chatWindow.isDestroyed()) {
      return { x: 0, y: 0, width: 640, height: 560 }
    }
    const primaryDisplay = screen.getPrimaryDisplay()
    const { width: screenW, height: screenH } = primaryDisplay.workAreaSize
    const cur = this.chatWindow.getBounds()
    const next: WindowBounds = {
      x: typeof partial.x === 'number' ? Math.round(partial.x) : cur.x,
      y: typeof partial.y === 'number' ? Math.round(partial.y) : cur.y,
      width:
        typeof partial.width === 'number'
          ? Math.min(screenW, Math.max(460, Math.round(partial.width)))
          : cur.width,
      height:
        typeof partial.height === 'number'
          ? Math.min(screenH, Math.max(380, Math.round(partial.height)))
          : cur.height,
    }
    if (typeof partial.x === 'number' || typeof partial.y === 'number') {
      this.hasCustomChatPosition = true
    }
    this.chatWindow.setBounds(next)
    this.saveChatBounds(next)
    this.chatWindow.webContents.send('chat:bounds-changed', next)
    return next
  }

  public resetChatBounds(): WindowBounds {
    if (!this.chatWindow || this.chatWindow.isDestroyed()) {
      return { x: 0, y: 0, width: 640, height: 560 }
    }
    this.hasCustomChatPosition = false
    this.chatWindow.setSize(640, 560)
    this.positionChatNearPet()
    const b = this.chatWindow.getBounds()
    this.saveChatBounds(b)
    this.chatWindow.webContents.send('chat:bounds-changed', b)
    return b
  }

  public hideChatWindow() {
    if (this.chatWindow && !this.chatWindow.isDestroyed() && this.chatWindow.isVisible()) {
      this.chatWindow.hide()
      if (this.currentAvatarState === 'listening') {
        this.setAvatarState('idle')
      }
    }
  }

  public positionChatNearPet() {
    if (!this.chatWindow) return

    const [chatW, chatH] = this.chatWindow.getSize()
    const primaryDisplay = screen.getPrimaryDisplay()
    const { width: screenW, height: screenH } = primaryDisplay.workAreaSize

    // macOS Spotlight / Quake Terminal style: horizontally centered, upper-third (~16% from top)
    const targetX = Math.max(16, Math.round((screenW - chatW) / 2))
    const targetY = Math.max(24, Math.min(screenH - chatH - 24, Math.round(screenH * 0.16)))

    const [curX, curY] = this.chatWindow.getPosition()
    if (curX !== targetX || curY !== targetY) {
      this.chatWindow.setPosition(targetX, targetY)
    }
  }

  public openAuthWindow(onSuccess: (cookies: string) => void) {
    const ses = session.fromPartition(MUSE_PARTITION)
    // The hidden museWindow (MuseClient) uses the same partition, so if the user
    // already browsed muse.ai there, we may have hatch_sess without asking again.
    ses.cookies.get({ domain: 'muse.ai' }).then((existing) => {
      const existingStr = existing.map((c) => `${c.name}=${c.value}`).join('; ')
      if (existingStr && existingStr.includes('hatch_sess')) {
        console.log('[AuthWindow] Session already has hatch_sess, calling onSuccess directly.')
        onSuccess(existingStr)
        return
      }
      // Need to open the visible login window
      this.openVisibleAuthWindow(ses, onSuccess)
    }).catch(() => {
      this.openVisibleAuthWindow(ses, onSuccess)
    })
  }

  private openVisibleAuthWindow(ses: Electron.Session, onSuccess: (cookies: string) => void) {
    if (this.authWindow && !this.authWindow.isDestroyed()) {
      this.authWindow.focus()
      return
    }

    // Use a real Chrome UA — muse.ai / auth.muse.ai block Electron UA
    const chromeUA =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

    this.authWindow = new BrowserWindow({
      width: 700,
      height: 780,
      title: 'Meta Muse 登录',
      autoHideMenuBar: true,
      backgroundColor: '#0f172a',
      webPreferences: {
        partition: MUSE_PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
      },
    })

    this.authWindow.webContents.setUserAgent(chromeUA)

    // Poll cookies after every navigation — covers redirect chains
    const checkCookies = async () => {
      try {
        const allCookies = await ses.cookies.get({})
        const muse = allCookies.filter(
          (c) => c.domain && (c.domain.includes('muse.ai') || c.domain.includes('meta.ai'))
        )
        const str = muse.map((c) => `${c.name}=${c.value}`).join('; ')
        // hatch_sess is the definitive muse.ai auth cookie
        if (str && str.includes('hatch_sess')) {
          console.log('[AuthWindow] Got muse.ai auth cookies:', muse.map((c) => c.name).join(', '))
          onSuccess(str)
          if (this.authWindow && !this.authWindow.isDestroyed()) {
            this.authWindow.close()
          }
        }
      } catch (e) {
        console.error('[AuthWindow] Cookie check error:', e)
      }
    }

    // Fire on every completed network request to muse.ai / meta.ai
    ses.webRequest.onCompleted(
      { urls: ['*://*.muse.ai/*', '*://*.meta.ai/*', '*://*.meta.com/*', '*://*.facebook.com/*'] },
      () => { checkCookies() }
    )

    // Also fire on each navigation finish (catches SPA routing)
    this.authWindow.webContents.on('did-navigate', () => { checkCookies() })
    this.authWindow.webContents.on('did-navigate-in-page', () => { checkCookies() })

    // Show a friendly error page on hard load failures (DNS/proxy)
    this.authWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      if (errorCode === -3) return // redirect / abort, not an error

      const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
        <style>
          body{background:#090d16;color:#f1f5f9;font-family:system-ui,sans-serif;
               display:flex;align-items:center;justify-content:center;
               height:100vh;margin:0;padding:24px;box-sizing:border-box;text-align:center}
          .card{max-width:460px;background:rgba(30,41,59,.7);border:1px solid rgba(255,255,255,.1);
                padding:32px 28px;border-radius:16px}
          .badge{display:inline-block;background:rgba(239,68,68,.2);border:1px solid rgba(239,68,68,.4);
                 color:#f87171;padding:4px 12px;border-radius:9999px;font-size:12px;margin-bottom:16px}
          h2{margin:0 0 12px;font-size:20px;font-weight:600;color:#fff}
          p{margin:0 0 20px;font-size:13px;line-height:1.6;color:#94a3b8}
          .hint{background:rgba(255,255,255,.05);padding:10px 14px;border-radius:8px;
                font-size:12px;color:#cbd5e1;text-align:left;margin-bottom:24px}
          .btn{background:#3b82f6;color:#fff;border:none;padding:10px 24px;
               border-radius:8px;font-size:14px;font-weight:500;cursor:pointer}
          .btn:hover{background:#2563eb}
        </style></head><body>
        <div class="card">
          <span class="badge">加载失败 (${errorCode})</span>
          <h2>无法访问 Meta Muse 登录页</h2>
          <p>${errorDescription}<br><small style="color:#64748b">${validatedURL}</small></p>
          <div class="hint"><strong>💡 建议：</strong><br>
            1. 需开启代理（Clash / v2rayN）访问 Meta。<br>
            2. 在聊天面板「设置」中切换代理模式或填入端口。<br>
            3. 或在设置中选择「手动录入 Cookie」直接绑定。
          </div>
          <button class="btn" onclick="location.reload()">重试</button>
        </div></body></html>`
      this.authWindow?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    })

    // muse.ai redirects from / to auth.muse.ai/aymh/ — that page handles Meta login
    // Loading it directly with the correct UA avoids the extra redirect round-trip
    this.authWindow.loadURL('https://muse.ai/')

    this.authWindow.on('closed', () => {
      this.authWindow = null
    })
  }
}
