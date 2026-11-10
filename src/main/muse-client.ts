/**
 * MuseClient — real muse.ai chat via Browser-in-Browser strategy.
 *
 * muse.ai uses Meta's "Hatch" architecture:
 *   1. HTTP bootstrap on muse.ai  (/api/hatch/lease-vm, /api/hatch/token, etc.)
 *   2. Encrypted WebSocket (Noise_XX_25519_AESGCM_SHA256 + Protobuf) to hatch.metaaivm.com
 *
 * Implementing the full Noise handshake in Node is complex, so we use an alternative
 * approach: load a hidden BrowserWindow with a persist session that already holds the
 * user's cookies (hatch_sess), navigate to muse.ai, inject JavaScript that calls the
 * page's own internal chat helpers, and relay streamed chunks back via IPC.
 *
 * This avoids TLS/JA3 fingerprinting (the browser is real Chrome) and avoids
 * reimplementing the Noise protocol.
 */
import { app, BrowserWindow, session } from 'electron'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { pathToFileURL } from 'url'
import { SessionStore } from './session-store'
import type { AvatarAssets, ChatAttachment, ChatMessage, UserProfile } from '../types'

/** Shared partition for the hidden muse.ai browser window */
export const MUSE_PARTITION = 'persist:meta_muse'

/** Extract all muse.ai cookies from the shared session (used by auth flow) */
export async function extractMuseSessionCookies(): Promise<string> {
  const ses = session.fromPartition(MUSE_PARTITION)
  const all = await ses.cookies.get({})
  const muse = all.filter(
    (c) => c.domain && (c.domain.includes('muse.ai') || c.domain.includes('meta.ai'))
  )
  return muse.map((c) => `${c.name}=${c.value}`).join('; ')
}

/** Time to wait for the muse.ai page to fully initialise before injecting chat JS (ms) */
const PAGE_READY_TIMEOUT_MS = 25_000
/** Polling interval while waiting for a chunk from the page (ms) */
const STREAM_POLL_MS = 80

export class MuseClient {
  private sessionStore: SessionStore
  private museWindow: BrowserWindow | null = null
  private aborted = false
  private activeRunId = 0
  private avatarSyncing = false
  private lastAvatarSignature: string | null = null
  private onAvatarSyncedCallbacks: Array<(assets: AvatarAssets) => void> = []
  private onCloudMessagesCallbacks: Array<(messages: ChatMessage[], newAssistantMessage?: ChatMessage) => void> = []
  private lastSeenAssistantId: string | null = null
  private lastCloudDigest: string = ''
  private cloudWatchTimer: NodeJS.Timeout | null = null
  private isSendingChat = false

  constructor(sessionStore: SessionStore) {
    this.sessionStore = sessionStore
  }

  private getMediaCacheDir(): string {
    const dir = path.join(app.getPath('userData'), 'media_cache')
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    return dir
  }

  private persistMediaAttachment(
    rawUrl: string,
    type: 'image' | 'video',
    title?: string
  ): ChatAttachment | null {
    if (!rawUrl) return null
    try {
      if (rawUrl.startsWith('data:')) {
        const commaIdx = rawUrl.indexOf(',')
        if (commaIdx < 0) return null
        const header = rawUrl.slice(0, commaIdx)
        const b64 = rawUrl.slice(commaIdx + 1)
        const hash = crypto.createHash('sha1').update(b64.slice(0, 4096) + b64.length).digest('hex').slice(0, 16)
        let ext = type === 'video' ? 'mp4' : 'webp'
        if (header.includes('image/png')) ext = 'png'
        else if (header.includes('image/jpeg')) ext = 'jpg'
        else if (header.includes('image/gif')) ext = 'gif'
        const filePath = path.join(this.getMediaCacheDir(), `${hash}.${ext}`)
        if (!fs.existsSync(filePath)) {
          fs.writeFileSync(filePath, Buffer.from(b64, 'base64'))
        }
        return {
          type,
          url: type === 'image' ? rawUrl : pathToFileURL(filePath).href,
          title,
        }
      }
      return { type, url: rawUrl, title }
    } catch {
      return { type, url: rawUrl, title }
    }
  }

  public isChatTurnActive(): boolean {
    return this.isSendingChat
  }

  public onAvatarSynced(cb: (assets: AvatarAssets) => void) {
    this.onAvatarSyncedCallbacks.push(cb)
  }

