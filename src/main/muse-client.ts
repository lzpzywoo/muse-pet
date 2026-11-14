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
import { pcAccount, PcReportNotSubmitted, type PcObservation } from './pc-status-bridge'
import type {
  AvatarAssets,
  ChatAttachment,
  ChatMessage,
  CloudBrowserMessage,
  OpenCloudBrowserResult,
  MuseCloudBrowserStatus,
  MuseCloudConsoleTarget,
  MuseCloudSnapshot,
  UserProfile,
} from '../types'

/** Shared partition for the hidden muse.ai browser window */
export const MUSE_PARTITION = 'persist:meta_muse'

/** Isolation stylesheet id — only injected into the dedicated cloud-browser window */
const CLOUD_BROWSER_ISOLATION_STYLE_ID = 'muse-pet-cloud-browser-isolation'

/** Isolation CSS: strip Muse chrome/overlays; keep only the official browser panel */
const CLOUD_BROWSER_ISOLATION_CSS = `
html, body {
  margin: 0 !important;
  padding: 0 !important;
  overflow: hidden !important;
  background: #0b0d12 !important;
}
body * {
  visibility: hidden !important;
  pointer-events: none !important;
}
[data-testid="browser-session-side-panel"],
[data-testid="browser-session-side-panel"] * {
  visibility: visible !important;
  pointer-events: auto !important;
}
[data-testid="browser-session-side-panel"] {
  position: fixed !important;
  inset: 0 !important;
  width: 100vw !important;
  height: 100vh !important;
  max-width: none !important;
  max-height: none !important;
  margin: 0 !important;
  border: none !important;
  border-radius: 0 !important;
  box-shadow: none !important;
  outline: none !important;
  z-index: 2147483646 !important;
  background: #0b0d12 !important;
}
/* Invite / marketing / modal chrome — always hidden in dedicated browser window */
[role="dialog"],
[role="alertdialog"],
[aria-modal="true"],
[data-testid*="invite" i],
[data-testid*="upsell" i],
[data-testid*="referral" i],
[data-pel-click*="invite" i] {
  display: none !important;
  visibility: hidden !important;
  pointer-events: none !important;
  opacity: 0 !important;
}
`.trim()

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
  /** Dedicated native cloud-browser surface; never replaces the sync museWindow */
  private cloudBrowserWindow: BrowserWindow | null = null
  private aborted = false
  private activeRunId = 0
  private avatarSyncing = false
  private lastAvatarSignature: string | null = null
  private onAvatarSyncedCallbacks: Array<(assets: AvatarAssets) => void> = []
  private onCloudMessagesCallbacks: Array<(messages: ChatMessage[], newAssistantMessage?: ChatMessage) => void> = []
  private onCloudBrowserStatusCallbacks: Array<(status: MuseCloudBrowserStatus) => void> = []
  private lastSeenAssistantId: string | null = null
  private lastCloudDigest: string = ''
  private cloudWatchTimer: NodeJS.Timeout | null = null
  private isSendingChat = false
  private isFetchingCloudData = false
  private isPollingBrowserStatus = false
  private cachedCloudSnapshot: MuseCloudSnapshot | null = null
  private cachedBrowserStatus: MuseCloudBrowserStatus = {
    active: false,
    updatedAt: 0,
  }

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
          url: pathToFileURL(filePath).href,
          title,
        }
      }
      return { type, url: rawUrl, title }
    } catch {
      return { type, url: rawUrl, title }
    }
  }

  private pcObserver?: (observation: PcObservation) => Promise<void>
  private pcPolling = false
  public onPcObservation(cb: (observation: PcObservation) => Promise<void>) { this.pcObserver = cb }
  public pcAvailable(): boolean {
    return !!this.museWindow && !this.museWindow.isDestroyed() && !this.museWindow.isVisible() &&
      !this.museWindow.webContents.isLoading() && !this.isSendingChat && !this.isFetchingCloudData
  }
  private async pollPcObservation() {
    if (!this.pcObserver || this.pcPolling) return
    this.pcPolling = true
    const account = pcAccount(this.sessionStore.getCookies())
    try {
      const win = this.museWindow
      // Brief Cloud Hub navigation pauses observation and preserves already accepted work.
      // A long pause still resets continuity through the bridge's observation-gap gate.
      if (this.isFetchingCloudData) return
      if (!account || !win || win.isDestroyed() || win.webContents.isLoading() || win.isVisible()) {
        await this.pcObserver({ account, conversation: '', ready: false, messages: [] }); return
      }
      const observation = await win.webContents.executeJavaScript(`(() => {
        if (!window.__pcObservationEpoch) {
          window.__pcObservationEpoch = crypto.randomUUID()
          window.addEventListener('offline', () => { window.__pcObservationEpoch = crypto.randomUUID() })
          window.addEventListener('online', () => { window.__pcObservationEpoch = crypto.randomUUID() })
        }
        // Real muse.ai mounts several data-hatch-chat-column shells; only the role=log history carries motion + messages.
        const col = document.querySelector('[data-hatch-chat-column="true"][role="log"], [data-hatch-chat-column="true"][data-initial-history-motion], [role="log"][data-initial-history-motion]')
        const ta = document.querySelector('textarea')
        // Scope connection text to page chrome / announcers; ordinary chat words like "offline" must not unready the bridge.
        const connectionSignals = Array.from(document.querySelectorAll(
          '[data-hatch-connection-status-announcer], [data-hatch-composer-support-access-status], [data-hatch-composer-lock-status], [role="status"], [role="alert"], [aria-live]'
        )).filter(el => !el.closest('[data-message-item="true"]') && el.getAttribute('role') !== 'log')
          .map(el => el.innerText || '').join(' ')
        const ready = location.origin === 'https://muse.ai' && location.pathname === '/' && !location.search &&
          navigator.onLine && document.readyState === 'complete' && !!ta && !!col &&
          col.getAttribute('data-initial-history-motion') === 'complete' &&
          !document.querySelector('[aria-busy="true"], [role="progressbar"]') &&
          !/reconnecting|disconnected|offline|connection lost|重新连接|连接断开|网络异常/i.test(connectionSignals)
        const messages = Array.from(document.querySelectorAll('[data-message-item="true"]')).map(el => ({
          id: el.getAttribute('data-message-id') || '', role: el.getAttribute('data-message-role') || '',
          content: (el.innerText || '').trim()
        }))
        return { conversation: location.origin + location.pathname, epoch: window.__pcObservationEpoch, ready, messages }
      })()`)
      if (account !== pcAccount(this.sessionStore.getCookies())) return
      await this.pcObserver({ ...observation, account })
    } catch {
      await this.pcObserver({ account, conversation: '', ready: false, messages: [] })
    } finally { this.pcPolling = false }
  }
  public async sendPcReport(report: string, conversation: string, account: string) {
    if (!this.pcAvailable() || account !== pcAccount(this.sessionStore.getCookies()) || this.museWindow?.webContents.getURL() !== conversation) {
      throw new PcReportNotSubmitted('PC bridge unavailable')
    }
    this.isSendingChat = true
    try {
      let submitError: string | null = null
      await this.sendViaMuseWindow(
        report,
        this.sessionStore.getCookies(),
        () => {},
        () => {},
        (err) => { submitError = err },
        { pcBridge: true, pcAccount: account }
      )
      // Preflight/composer busy before click — definite non-submit for bridge retry.
      if (submitError === 'pc_not_submitted') throw new PcReportNotSubmitted('PC composer busy')
      // Anything else after an attempted click (or unknown) stays uncertain: never blind-retry.
      if (submitError) throw new Error(submitError)
    } catch (err) {
      if (err instanceof PcReportNotSubmitted) throw err
      // Failures before inject/click never submitted the report.
      if (err instanceof Error && /PC session changed|等待 Muse|登录状态|PC bridge unavailable/.test(err.message)) {
        throw new PcReportNotSubmitted(err.message)
      }
      throw err
    } finally { this.isSendingChat = false }
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

  public onCloudBrowserStatus(cb: (status: MuseCloudBrowserStatus) => void) {
    this.onCloudBrowserStatusCallbacks.push(cb)
  }

  public getCloudBrowserStatus(): MuseCloudBrowserStatus {
    return this.cachedBrowserStatus
  }

  public startCloudMessageWatcher() {
    if (this.cloudWatchTimer) return
    this.cloudWatchTimer = setInterval(() => {
      void this.pollPcObservation().catch(() => console.warn('PC status observation unavailable'))
      if (!this.sessionStore.getProfile().isLoggedIn) {
        return
      }
      // Browser status is cheap and should keep updating even while a chat turn streams.
      this.pollCloudBrowserStatus().catch(() => {})
      if (this.isSendingChat || this.isFetchingCloudData) {
        return
      }
      this.fetchCloudMessages(true).catch(() => {})
    }, 4500)
  }

  /**
   * Detect Muse Hatch cloud-browser task banner activity.
   * Idle host exists with 0×0 size; active sessions populate visible content.
   */
  public async pollCloudBrowserStatus(force = false): Promise<MuseCloudBrowserStatus> {
    if (this.isPollingBrowserStatus && !force) {
      return this.cachedBrowserStatus
    }
    const cookies = this.sessionStore.getCookies()
    if (!cookies) {
      this.clearCloudBrowserStatus()
      return this.cachedBrowserStatus
    }

    this.isPollingBrowserStatus = true
    try {
      const win = await this.ensureMuseWindow(cookies)
      if (this.isFetchingCloudData) {
        // Avoid colliding with SPA navigation used by cloud snapshot scraping.
        return this.cachedBrowserStatus
      }

      const extracted = await win.webContents.executeJavaScript(`
        (() => {
          const host = document.querySelector('[data-testid="hatch-browser-task-banner-host"]')
          if (!host) {
            return { active: false }
          }
          const rect = host.getBoundingClientRect()
          const text = (host.innerText || '').replace(/\\s+/g, ' ').trim()
          const interactive = host.querySelector('button, a, input, [role="button"], [data-pel-click]')
          const hasSize = rect.width >= 24 && rect.height >= 16
          const active = Boolean(hasSize || interactive || text.length > 0)
          if (!active) {
            return { active: false }
          }

          let url = ''
          let title = ''
          const link = host.querySelector('a[href]')
          if (link) {
            url = link.getAttribute('href') || ''
            title = (link.innerText || link.getAttribute('aria-label') || '').trim()
          }
          const urlMatch = text.match(/https?:\\/\\/[^\\s]+/i)
          if (!url && urlMatch) url = urlMatch[0]

          if (!title) {
            const withoutUrl = url ? text.replace(url, ' ').replace(/\\s+/g, ' ').trim() : text
            title = withoutUrl.slice(0, 80)
          }

          const summary = text && text !== title ? text.slice(0, 160) : ''
          return {
            active: true,
            title: title || undefined,
            url: url || undefined,
            summary: summary || undefined,
          }
        })()
      `)

      if (!this.sessionStore.getCookies()) {
        this.clearCloudBrowserStatus()
        return this.cachedBrowserStatus
      }
      const next: MuseCloudBrowserStatus = {
        active: Boolean(extracted?.active),
        title: extracted?.title || undefined,
        url: extracted?.url || undefined,
        summary: extracted?.summary || undefined,
        updatedAt: Date.now(),
      }

      const prev = this.cachedBrowserStatus
      const changed =
        prev.active !== next.active ||
        prev.title !== next.title ||
        prev.url !== next.url ||
        prev.summary !== next.summary

      this.cachedBrowserStatus = next
      if (changed || force) {
        for (const cb of this.onCloudBrowserStatusCallbacks) {
          try {
            cb(next)
          } catch {
            // ignore subscriber errors
          }
        }
      }
      return next
    } catch (err) {
      console.error('pollCloudBrowserStatus error:', err)
      return this.cachedBrowserStatus
    } finally {
      this.isPollingBrowserStatus = false
    }
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
          browser?: CloudBrowserMessage
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

          // Force-hydrate any lazy media widgets stuck in skeleton state because the window is hidden
          const mediaWidgets = Array.from(
            document.querySelectorAll(
              '[data-testid^="hatch-chat-attachment-presentation-"]'
            )
          )
          let hydratedAny = false
          for (const w of mediaWidgets) {
            if (w.querySelector('[data-slot="skeleton"]') && !w.querySelector('img, video')) {
              const fk = Object.keys(w).find((k) => k.startsWith('__reactFiber'))
              const cur = fk ? w[fk]?.child?.child : null
              const fn = cur?.updateQueue?.memoCache?.data?.[0]?.[2]
              if (typeof fn === 'function') {
                try {
                  fn(true)
                  hydratedAny = true
                } catch {}
              }
            }
          }
          if (hydratedAny) {
            const waitStart = Date.now()
            while (Date.now() - waitStart < 3500) {
              const allReady = mediaWidgets.every(
                (w) => !w.querySelector('[data-slot="skeleton"]') || w.querySelector('img, video')
              )
              if (allReady) break
              await new Promise((r) => setTimeout(r, 250))
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
            const sourceId = el.getAttribute('data-message-id')
            const browser = sourceId && el.querySelector('button[aria-label="打开浏览器预览"]')
              ? { messageId: sourceId, sourceUrl: location.href } : undefined
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

            if (content.length > 0 || attachments.length > 0 || browser) {
              items.push({ id, role, content, attachments, browser })
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
        const strippedContent = (item.content || '')
          .replace(/\n*\[MUSE_LOCAL_CONTEXT\][\s\S]*?\[\/MUSE_LOCAL_CONTEXT\]/g, '')
          .trim()
        const fallbackText =
          !strippedContent && attachments.length > 0
            ? attachments.some((a) => a.type === 'video')
              ? '[虚拟形象动作预览]'
              : '[图片]'
            : strippedContent
        return {
          id: item.id,
          role: item.role,
          content: fallbackText,
          browser: item.browser,
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
        .map((m) => `${m.id}:${m.content.length}:${m.attachments?.length || 0}:${JSON.stringify(m.browser || null)}`)
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
        height: 860,
        title: 'Muse Cloud Workspace (muse.ai)',
        autoHideMenuBar: true,
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
      // Intercept user close on the console window so it returns to background keep-alive mode
      this.museWindow.on('close', (e) => {
        if (this.museWindow && !this.museWindow.isDestroyed() && this.museWindow.isVisible()) {
          e.preventDefault()
          this.museWindow.setSkipTaskbar(true)
          this.museWindow.hide()
        }
      })
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

  /**
   * Dedicated BrowserWindow for native cloud-browser preview.
   * Shares persist:meta_muse with the sync museWindow but never shows/steals that window.
   */
  private async ensureCloudBrowserWindow(cookies: string): Promise<BrowserWindow> {
    const ses = session.fromPartition(MUSE_PARTITION)
    await this.injectCookiesIntoSession(ses, cookies)

    if (!this.cloudBrowserWindow || this.cloudBrowserWindow.isDestroyed()) {
      this.cloudBrowserWindow = new BrowserWindow({
        width: 1280,
        height: 860,
        minWidth: 720,
        minHeight: 520,
        title: 'Muse Cloud Browser',
        autoHideMenuBar: true,
        backgroundColor: '#0b0d12',
        show: false,
        skipTaskbar: false,
        webPreferences: {
          partition: MUSE_PARTITION,
          nodeIntegration: false,
          contextIsolation: false,
          javascript: true,
          backgroundThrottling: false,
        },
      })
      this.cloudBrowserWindow.webContents.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
      )
      // Muse SPA overwrites document.title frequently; lock the native window label.
      const lockCloudBrowserTitle = () => {
        if (this.cloudBrowserWindow && !this.cloudBrowserWindow.isDestroyed()) {
          if (this.cloudBrowserWindow.getTitle() !== 'Muse Cloud Browser') {
            this.cloudBrowserWindow.setTitle('Muse Cloud Browser')
          }
        }
      }
      this.cloudBrowserWindow.on('page-title-updated', (e) => {
        e.preventDefault()
        lockCloudBrowserTitle()
      })
      this.cloudBrowserWindow.webContents.on('did-finish-load', lockCloudBrowserTitle)
      this.cloudBrowserWindow.webContents.on('did-navigate-in-page', lockCloudBrowserTitle)
      this.cloudBrowserWindow.webContents.on('dom-ready', lockCloudBrowserTitle)
      this.cloudBrowserWindow.on('close', (e) => {
        if (
          this.cloudBrowserWindow &&
          !this.cloudBrowserWindow.isDestroyed() &&
          this.cloudBrowserWindow.isVisible()
        ) {
          e.preventDefault()
          this.cloudBrowserWindow.hide()
        }
      })
      this.cloudBrowserWindow.on('closed', () => {
        this.cloudBrowserWindow = null
      })
    }

    return this.cloudBrowserWindow
  }

  private async loadCloudBrowserUrl(win: BrowserWindow, targetUrl: string): Promise<void> {
    const currentUrl = win.webContents.getURL()
    if (currentUrl === targetUrl) return

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Cloud browser page load timeout')), PAGE_READY_TIMEOUT_MS)
      const onFail = (_event: Electron.Event, errorCode: number, errorDescription: string) => {
        if (errorCode === -3) return // aborted / redirected
        clearTimeout(timer)
        win.webContents.removeListener('did-finish-load', onLoad)
        reject(new Error(errorDescription || 'Cloud browser page failed to load'))
      }
      const onLoad = () => {
        clearTimeout(timer)
        win.webContents.removeListener('did-fail-load', onFail)
        resolve()
      }
      win.webContents.once('did-finish-load', onLoad)
      win.webContents.once('did-fail-load', onFail)
      win.loadURL(targetUrl).catch((err) => {
        clearTimeout(timer)
        win.webContents.removeListener('did-finish-load', onLoad)
        win.webContents.removeListener('did-fail-load', onFail)
        reject(err)
      })
    })
  }

  private hideCloudBrowserWindow() {
    if (this.cloudBrowserWindow && !this.cloudBrowserWindow.isDestroyed() && this.cloudBrowserWindow.isVisible()) {
      this.cloudBrowserWindow.hide()
    }
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
  // Muse Cloud Hub Snapshot, Cloud File Reader & Native Console Window
  // ---------------------------------------------------------------------------

  private getCloudSnapshotCachePath(): string {
    return path.join(app.getPath('userData'), 'cloud_snapshot.json')
  }

  private loadCachedCloudSnapshot(): MuseCloudSnapshot | null {
    if (this.cachedCloudSnapshot) return this.cachedCloudSnapshot
    try {
      const p = this.getCloudSnapshotCachePath()
      if (fs.existsSync(p)) {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as MuseCloudSnapshot
        this.cachedCloudSnapshot = parsed
        return parsed
      }
    } catch {}
    return null
  }

  private saveCachedCloudSnapshot(snapshot: MuseCloudSnapshot): void {
    this.cachedCloudSnapshot = snapshot
    try {
      fs.writeFileSync(this.getCloudSnapshotCachePath(), JSON.stringify(snapshot, null, 2), 'utf-8')
    } catch {}
  }

  public async fetchCloudSnapshot(forceRefresh = false): Promise<MuseCloudSnapshot> {
    const cached = this.loadCachedCloudSnapshot()
    if (!forceRefresh && cached && Date.now() - cached.updatedAt < 45_000) {
      return cached
    }

    const cookies = this.sessionStore.getCookies()
    const fallbackName = this.sessionStore.getProfile().agentName || 'Luna'
    const emptySnapshot: MuseCloudSnapshot = cached || {
      agentName: fallbackName,
      scheduledTasks: [],
      activities: [],
      goals: [],
      ideas: [],
      files: [],
      updatedAt: Date.now(),
    }

    if (!cookies || this.isSendingChat || this.isFetchingCloudData) {
      return emptySnapshot
    }

    this.isFetchingCloudData = true
    try {
      const win = await this.ensureMuseWindow(cookies)

      const extracted = await win.webContents.executeJavaScript(`
        (async function() {
          const NL = String.fromCharCode(10)
          const go = async (targetPath, waitMs = 600) => {
            if (location.pathname + location.search !== targetPath) {
              history.pushState({}, '', targetPath)
              window.dispatchEvent(new PopStateEvent('popstate'))
              await new Promise(r => setTimeout(r, waitMs))
            }
          }

          await go('/', 450)
          const agentNameEl = document.querySelector('[data-pel-click="chat_avatar_click"]')
          const agentName = (agentNameEl ? agentNameEl.innerText : '').trim() || 'Luna'

          // 1. Scheduled tasks & Activities from right status panel
          const actBtn = document.querySelector('button[aria-label="动态"], button[aria-label="Activity"]')
          if (actBtn) actBtn.click()
          await new Promise(r => setTimeout(r, 250))

          const seenTasks = new Set()
          const scheduledTasks = []
          for (const btn of Array.from(
            document.querySelectorAll('[data-pel-click="status_task_context_menu_open"]')
          )) {
            // Prefer the nearest dedicated row; fall back to the button itself so shared parents
            // do not concatenate every task into one schedule string.
            const row =
              btn.closest('[data-pel-click="status_task_context_menu_open"]')?.parentElement ||
              btn.parentElement ||
              btn
            const ownLines = (btn.innerText || '').split(NL).map(s => s.trim()).filter(Boolean)
            const rowLines = (row.innerText || '').split(NL).map(s => s.trim()).filter(Boolean)
            // When the parent contains many tasks, keep only the lines that belong to this button.
            let lines = ownLines
            if (ownLines.length === 0) {
              lines = rowLines.slice(0, 2)
            } else if (rowLines.length > ownLines.length + 2) {
              const idx = rowLines.indexOf(ownLines[0])
              lines = idx >= 0 ? rowLines.slice(idx, idx + Math.max(ownLines.length, 2)) : ownLines
            } else {
              lines = rowLines.length ? rowLines : ownLines
            }
            const title = lines[0] || ''
            const schedule = lines.slice(1).join(' · ') || ''
            const key = title + '|' + schedule
            if (!title || seenTasks.has(key)) continue
            seenTasks.add(key)
            scheduledTasks.push({ title, schedule })
          }

          const activities = []
          const dayToggles = Array.from(
            document.querySelectorAll('[data-pel-click="status_activity_day_toggle_click"]')
          )
          for (const toggle of dayToggles) {
            const dayLabel = (toggle.innerText || '').trim() || '今天'
            const group = toggle.parentElement
            if (!group) continue
            const lines = (group.innerText || '')
              .split(NL)
              .map(s => s.trim())
              .filter(s => s && s !== dayLabel)
            // Parse triplets: [title, summary, HH:MM]
            let i = 0
            while (i < lines.length) {
              const line = lines[i]
              const next1 = lines[i + 1] || ''
              const next2 = lines[i + 2] || ''
              if (/^\\d{1,2}:\\d{2}$/.test(next2)) {
                activities.push({
                  day: dayLabel,
                  title: line,
                  summary: next1,
                  time: next2
                })
                i += 3
              } else if (/^\\d{1,2}:\\d{2}$/.test(next1)) {
                activities.push({
                  day: dayLabel,
                  title: line,
                  summary: '',
                  time: next1
                })
                i += 2
              } else {
                i += 1
              }
            }
          }

          // Check Identity tab for vibe summary
          let identityVibe = ''
          const idBtn = document.querySelector('button[aria-label="身份"], button[aria-label="Identity"]')
          if (idBtn) {
            idBtn.click()
            await new Promise(r => setTimeout(r, 250))
            const bodyLines = (document.body.innerText || '').split(NL).map(s => s.trim()).filter(Boolean)
            const styleIdx = bodyLines.findIndex(l => l === '风格气质' || l === 'Vibe')
            if (styleIdx >= 0 && bodyLines[styleIdx + 1]) {
              identityVibe = bodyLines[styleIdx + 1]
            }
            if (actBtn) actBtn.click()
          }

          // 2. Goals (/goals)
          await go('/goals', 650)
          const seenGoals = new Set()
          const goals = []
          for (const el of Array.from(document.querySelectorAll('div, button, a'))) {
            if (el.closest('[data-message-item="true"]')) continue
            const t = (el.innerText || '').trim()
            const lines = t.split(NL).map(s => s.trim()).filter(Boolean)
            if (
              lines.length === 2 &&
              lines[0].length >= 3 &&
              lines[0].length <= 50 &&
              lines[1].length >= 15 &&
              lines[1].length <= 240 &&
              !seenGoals.has(lines[0])
            ) {
              seenGoals.add(lines[0])
              goals.push({ title: lines[0], description: lines[1] })
            }
          }

          // 3. Ideas (/ideas)
          await go('/ideas', 650)
          const seenIdeas = new Set()
          const ideas = []
          for (const el of Array.from(document.querySelectorAll('div, button, a'))) {
            if (el.closest('[data-message-item="true"]')) continue
            const t = (el.innerText || '').trim()
            const lines = t.split(NL).map(s => s.trim()).filter(Boolean)
            if (
              lines.length === 2 &&
              lines[0].length >= 4 &&
              lines[0].length <= 50 &&
              lines[1].length >= 18 &&
              lines[1].length <= 240 &&
              !seenIdeas.has(lines[0])
            ) {
              seenIdeas.add(lines[0])
              ideas.push({ title: lines[0], description: lines[1] })
            }
          }

          // 4. Cloud System Files (/library/files)
          await go('/library/files', 700)
          const seenFiles = new Set()
          const files = []
          for (const el of Array.from(document.querySelectorAll('div, tr, a, button'))) {
            if (el.closest('[data-message-item="true"]')) continue
            const t = (el.innerText || '').trim()
            const lines = t.split(NL).map(s => s.trim()).filter(Boolean)
            if (lines.length === 2 && (lines[1] === '文件夹' || lines[1] === 'Folder')) {
              if (!seenFiles.has(lines[0])) {
                seenFiles.add(lines[0])
                files.push({ name: lines[0], type: 'folder' })
              }
            } else if (lines.length === 4 && lines[1] === 'Text') {
              if (!seenFiles.has(lines[0])) {
                seenFiles.add(lines[0])
                files.push({
                  name: lines[0],
                  type: 'file',
                  modified: lines[2],
                  size: lines[3]
                })
              }
            }
          }

          // Always restore back to '/' so chat composer is ready
          await go('/', 350)

          return {
            agentName,
            identityVibe,
            scheduledTasks,
            activities: activities.slice(0, 30),
            goals,
            ideas: ideas.slice(0, 18),
            files
          }
        })()
      `)

      const snapshot: MuseCloudSnapshot = {
        agentName: extracted?.agentName || fallbackName,
        identityVibe: extracted?.identityVibe || cached?.identityVibe,
        scheduledTasks: extracted?.scheduledTasks || [],
        activities: extracted?.activities || [],
        goals: extracted?.goals || [],
        ideas: extracted?.ideas || [],
        files: extracted?.files || [],
        updatedAt: Date.now(),
      }
      this.saveCachedCloudSnapshot(snapshot)
      return snapshot
    } catch (err) {
      console.error('fetchCloudSnapshot error:', err)
      return emptySnapshot
    } finally {
      this.isFetchingCloudData = false
    }
  }

  public async readCloudFile(fileName: string): Promise<{ fileName: string; content: string }> {
    const cleanName = fileName.replace(/^\/+/, '').trim()
    const cookies = this.sessionStore.getCookies()
    if (!cookies || this.isSendingChat || this.isFetchingCloudData) {
      return {
        fileName: cleanName,
        content: '当前正在对话或尚未登录 Meta Muse，请稍后再试。',
      }
    }

    this.isFetchingCloudData = true
    try {
      const win = await this.ensureMuseWindow(cookies)
      const content: string = await win.webContents.executeJavaScript(`
        (async function() {
          const NL = String.fromCharCode(10)
          const targetName = ${JSON.stringify(cleanName)}
          history.pushState({}, '', '/library/files')
          window.dispatchEvent(new PopStateEvent('popstate'))
          await new Promise(r => setTimeout(r, 600))

          const els = Array.from(document.querySelectorAll('a, button, div, span')).filter(
            el => el.innerText && el.innerText.trim() === targetName
          )
          if (els.length > 0) {
            els[els.length - 1].click()
          } else {
            history.pushState({}, '', '/library/files?file=' + encodeURIComponent('/' + targetName))
            window.dispatchEvent(new PopStateEvent('popstate'))
          }
          await new Promise(r => setTimeout(r, 900))

          const candidates = Array.from(document.querySelectorAll('div, section, article')).filter(el => {
            if (el.closest('[data-message-item="true"]')) return false
            const t = (el.innerText || '').trim()
            return (
              (t.startsWith(targetName + NL) || t.includes(NL + targetName + NL + NL)) &&
              !t.startsWith(targetName + NL + 'Text' + NL) &&
              t.length > targetName.length + 10 &&
              t.length < 25000 &&
              !t.includes('搜索要打开的文件')
            )
          })
          candidates.sort((a, b) => a.innerText.length - b.innerText.length)
          let raw = candidates[0] ? candidates[0].innerText.trim() : ''
          if (raw.startsWith('About this file.')) {
            const idx = raw.indexOf(NL + targetName + NL)
            if (idx >= 0) {
              raw = raw.slice(idx + NL.length + targetName.length + NL.length).trim()
            }
          } else if (raw.startsWith(targetName + NL)) {
            raw = raw.slice(targetName.length + NL.length).trim()
          }

          history.pushState({}, '', '/')
          window.dispatchEvent(new PopStateEvent('popstate'))
          await new Promise(r => setTimeout(r, 300))
          return raw || '（文件为空或暂无法读取预览）'
        })()
      `)
      return { fileName: cleanName, content }
    } catch (err: any) {
      return {
        fileName: cleanName,
        content: `读取云端文件失败: ${err?.message || String(err)}`,
      }
    } finally {
      this.isFetchingCloudData = false
    }
  }

  /**
   * Open the exact message preview in a dedicated native cloud-browser window.
   * Never falls back to showing the sync museWindow. Opens in preview mode only
   * (does not auto-click 「控制浏览器」).
   */
  public async openCloudBrowser(identity: CloudBrowserMessage): Promise<OpenCloudBrowserResult> {
    const fail = (error: string): OpenCloudBrowserResult => ({ ok: false, error })
    if (!identity || typeof identity.messageId !== 'string' || !identity.messageId ||
        typeof identity.sourceUrl !== 'string') return fail('浏览器消息标识无效。')
    try {
      const source = new URL(identity.sourceUrl)
      if (source.origin !== 'https://muse.ai') return fail('浏览器消息来源无效。')
      const cookies = this.sessionStore.getCookies()
      if (!cookies || !this.sessionStore.getProfile().isLoggedIn) return fail('请先登录 Muse。')
      if (this.isFetchingCloudData) return fail('云端正在同步，请稍后重试。')

      const win = await this.ensureCloudBrowserWindow(cookies)
      try {
        await this.loadCloudBrowserUrl(win, identity.sourceUrl)
      } catch {
        this.hideCloudBrowserWindow()
        return fail('无法加载此消息的云端会话，请稍后重试。')
      }

      const result: OpenCloudBrowserResult = await win.webContents.executeJavaScript(`
        (async () => {
          const identity = ${JSON.stringify(identity)}
          const styleId = ${JSON.stringify(CLOUD_BROWSER_ISOLATION_STYLE_ID)}
          const isolationCss = ${JSON.stringify(CLOUD_BROWSER_ISOLATION_CSS)}

          if (location.href !== identity.sourceUrl) {
            return { ok: false, error: '当前云端会话与此消息不同，请同步消息后重试。' }
          }

          const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

          // Cold dedicated-window loads need time for Hatch chat history to hydrate.
          let button = null
          for (let attempt = 0; attempt < 80; attempt++) {
            const matches = Array.from(document.querySelectorAll('[data-message-item="true"]'))
              .filter((el) => el.getAttribute('data-message-id') === identity.messageId)
            if (matches.length === 1) {
              const buttons = matches[0].querySelectorAll('button[aria-label="打开浏览器预览"]')
              if (buttons.length === 1 && !buttons[0].disabled) {
                button = buttons[0]
                break
              }
            }
            await sleep(250)
          }

          if (!button) {
            return { ok: false, error: '未找到此消息的浏览器预览，可能已过期。请同步消息后重试。' }
          }

          // Close any existing panel so we always open this message's preview (no toggle race).
          const existingClose = document.querySelector('button[aria-label="关闭浏览器会话面板"]')
          if (existingClose) {
            existingClose.click()
            for (let attempt = 0; attempt < 20; attempt++) {
              await sleep(100)
              if (!document.querySelector('[data-testid="browser-session-side-panel"]')) break
            }
          }

          button.click()

          for (let attempt = 0; attempt < 40; attempt++) {
            await sleep(150)
            const panel = document.querySelector('[data-testid="browser-session-side-panel"]')
            if (!panel) continue

            let style = document.getElementById(styleId)
            if (!style) {
              style = document.createElement('style')
              style.id = styleId
              document.head.appendChild(style)
            }
            style.textContent = isolationCss

            // Keep invite/marketing portals suppressed if Muse re-mounts them later.
            const scrubOverlays = () => {
              for (const el of Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"]'))) {
                if (el.closest('[data-testid="browser-session-side-panel"]')) continue
                el.setAttribute('data-muse-pet-hidden-overlay', '1')
                el.style.setProperty('display', 'none', 'important')
                el.style.setProperty('visibility', 'hidden', 'important')
                el.style.setProperty('pointer-events', 'none', 'important')
              }
            }
            scrubOverlays()
            if (!window.__musePetCloudBrowserOverlayObserver) {
              const observer = new MutationObserver(() => scrubOverlays())
              observer.observe(document.documentElement, { childList: true, subtree: true })
              window.__musePetCloudBrowserOverlayObserver = observer
            }

            return { ok: true }
          }

          return { ok: false, error: '浏览器预览面板未能打开，请稍后重试。' }
        })()
      `)

      if (!result?.ok) {
        this.hideCloudBrowserWindow()
        return result?.error ? result : fail('浏览器预览未能打开，请稍后重试。')
      }

      win.setSkipTaskbar(false)
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      return { ok: true }
    } catch {
      this.hideCloudBrowserWindow()
      return fail('无法打开浏览器预览，请稍后重试。')
    }
  }

  public clearCloudBrowserStatus() {
    this.cachedBrowserStatus = { active: false, updatedAt: Date.now() }
    for (const cb of this.onCloudBrowserStatusCallbacks) cb(this.cachedBrowserStatus)
  }

  public async openCloudConsole(target: MuseCloudConsoleTarget = 'main'): Promise<boolean> {
    if (this.isSendingChat || this.isFetchingCloudData) return false
    const cookies = this.sessionStore.getCookies()
    if (!cookies) return false
    try {
      const win = await this.ensureMuseWindow(cookies)
      win.setSkipTaskbar(false)
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()

      await win.webContents.executeJavaScript(`
        (async function() {
          const target = ${JSON.stringify(target)}
          const go = async (p) => {
            history.pushState({}, '', p)
            window.dispatchEvent(new PopStateEvent('popstate'))
            await new Promise(r => setTimeout(r, 500))
          }
          if (target === 'library') {
            await go('/library/files')
          } else if (target === 'goals') {
            await go('/goals')
          } else if (target === 'ideas') {
            await go('/ideas')
          } else {
            await go('/')
            if (target === 'wardrobe') {
              await new Promise(r => setTimeout(r, 350))
              const editBtn = document.querySelector('[data-pel-click="status_avatar_edit_menu_open"]')
              if (editBtn) editBtn.click()
            }
          }
        })()
      `)
      return true
    } catch (err) {
      console.error('openCloudConsole error:', err)
      return false
    }
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
    onError: (err: string) => void,
    options?: {
      pcBridge?: boolean
      pcAccount?: string
      imageBase64?: string
      imageMimeType?: string
      imageFileName?: string
    }
  ) {
    if (this.isSendingChat || this.isFetchingCloudData) { onError('Muse is busy; try again shortly.'); return }
    this.aborted = false
    this.isSendingChat = true
    const cookies = this.sessionStore.getCookies()

    try {
      if (!cookies) {
        // No auth — fall back to local companion replies
        return await this.runCompanionReply(content, onChunk, onEnd)
      }

      try {
        await this.sendViaMuseWindow(content, cookies, onChunk, onEnd, onError, options)
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
    onError: (err: string) => void,
    options?: {
      pcBridge?: boolean
      pcAccount?: string
      imageBase64?: string
      imageMimeType?: string
      imageFileName?: string
    }
  ) {
    const win = options?.pcBridge ? this.museWindow! : await this.ensureMuseWindow(cookies)
    if (!this.getCachedAvatarAssets()) {
      this.syncAvatarAssets().catch(() => {})
    }

    // Wait for composer textarea AND initial chat history to finish mounting
    const composerReady = await win.webContents.executeJavaScript(`
      (async function() {
        if (${Boolean(options?.pcBridge)} && (location.pathname !== '/' || !navigator.onLine)) return { ok: false }
        if (location.pathname !== '/') {
          history.pushState({}, '', '/')
          window.dispatchEvent(new PopStateEvent('popstate'))
          await new Promise(r => setTimeout(r, 350))
        }
        const start = Date.now()
        while (Date.now() - start < 20000) {
          const ta = document.querySelector('textarea')
          const col = document.querySelector('[data-hatch-chat-column="true"][role="log"], [data-hatch-chat-column="true"][data-initial-history-motion], [role="log"][data-initial-history-motion]')
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
      const reason = composerReady?.reason === 'not_logged_in'
        ? '登录状态已失效，请重新登录 Meta Muse'
        : '等待 Muse 页面加载超时'
      if (options?.pcBridge) throw new PcReportNotSubmitted(reason)
      throw new Error(reason)
    }

    if (options?.pcBridge && (options.pcAccount !== pcAccount(this.sessionStore.getCookies()) || win.isVisible() || win.webContents.getURL() !== 'https://muse.ai/')) {
      throw new PcReportNotSubmitted('PC session changed')
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
            const pcBridge = ${Boolean(options?.pcBridge)}
            const pcBusy = () => !!(textArea && (textArea.value || !navigator.onLine || location.href !== 'https://muse.ai/' ||
              document.querySelector('[data-hatch-composer-action="stop"], [data-pel-click="chat_stop_generation"]')))
            const clearComposer = (ta, setter, key) => {
              if (setter) setter.call(ta, '')
              else ta.value = ''
              if (key && ta[key] && typeof ta[key].onChange === 'function') {
                ta[key].onChange({ target: ta, currentTarget: ta })
              } else {
                ta.dispatchEvent(new Event('input', { bubbles: true }))
              }
            }
            if (!textArea) {
              if (window.__museActiveRunId === myRunId) {
                window.__museStreamError = pcBridge ? 'pc_not_submitted' : '未找到输入框'
                window.__museStreamDone = true
              }
              return
            }

            // Never overwrite an existing draft or fight a stop/offline composer.
            if (pcBridge && pcBusy()) {
              window.__museStreamError = 'pc_not_submitted'
              window.__museStreamDone = true
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

            // Optional: attach image (e.g., desktop screenshot) to muse.ai file input before sending
            const imgB64 = ${JSON.stringify(options?.imageBase64 || '')}
            const imgMime = ${JSON.stringify(options?.imageMimeType || 'image/png')}
            const imgName = ${JSON.stringify(options?.imageFileName || 'desktop-screen.png')}
            if (imgB64) {
              try {
                const fileInput = document.querySelector('input[type="file"]')
                if (fileInput) {
                  const binStr = atob(imgB64)
                  const bytes = new Uint8Array(binStr.length)
                  for (let i = 0; i < binStr.length; i++) {
                    bytes[i] = binStr.charCodeAt(i)
                  }
                  const blob = new Blob([bytes], { type: imgMime })
                  const file = new File([blob], imgName, { type: imgMime })
                  const dt = new DataTransfer()
                  dt.items.add(file)
                  try {
                    Object.defineProperty(fileInput, 'files', {
                      value: dt.files,
                      configurable: true,
                    })
                  } catch {
                    fileInput.files = dt.files
                  }
                  const fPropsKey = Object.keys(fileInput).find(k => k.startsWith('__reactProps'))
                  if (fPropsKey && fileInput[fPropsKey] && typeof fileInput[fPropsKey].onChange === 'function') {
                    fileInput[fPropsKey].onChange({ target: fileInput, currentTarget: fileInput })
                  } else {
                    fileInput.dispatchEvent(new Event('change', { bubbles: true }))
                  }
                  await new Promise(r => setTimeout(r, 1100))
                }
              } catch (attachErr) {
                console.warn('Attach image failed:', attachErr)
              }
            }

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

            // Re-check after onChange: stop/offline/navigation means we have not clicked yet.
            if (pcBridge && (!navigator.onLine || location.href !== 'https://muse.ai/' ||
              document.querySelector('[data-hatch-composer-action="stop"], [data-pel-click="chat_stop_generation"]'))) {
              clearComposer(textArea, nativeSetter, propsKey)
              window.__museStreamError = 'pc_not_submitted'
              window.__museStreamDone = true
              return
            }

            const sendBtn =
              document.querySelector('[data-pel-click="chat_send_message"]') ||
              document.querySelector('[data-hatch-composer-action="send"] button')

            if (sendBtn && !sendBtn.disabled) {
              // Click attempted: any later failure is uncertain and must not blind-retry.
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
                if (pcBridge) clearComposer(textArea, nativeSetter, propsKey)
                window.__museStreamError = pcBridge ? 'pc_not_submitted' : '无法触发发送按钮'
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