  public onCloudMessagesUpdated(
    cb: (messages: ChatMessage[], newAssistantMessage?: ChatMessage) => void
  ) {
    this.onCloudMessagesCallbacks.push(cb)
  }

  public startCloudMessageWatcher() {
    if (this.cloudWatchTimer) return
    this.cloudWatchTimer = setInterval(() => {
      if (this.isSendingChat || !this.sessionStore.getProfile().isLoggedIn) return
      this.fetchCloudMessages(true).catch(() => {})
    }, 4500)
  }

  public async fetchCloudMessages(notifyIfChanged = false): Promise<ChatMessage[]> {
    const cookies = this.sessionStore.getCookies()
    if (!cookies) return []
    try {
      const win = await this.ensureMuseWindow(cookies)
      const payload: {
        items: Array<{
          id: string
          role: 'user' | 'assistant'
          content: string
          attachments: Array<{ type: 'image' | 'video'; dataUrl: string; title?: string }>
        }>
        avatarSignature: string | null
      } = await win.webContents.executeJavaScript(`
        (async function() {
          window.__museMediaCache = window.__museMediaCache || {}
          const blobToDataUrl = async (url) => {
            if (!url) return null
            if (window.__museMediaCache[url]) return window.__museMediaCache[url]
            if (!url.startsWith('blob:')) return url
            try {
              const res = await fetch(url)
              const blob = await res.blob()
              const dataUrl = await new Promise((resolve) => {
                const reader = new FileReader()
                reader.onloadend = () => resolve(reader.result)
                reader.onerror = () => resolve(null)
                reader.readAsDataURL(blob)
              })
              if (dataUrl) window.__museMediaCache[url] = dataUrl
              return dataUrl
            } catch {
              return null
            }
          }

          const nodes = Array.from(document.querySelectorAll('[data-message-item="true"]'))
          const clean = (el) => {
            const raw = (el.innerText || '').trim()
            return raw
              .replace(/^(Copy|Copied|Edit|Retry)\\s+/i, '')
              .replace(/^(你：|Muse：|助手消息：|Assistant message:|User message:)\\s*/i, '')
              .replace(/\\n*(分享头像|Share avatar)\\s*$/i, '')
              .replace(/\\n*👍\\s*$/i, '')
              .trim()
          }

          const items = []
          for (let idx = 0; idx < nodes.length; idx++) {
            const el = nodes[idx]
            const id = el.getAttribute('data-message-id') || ('cloud-' + idx)
            const role = el.getAttribute('data-message-role') === 'user' ? 'user' : 'assistant'
            const content = clean(el)
            const attachments = []

            const imgs = Array.from(el.querySelectorAll('img'))
            for (const img of imgs) {
              const src = img.currentSrc || img.src
              if (!src) continue
              const btn = img.closest('button')
              const title = btn?.getAttribute('title') || img.alt || undefined
              const dataUrl = await blobToDataUrl(src)
              if (dataUrl) {
                attachments.push({ type: 'image', dataUrl, title })
              }
            }

            const vids = Array.from(el.querySelectorAll('video'))
            for (const vid of vids) {
              const src = vid.currentSrc || vid.src
              if (!src) continue
              const btn = vid.closest('button')
              const title = btn?.getAttribute('aria-label') || 'Avatar Motion Preview'
              const dataUrl = await blobToDataUrl(src)
              if (dataUrl) {
                attachments.push({ type: 'video', dataUrl, title })
              }
            }

            if (content.length > 0 || attachments.length > 0) {
              items.push({ id, role, content, attachments })
            }
          }

          // Inspect live stage avatar signature to detect outfit / avatar changes immediately
          const allAvatarVids = Array.from(document.querySelectorAll('video[data-hatch-avatar-layer]'))
          const stageVid =
            allAvatarVids.find(v => !v.closest('[data-message-item="true"]')) || allAvatarVids[0] || null
          let avatarSignature = null
          if (stageVid) {
            const fk = Object.keys(stageVid).find(k => k.startsWith('__reactFiber'))
            let cur = fk ? stageVid[fk] : null
            let staticBlob = ''
            let defaultBlob = stageVid.src || ''
            let workingBlob = ''
            while (cur) {
              let s = cur.memoizedState
              while (s) {
                const ms = s.memoizedState
                if (ms && typeof ms === 'object') {
                  const val = (ms.current && ms.current.value !== undefined) ? ms.current.value : ms
                  if (typeof val === 'string' && val.startsWith('blob:') && !staticBlob) {
                    staticBlob = val
                  } else if (val && typeof val === 'object' && val.default && String(val.default).startsWith('blob:')) {
                    defaultBlob = String(val.default || defaultBlob)
                    workingBlob = String(val.working || '')
                  }
                }
                s = s.next
              }
              cur = cur.return
            }
            const statusSurface = document.querySelector('[data-testid="hatch-status-panel-sliding-surface"]')
            const surfaceName = statusSurface?.innerText?.split('\\n')?.[0]?.trim() || ''
            avatarSignature = [surfaceName, staticBlob, defaultBlob, workingBlob].join('|')
          }

          return { items, avatarSignature }
        })()
      `)

      if (payload?.avatarSignature) {
        if (this.lastAvatarSignature !== payload.avatarSignature) {
          const prevSig = this.lastAvatarSignature
          this.lastAvatarSignature = payload.avatarSignature
          if (prevSig !== null || !this.getCachedAvatarAssets()) {
            this.syncAvatarAssets(true).catch(() => {})
          } else {
            // Even on first check, verify whether cached meta matches live signature
            try {
              const metaPath = path.join(this.getAvatarCacheDir(), 'meta.json')
              const meta = fs.existsSync(metaPath)
                ? JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
                : null
              if (!meta || meta.avatarSignature !== payload.avatarSignature) {
                this.syncAvatarAssets(true).catch(() => {})
              }
            } catch {
              this.syncAvatarAssets(true).catch(() => {})
            }
          }
        }
      }

      const items = payload?.items || []
      if (items.length === 0) return []

      const baseTs = Date.now() - items.length * 1000
      const cloudMessages: ChatMessage[] = items.map((item, idx) => {
        const attachments: ChatAttachment[] = []
        for (const att of item.attachments || []) {
          const saved = this.persistMediaAttachment(att.dataUrl, att.type, att.title)
          if (saved) attachments.push(saved)
        }
        const fallbackText =
          !item.content && attachments.length > 0
            ? attachments.some((a) => a.type === 'video')
              ? '[虚拟形象动作预览]'
              : '[图片]'
            : item.content
        return {
          id: item.id,
          role: item.role,
          content: fallbackText,
          attachments: attachments.length > 0 ? attachments : undefined,
          timestamp: baseTs + idx * 1000,
          status: 'done',
        }
      })

      const lastAssistant = [...cloudMessages].reverse().find((m) => m.role === 'assistant')
      let newAssistantMsg: ChatMessage | undefined
      if (lastAssistant) {
        if (this.lastSeenAssistantId && this.lastSeenAssistantId !== lastAssistant.id) {
          newAssistantMsg = lastAssistant
        }
        this.lastSeenAssistantId = lastAssistant.id
      }

      const newDigest = cloudMessages
        .map((m) => `${m.id}:${m.content.length}:${m.attachments?.length || 0}`)
        .join(',')
      const hasDigestChanged = newDigest !== this.lastCloudDigest
      this.lastCloudDigest = newDigest

      if (notifyIfChanged && (hasDigestChanged || newAssistantMsg)) {
        for (const cb of this.onCloudMessagesCallbacks) {
          cb(cloudMessages, newAssistantMsg)
        }
      }

      return cloudMessages
    } catch {
      return []
    }
  }

  private getAvatarCacheDir(): string {
    const dir = path.join(app.getPath('userData'), 'avatar_cache')
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    return dir
  }

  public getCachedAvatarAssets(): AvatarAssets | null {
    try {
      const dir = this.getAvatarCacheDir()
      const metaPath = path.join(dir, 'meta.json')
      if (!fs.existsSync(metaPath)) return null
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
      const staticPath = path.join(dir, 'avatar.webp')
      const defaultPath = path.join(dir, 'default.mp4')
      const workingPath = path.join(dir, 'working.mp4')
      const resumePath = path.join(dir, 'resume.mp4')

      const ts = meta.updatedAt || Date.now()
      const toUrl = (p: string) => (fs.existsSync(p) ? `${pathToFileURL(p).href}?v=${ts}` : undefined)

      return {
        agentName: meta.agentName || 'Muse',
        staticImageUrl: meta.staticDataUrl || toUrl(staticPath),
        videos: {
          default: toUrl(defaultPath),
          working: toUrl(workingPath) || toUrl(defaultPath),
          resume: toUrl(resumePath) || toUrl(defaultPath),
        },
        updatedAt: ts,
      }
    } catch (e) {
      console.error('Failed to read cached avatar assets:', e)
      return null
    }
  }

  private async ensureMuseWindow(cookies: string): Promise<BrowserWindow> {
    const ses = session.fromPartition(MUSE_PARTITION)
    await this.injectCookiesIntoSession(ses, cookies)

    if (!this.museWindow || this.museWindow.isDestroyed()) {
      this.museWindow = new BrowserWindow({
        width: 1280,
        height: 900,
        show: false,
        skipTaskbar: true,
        webPreferences: {
          partition: MUSE_PARTITION,
          nodeIntegration: false,
          contextIsolation: false,
          javascript: true,
          backgroundThrottling: false,
        },
      })
      this.museWindow.webContents.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
      )
    }

    const win = this.museWindow
    const currentUrl = win.webContents.getURL()
    if (!currentUrl.startsWith('https://muse.ai')) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Page load timeout')), PAGE_READY_TIMEOUT_MS)
        win.webContents.once('did-finish-load', () => {
          clearTimeout(timer)
          resolve()
        })
        win.loadURL('https://muse.ai/')
      })
    }
    return win
  }

  public async syncAvatarAssets(force = false): Promise<AvatarAssets | null> {
    const cookies = this.sessionStore.getCookies()
    if (!cookies) return this.getCachedAvatarAssets()
    if (this.avatarSyncing && !force) return this.getCachedAvatarAssets()

    this.avatarSyncing = true
    try {
      const win = await this.ensureMuseWindow(cookies)

      const extracted: {
        ok: boolean
        agentName?: string
        avatarSignature?: string
        staticB64?: string
        defaultB64?: string
        workingB64?: string
        resumeB64?: string
      } = await win.webContents.executeJavaScript(`
        (async function() {
          const start = Date.now()
          let videoEl = null
          while (Date.now() - start < 20000) {
            const allVids = Array.from(document.querySelectorAll('video[data-hatch-avatar-layer]'))
            videoEl = allVids.find(v => !v.closest('[data-message-item="true"]')) || allVids[0] || null
            if (videoEl && videoEl.src && videoEl.src.startsWith('blob:')) break
            await new Promise(r => setTimeout(r, 300))
          }
          if (!videoEl || !videoEl.src) return { ok: false }

          const fiberKey = Object.keys(videoEl).find(k => k.startsWith('__reactFiber'))
          let cur = fiberKey ? videoEl[fiberKey] : null
          let staticBlob = null
          let videoMap = {}
          while (cur) {
            let s = cur.memoizedState
            while (s) {
              const ms = s.memoizedState
              if (ms && typeof ms === 'object') {
                const val = (ms.current && ms.current.value !== undefined) ? ms.current.value : ms
                if (typeof val === 'string' && val.startsWith('blob:')) {
                  if (!staticBlob) staticBlob = val
                } else if (val && typeof val === 'object' && val.default && String(val.default).startsWith('blob:')) {
                  videoMap = val
                }
              }
              s = s.next
            }
            cur = cur.return
          }

          const blobToBase64 = async (url) => {
            if (!url) return null
            try {
              const res = await fetch(url)
              const blob = await res.blob()
              return await new Promise((resolve) => {
                const reader = new FileReader()
                reader.onloadend = () => resolve(reader.result)
                reader.onerror = () => resolve(null)
                reader.readAsDataURL(blob)
              })
            } catch {
              return null
            }
          }

          const defaultUrl = videoMap.default || videoEl.src
          const workingUrl = videoMap.working || defaultUrl
          const resumeUrl = videoMap.resume || defaultUrl

          const [staticB64, defaultB64, workingB64, resumeB64] = await Promise.all([
            blobToBase64(staticBlob),
            blobToBase64(defaultUrl),
            workingUrl !== defaultUrl ? blobToBase64(workingUrl) : Promise.resolve(null),
            resumeUrl !== defaultUrl ? blobToBase64(resumeUrl) : Promise.resolve(null),
          ])

          const statusSurface = document.querySelector('[data-testid="hatch-status-panel-sliding-surface"]')
          const surfaceName = statusSurface?.innerText?.split('\\n')?.[0]?.trim()
          const rawTitle = (document.title || '').replace(/^Chat\\s*[—-]\\s*/i, '').trim()
          const agentName =
            surfaceName ||
            (rawTitle && !rawTitle.toLowerCase().includes('muse') ? rawTitle : '') ||
            'Muse'
          const avatarSignature = [surfaceName || '', staticBlob || '', defaultUrl || '', workingUrl || ''].join('|')

          return {
            ok: true,
            agentName,
            avatarSignature,
            staticB64,
            defaultB64,
            workingB64: workingB64 || defaultB64,
            resumeB64: resumeB64 || defaultB64,
          }
        })()
      `)

      if (!extracted || !extracted.ok || !extracted.defaultB64) {
        return this.getCachedAvatarAssets()
      }

      if (extracted.avatarSignature) {
        this.lastAvatarSignature = extracted.avatarSignature
      }

      const dir = this.getAvatarCacheDir()
      const writeDataUrl = (filePath: string, dataUrl?: string) => {
        if (!dataUrl) return
        const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl
        fs.writeFileSync(filePath, Buffer.from(base64, 'base64'))
      }

      if (extracted.staticB64) {
        writeDataUrl(path.join(dir, 'avatar.webp'), extracted.staticB64)
      }
      writeDataUrl(path.join(dir, 'default.mp4'), extracted.defaultB64)
      if (extracted.workingB64) {
        writeDataUrl(path.join(dir, 'working.mp4'), extracted.workingB64)
      }
      if (extracted.resumeB64) {
        writeDataUrl(path.join(dir, 'resume.mp4'), extracted.resumeB64)
      }

      const updatedAt = Date.now()
      fs.writeFileSync(
        path.join(dir, 'meta.json'),
        JSON.stringify(
          {
            agentName: extracted.agentName || 'Muse',
            avatarSignature: extracted.avatarSignature || undefined,
            staticDataUrl: extracted.staticB64 || undefined,
            updatedAt,
          },
          null,
          2
        ),
        'utf-8'
      )

      // Update SessionStore profile with agentName and avatarUrl
      const curProfile = this.sessionStore.getProfile()
      if (curProfile.isLoggedIn) {
        this.sessionStore.save(this.sessionStore.getCookies(), {
          ...curProfile,
          agentName: extracted.agentName || curProfile.agentName || 'Muse',
          avatarUrl: extracted.staticB64 || curProfile.avatarUrl,
        })
      }

      const assets = this.getCachedAvatarAssets()
      if (assets) {
        for (const cb of this.onAvatarSyncedCallbacks) {
          cb(assets)
        }
      }
      return assets
    } catch (err) {
      console.error('syncAvatarAssets error:', err)
      return this.getCachedAvatarAssets()
    } finally {
      this.avatarSyncing = false
    }
  }

  public stopActiveRequest() {
    this.aborted = true
    // We'll check the flag in the streaming loop; nothing to abort from outside the page.
  }

  // ---------------------------------------------------------------------------
  // Profile
  // ---------------------------------------------------------------------------

  public async fetchProfile(): Promise<UserProfile> {
    const cookies = this.sessionStore.getCookies()
    if (!cookies) return { isLoggedIn: false }

    // Check whether we can reach the muse.ai homepage with the stored cookies.
    // If /api/hatch/lease-vm or similar returns 200 we're logged in.
    try {
      const ses = session.fromPartition('persist:meta_muse')
      // Inject the saved cookies into the session so the hidden window can use them.
      await this.injectCookiesIntoSession(ses, cookies)

      // Try a simple authenticated call to confirm login status.
      const resp = await ses.fetch('https://muse.ai/', {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
          Accept: 'text/html,*/*;q=0.8',
        },
      })
      if (resp.ok) {
        return this.sessionStore.getProfile()
      }
    } catch (e) {
      console.error('fetchProfile error:', e)
    }
    return this.sessionStore.getProfile()
  }

  // ---------------------------------------------------------------------------
  // Chat via hidden BrowserWindow
  // ---------------------------------------------------------------------------

  public async sendChatMessage(
    content: string,
    onChunk: (chunk: string) => void,
    onEnd: (fullText: string) => void,
    onError: (err: string) => void
  ) {
    this.aborted = false
    this.isSendingChat = true
    const cookies = this.sessionStore.getCookies()

    try {
      if (!cookies) {
        // No auth — fall back to local companion replies
        return await this.runCompanionReply(content, onChunk, onEnd)
      }

      try {
        await this.sendViaMuseWindow(content, cookies, onChunk, onEnd, onError)
        // Sync cloud messages & attachments + detect any avatar change after our own turn finishes
        await this.fetchCloudMessages(true)
      } catch (err: any) {
        if (this.aborted) {
          onEnd('')
          return
        }
        console.error('MuseClient sendChatMessage error, falling back to companion:', err)
        // Fall back to companion reply on any hard error
        return await this.runCompanionReply(content, onChunk, onEnd)
      }
    } finally {
      this.isSendingChat = false
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: BrowserWindow-based chat relay
  // ---------------------------------------------------------------------------

  private async sendViaMuseWindow(
    content: string,
    cookies: string,
    onChunk: (chunk: string) => void,
    onEnd: (fullText: string) => void,
    onError: (err: string) => void
  ) {
    const win = await this.ensureMuseWindow(cookies)
    if (!this.getCachedAvatarAssets()) {
      this.syncAvatarAssets().catch(() => {})
    }

    // Wait for composer textarea AND initial chat history to finish mounting
    const composerReady = await win.webContents.executeJavaScript(`
      (async function() {
        const start = Date.now()
        while (Date.now() - start < 20000) {
          const ta = document.querySelector('textarea')
          const col = document.querySelector('[data-hatch-chat-column="true"], [role="log"]')
          const motionDone = !col || col.getAttribute('data-initial-history-motion') === 'complete'
          const hasMsgs = document.querySelectorAll('[data-message-item="true"]').length > 0
          if (ta && (hasMsgs || (col && motionDone))) {
            return { ok: true, href: location.href }
          }
          if (location.href.includes('auth.muse.ai') || location.pathname.includes('login')) {
            return { ok: false, reason: 'not_logged_in', href: location.href }
          }
          await new Promise(r => setTimeout(r, 250))
        }
        // If textarea exists even without messages (e.g. brand new thread), proceed
        if (document.querySelector('textarea')) {
          return { ok: true, href: location.href }
        }
        return { ok: false, reason: 'composer_timeout', href: location.href }
      })()
    `)

    if (!composerReady || !composerReady.ok) {
      throw new Error(
        composerReady?.reason === 'not_logged_in'
          ? '登录状态已失效，请重新登录 Meta Muse'
          : '等待 Muse 页面加载超时'
      )
    }

    const runId = ++this.activeRunId
    // Inject script to submit message via React composer and stream back assistant reply
    const injectAndStream = `
      (function() {
        const myRunId = ${runId}
        window.__museActiveRunId = myRunId
        window.__museStreamBuf = []
        window.__museStreamDone = false
        window.__museStreamError = null

        async function runChat() {
          try {
            const textArea = document.querySelector('textarea')
            if (!textArea) {
              if (window.__museActiveRunId === myRunId) {
                window.__museStreamError = '未找到输入框'
                window.__museStreamDone = true
              }
              return
            }

            // Record existing message IDs and their current roles before sending
            const existingAll = Array.from(document.querySelectorAll('[data-message-item="true"]'))
            const beforeIds = new Set(existingAll.map(el => el.getAttribute('data-message-id')))
            const beforeUserIds = new Set(
              existingAll
                .filter(el => el.getAttribute('data-message-role') === 'user')
                .map(el => el.getAttribute('data-message-id'))
            )
            const beforeAssistantIds = new Set(
              existingAll
                .filter(el => el.getAttribute('data-message-role') === 'assistant')
                .map(el => el.getAttribute('data-message-id'))
            )

            // Set value via native setter and invoke React's onChange prop directly
            const nativeSetter = Object.getOwnPropertyDescriptor(
              window.HTMLTextAreaElement.prototype,
              'value'
            )?.set
            if (nativeSetter) {
              nativeSetter.call(textArea, ${JSON.stringify(content)})
            } else {
              textArea.value = ${JSON.stringify(content)}
            }

            const propsKey = Object.keys(textArea).find(k => k.startsWith('__reactProps'))
            if (propsKey && textArea[propsKey] && typeof textArea[propsKey].onChange === 'function') {
              textArea[propsKey].onChange({ target: textArea, currentTarget: textArea })
            } else {
              textArea.dispatchEvent(new Event('input', { bubbles: true }))
            }

            // Wait briefly for React to render the send button in the action slot
            await new Promise(r => setTimeout(r, 150))
            if (window.__museActiveRunId !== myRunId) return

            const sendBtn =
              document.querySelector('[data-pel-click="chat_send_message"]') ||
              document.querySelector('[data-hatch-composer-action="send"] button')

            if (sendBtn && !sendBtn.disabled) {
              sendBtn.click()
            } else if (propsKey && textArea[propsKey] && typeof textArea[propsKey].onKeyDown === 'function') {
              textArea[propsKey].onKeyDown({
                key: 'Enter',
                code: 'Enter',
                keyCode: 13,
                shiftKey: false,
                ctrlKey: false,
                altKey: false,
                metaKey: false,
                repeat: false,
                preventDefault: () => {},
                nativeEvent: new KeyboardEvent('keydown', { key: 'Enter' }),
                currentTarget: textArea,
                target: textArea,
              })
            } else {
              if (window.__museActiveRunId === myRunId) {
                window.__museStreamError = '无法触发发送按钮'
                window.__museStreamDone = true
              }
              return
            }

            // Monitor DOM for new assistant message(s) that appear AFTER our new user message
            let prev = ''
            let stableCount = 0
            let anchorUserId = null
            const start = Date.now()

            const extractCleanText = (el) => {
              const raw = (el.innerText || '').trim()
              const cleaned = raw
                .replace(/^(Copy|Copied|Edit|Retry)\\s+/i, '')
                .replace(/^(你：|Muse：|助手消息：|Assistant message:\\s*)/i, '')
                .replace(/\\n*(分享头像|Share avatar)\\s*$/i, '')
                .replace(/\\n*👍\\s*$/i, '')
                .trim()
              if (cleaned) return cleaned
              if (el.querySelector('video')) return '[虚拟形象动作预览]'
              if (el.querySelector('img')) return '[图片生成完毕]'
              return ''
            }

            while (Date.now() - start < 75000 && window.__museActiveRunId === myRunId) {
              await new Promise(r => setTimeout(r, 150))
              if (window.__museActiveRunId !== myRunId) return

              const allItems = Array.from(document.querySelectorAll('[data-message-item="true"]'))

              // Find the newly added user message ID as our anchor
              if (!anchorUserId) {
                for (let i = allItems.length - 1; i >= 0; i--) {
                  const el = allItems[i]
                  const id = el.getAttribute('data-message-id')
                  const role = el.getAttribute('data-message-role')
                  if (role === 'user' && id && !beforeUserIds.has(id)) {
                    anchorUserId = id
                    break
                  }
                }
              }

              const anchorUserEl = anchorUserId
                ? allItems.find(el => el.getAttribute('data-message-id') === anchorUserId)
                : null

              // Check if the user message failed delivery ("未确认送达" / "Not delivered")
              if (anchorUserEl && (Date.now() - start > 15000)) {
                const userText = anchorUserEl.innerText || ''
                if (userText.includes('未确认送达') || userText.includes('Not delivered')) {
                  window.__museStreamError = '消息发送至 Meta Muse 未确认送达，请稍后重试'
                  window.__museStreamDone = true
                  return
                }
              }

              let newItems = []
              if (anchorUserEl) {
                const anchorIdx = allItems.indexOf(anchorUserEl)
                if (anchorIdx >= 0) {
                  newItems = allItems
                    .slice(anchorIdx + 1)
                    .filter(el => el.getAttribute('data-message-role') === 'assistant')
                }
              } else {
                newItems = allItems.filter(
                  el =>
                    el.getAttribute('data-message-role') === 'assistant' &&
                    !beforeAssistantIds.has(el.getAttribute('data-message-id')) &&
                    !beforeIds.has(el.getAttribute('data-message-id'))
                )
              }

              const cur = newItems.map(extractCleanText).filter(Boolean).join('\\n\\n')
              const anyBusy = newItems.some(
                el => el.querySelector('[aria-busy]')?.getAttribute('aria-busy') === 'true'
              )
              const actionState = document
                .querySelector('[data-hatch-composer-action-slot] [data-hatch-composer-action]')
                ?.getAttribute('data-hatch-composer-action')

              if (cur.length > prev.length && cur.startsWith(prev)) {
                const delta = cur.slice(prev.length)
                if (delta) window.__museStreamBuf.push(delta)
                prev = cur
                stableCount = 0
              } else if (cur !== prev && cur.length > 0) {
                if (cur.length > prev.length) {
                  window.__museStreamBuf.push(cur.slice(prev.length))
                }
                prev = cur
                stableCount = 0
              } else if (prev.length > 0) {
                stableCount++
                if (!anyBusy && actionState !== 'stop' && stableCount >= 4) {
                  break
                }
                if (stableCount >= 25) {
                  break
                }
              }
            }

            if (window.__museActiveRunId === myRunId) {
              window.__museStreamDone = true
            }
          } catch (err) {
            if (window.__museActiveRunId === myRunId) {
              window.__museStreamError = String(err)
              window.__museStreamDone = true
            }
          }
        }

        runChat()
        return 'injected'
      })()
    `

    const injectResult = await win.webContents.executeJavaScript(injectAndStream)
    if (injectResult !== 'injected') {
      throw new Error('Injection failed: ' + injectResult)
    }

    // Poll for chunks
    let fullText = ''
    const deadline = Date.now() + 90_000

    while (Date.now() < deadline && !this.aborted && this.activeRunId === runId) {
      await sleep(STREAM_POLL_MS)

      const result: { buf: string[]; done: boolean; error: string | null } =
        await win.webContents.executeJavaScript(`
        (function() {
          if (window.__museActiveRunId !== ${runId}) {
            return { buf: [], done: true, error: null }
          }
          const buf = (window.__museStreamBuf || []).slice()
          window.__museStreamBuf = []
          return { buf, done: !!window.__museStreamDone, error: window.__museStreamError || null }
        })()
      `)

      for (const chunk of result.buf) {
        fullText += chunk
        onChunk(chunk)
      }

      if (result.error) {
        onError(result.error)
        return
      }
      if (result.done) break
    }

    if (this.aborted) {
      onEnd(fullText)
      return
    }
    if (Date.now() >= deadline) {
      onError('响应超时，请重试')
      return
    }
    onEnd(fullText)
  }

  // ---------------------------------------------------------------------------
  // Cookie injection helper
  // ---------------------------------------------------------------------------

  private async injectCookiesIntoSession(ses: Electron.Session, cookieString: string) {
    // Parse "name=value; name2=value2; ..." and set each cookie for muse.ai
    const pairs = cookieString.split(';').map((s) => s.trim()).filter(Boolean)
    for (const pair of pairs) {
      const eqIdx = pair.indexOf('=')
      if (eqIdx < 0) continue
      const name = pair.slice(0, eqIdx).trim()
      const value = pair.slice(eqIdx + 1).trim()
      try {
        await ses.cookies.set({
          url: 'https://muse.ai',
          name,
          value,
          domain: '.muse.ai',
          path: '/',
          secure: true,
          httpOnly: false,
        })
      } catch {
        // some cookies may fail (httpOnly, etc.) — ignore
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Companion (offline / unauthenticated fallback)
  // ---------------------------------------------------------------------------

  private async runCompanionReply(
    content: string,
    onChunk: (chunk: string) => void,
    onEnd: (fullText: string) => void
  ) {
    const reply = this.generateCompanionReply(content)
    let current = ''
    for (const char of reply) {
      if (this.aborted) {
        onEnd(current)
        return
      }
      await sleep(35)
      current += char
      onChunk(char)
    }
    onEnd(current)
  }

  private generateCompanionReply(prompt: string): string {
    const lower = prompt.toLowerCase()
    if (lower.includes('你好') || lower.includes('hi') || lower.includes('hello')) {
      return `你好呀！我是陪伴在你 Windows 桌面的 Muse Pet。我可以随时协助你解答问题、构思创意或辅助办公。点击右上角"登录 Meta"可直接同步你在 muse.ai 上的真实会话与个人形象！`
    }
    if (lower.includes('谁') || lower.includes('介绍')) {
      return `我是专为 Windows 用户定制的 Muse 桌面伴侣客户端。Meta Muse 目前仅支持 Mac 和 Web 端，通过我，你可以在 Windows 桌面上拥有专属悬浮宠物，随时按 Alt+Space 呼出快速对话。`
    }
    if (lower.includes('快捷键') || lower.includes('功能')) {
      return `你可以按【Alt + Space】随时呼出或隐藏我的对话面板；按住我可以在屏幕任意角落拖拽放置；在托盘图标右键菜单中还可以设置开机自启和窗口置顶。`
    }
    return `我收到了你的想法："${prompt}"。\n\n桌面常驻伴侣正在持续守候中！登录你的 Meta 账号后，我将直接打通 Meta Muse 云端大脑，为你执行深度的智能体任务与连续会话。`
  }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}
