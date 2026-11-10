import { app, BrowserWindow, clipboard, desktopCapturer, session, shell } from 'electron'
import { execFile } from 'child_process'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { pathToFileURL } from 'url'
import { PendingSecretaryAction } from '../types'

const SECRETARY_PARTITION = 'persist:secretary_browser'

export interface GmailEmailItem {
  sender: string
  subject: string
  snippet: string
  time: string
  unread: boolean
}

export interface GmailInspectionResult {
  query: string
  gmailSearchQuery: string
  searchUrl: string
  openedExternal: boolean
  needsLogin: boolean
  emails: GmailEmailItem[]
  summaryText: string
}

export interface WebInspectionResult {
  url: string
  title: string
  openedExternal: boolean
  excerpt: string
}

export interface ScreenCaptureResult {
  filePath: string
  fileUrl: string
  base64Data: string
  width: number
  height: number
}

export class LocalSecretary {
  private browserWindow: BrowserWindow | null = null
  private pendingActions = new Map<string, PendingSecretaryAction>()
  private onActionUpdatedCallbacks: Array<(action: PendingSecretaryAction) => void> = []

  public onActionUpdated(cb: (action: PendingSecretaryAction) => void) {
    this.onActionUpdatedCallbacks.push(cb)
  }

  private emitActionUpdated(action: PendingSecretaryAction) {
    for (const cb of this.onActionUpdatedCallbacks) {
      try {
        cb(action)
      } catch (e) {
        console.error('LocalSecretary onActionUpdated error:', e)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 1. Gmail & Web Browser Assistant
  // ---------------------------------------------------------------------------

  /**
   * Translates natural language filter expressions into Gmail advanced search syntax
   */
  public buildGmailSearchQuery(rawFilter: string): string {
    const trimmed = rawFilter
      .replace(/^(打开|查看|筛选|搜索|检查|帮我看看|帮我打开|帮我筛选)\s*/i, '')
      .replace(/(的)?(gmail|邮箱|邮件|信件)/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()

    if (!trimmed || /^(全部|所有|收件箱|inbox)$/i.test(trimmed)) {
      return 'in:inbox'
    }

    // If user already wrote standard Gmail operators like from:, is:, subject:
    if (/\b(from:|to:|subject:|is:|has:|newer_than:|older_than:|label:)/i.test(trimmed)) {
      return trimmed
    }

    const tokens: string[] = []
    let rest = trimmed

    if (/未读|unread/i.test(rest)) {
      tokens.push('is:unread')
      rest = rest.replace(/未读|unread/gi, ' ')
    }
    if (/星标|重要|starred|important/i.test(rest)) {
      tokens.push('is:starred')
      rest = rest.replace(/星标|重要|starred|important/gi, ' ')
    }
    if (/附件|attachment/i.test(rest)) {
      tokens.push('has:attachment')
      rest = rest.replace(/有?附件|attachment/gi, ' ')
    }
    if (/今天|今日|today/i.test(rest)) {
      tokens.push('newer_than:1d')
      rest = rest.replace(/今天|今日|today/gi, ' ')
    } else if (/昨天|近期|最近三天/i.test(rest)) {
      tokens.push('newer_than:3d')
      rest = rest.replace(/昨天|近期|最近三天/gi, ' ')
    } else if (/本周|最近一周|最近7天|7天内/i.test(rest)) {
      tokens.push('newer_than:7d')
      rest = rest.replace(/本周|最近一周|最近7天|7天内/gi, ' ')
    }

    // Match "来自 XXX" or "发件人 XXX"
    const fromMatch = rest.match(/(?:来自|发件人[:：]?|from)\s*([^\s,，。]+)/i)
    if (fromMatch && fromMatch[1]) {
      tokens.push(`from:${fromMatch[1]}`)
      rest = rest.replace(fromMatch[0], ' ')
    }

    // Clean remaining filler words
    const keywords = rest
      .replace(/(关于|包含|有关|主题是|标题是|里|中的|筛选|查找|搜索|的)/g, ' ')
      .trim()

    if (keywords) {
      tokens.push(keywords)
    }

    return tokens.length > 0 ? tokens.join(' ') : 'in:inbox'
  }

  /**
   * Opens Gmail with the constructed filter in the default browser AND inspects/extracts
   * the matching email rows via the persistent secretary browser window.
   */
  public async openAndInspectGmail(
    rawFilter: string,
    openExternalBrowser = true
  ): Promise<GmailInspectionResult> {
    const gmailSearchQuery = this.buildGmailSearchQuery(rawFilter)
    const searchUrl =
      gmailSearchQuery === 'in:inbox'
        ? 'https://mail.google.com/mail/u/0/#inbox'
        : `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(gmailSearchQuery)}`

    if (openExternalBrowser) {
      await shell.openExternal(searchUrl)
    }

    try {
      const win = await this.ensureSecretaryBrowser()
      await win.loadURL(searchUrl)

      // Wait briefly for either Google login redirect or Gmail message table `tr.zA`
      const inspectData = await win.webContents.executeJavaScript(`
        (async function() {
          const start = Date.now()
          while (Date.now() - start < 8500) {
            const href = location.href
            if (href.includes('accounts.google.com') || href.includes('ServiceLogin')) {
              return { needsLogin: true, emails: [] }
            }
            const rows = Array.from(document.querySelectorAll('tr.zA'))
            if (rows.length > 0) {
              const emails = rows.slice(0, 12).map(row => {
                const unread = row.classList.contains('zE')
                const senderEl = row.querySelector('.yW span[email], .yW .bA4 span, .yX.xY')
                const subjectEl = row.querySelector('.bog span, .y6 span')
                const snippetEl = row.querySelector('.y2')
                const timeEl = row.querySelector('td.xW span')
                return {
                  sender: (senderEl?.textContent || '').trim(),
                  subject: (subjectEl?.textContent || '').trim(),
                  snippet: (snippetEl?.textContent || '').replace(/^\\s*-\\s*/, '').trim(),
                  time: (timeEl?.getAttribute('title') || timeEl?.textContent || '').trim(),
                  unread
                }
              }).filter(e => e.sender || e.subject)
              return { needsLogin: false, emails }
            }
            // Check if Gmail explicitly says "No messages matched your search"
            const emptyNode = document.querySelector('td.TC')
            if (emptyNode && (emptyNode.innerText || '').trim().length > 0) {
              return { needsLogin: false, emails: [], emptyHint: emptyNode.innerText.trim() }
            }
            await new Promise(r => setTimeout(r, 400))
          }
          return { needsLogin: location.href.includes('accounts.google.com'), emails: [] }
        })()
      `)

      if (inspectData?.needsLogin) {
        // Show the controlled secretary browser once so the user can sign in if they want automatic reading
        win.show()
        win.focus()
        return {
          query: rawFilter,
          gmailSearchQuery,
          searchUrl,
          openedExternal: openExternalBrowser,
          needsLogin: true,
          emails: [],
          summaryText: `已在系统默认浏览器为你打开 Gmail 筛选页（条件：\`${gmailSearchQuery}\`）。\n受控小秘书浏览器尚未登录 Google 账号（已为你弹出登录窗口，登录一次后小秘书即可直接帮你读取并总结邮件正文）。`,
        }
      }

      const emails: GmailEmailItem[] = inspectData?.emails || []
      let summaryText = `已在浏览器打开 Gmail 筛选页（搜索语法：\`${gmailSearchQuery}\`）。`
      if (emails.length > 0) {
        const formattedList = emails
          .map(
            (e, idx) =>
              `${idx + 1}. ${e.unread ? '[未读] ' : ''}${e.sender} — 《${e.subject}》 (${e.time})\n   摘要：${e.snippet}`
          )
          .join('\n')
        summaryText += `\n共抓取到前 ${emails.length} 封匹配邮件：\n${formattedList}`
      } else {
        summaryText += `\n当前筛选条件 \`${gmailSearchQuery}\` 下暂未抓到邮件列表（或页面仍在加载中，可直接在已打开的浏览器标签页查看）。`
      }

      return {
        query: rawFilter,
        gmailSearchQuery,
        searchUrl,
        openedExternal: openExternalBrowser,
        needsLogin: false,
        emails,
        summaryText,
      }
    } catch (err: any) {
      return {
        query: rawFilter,
        gmailSearchQuery,
        searchUrl,
        openedExternal: openExternalBrowser,
        needsLogin: false,
        emails: [],
        summaryText: `已在系统默认浏览器为你打开 Gmail 筛选页：${searchUrl}（筛选条件：\`${gmailSearchQuery}\`）。`,
      }
    }
  }

  /**
   * Opens any URL or search query in default browser and extracts readable page text
   */
  public async openAndInspectWeb(targetOrQuery: string, openExternal = true): Promise<WebInspectionResult> {
    let url = targetOrQuery.trim()
    if (!/^https?:\/\//i.test(url)) {
      if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/i.test(url)) {
        url = `https://${url}`
      } else {
        url = `https://www.google.com/search?q=${encodeURIComponent(url)}`
      }
    }

    if (openExternal) {
      await shell.openExternal(url)
    }

    try {
      const win = await this.ensureSecretaryBrowser()
      await win.loadURL(url)
      await new Promise((r) => setTimeout(r, 2500))
      const pageData = await win.webContents.executeJavaScript(`
        ({
          title: document.title || '',
          excerpt: (document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 2000)
        })
      `)
      return {
        url,
        title: pageData?.title || url,
        openedExternal: openExternal,
        excerpt: pageData?.excerpt || '',
      }
    } catch {
      return {
        url,
        title: url,
        openedExternal: openExternal,
        excerpt: '',
      }
    }
  }

  private async ensureSecretaryBrowser(): Promise<BrowserWindow> {
    if (this.browserWindow && !this.browserWindow.isDestroyed()) {
      return this.browserWindow
    }

    const secSession = session.fromPartition(SECRETARY_PARTITION)
    const chromeUA =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    secSession.setUserAgent(chromeUA)

    this.browserWindow = new BrowserWindow({
      width: 1100,
      height: 760,
      show: false,
      title: 'Muse 小秘书受控浏览器 (登录一次即可自动读取邮件)',
      autoHideMenuBar: true,
      webPreferences: {
        partition: SECRETARY_PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
      },
    })
    this.browserWindow.webContents.setUserAgent(chromeUA)

    // Hide instead of closing so session stays warm
    this.browserWindow.on('close', (e) => {
      if (this.browserWindow && !this.browserWindow.isDestroyed() && this.browserWindow.isVisible()) {
        e.preventDefault()
        this.browserWindow.hide()
      }
    })

    return this.browserWindow
  }

  // ---------------------------------------------------------------------------
  // 2. Desktop Screen Capture & Vision
  // ---------------------------------------------------------------------------

  public async captureDesktopScreen(): Promise<ScreenCaptureResult> {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 },
    })

    if (!sources || sources.length === 0) {
      throw new Error('未能获取到当前桌面屏幕画面')
    }

    const primary = sources[0]
    const pngBuffer = primary.thumbnail.toPNG()
    const size = primary.thumbnail.getSize()

    const mediaDir = path.join(app.getPath('userData'), 'media_cache')
    fs.mkdirSync(mediaDir, { recursive: true })
    const filePath = path.join(mediaDir, `screen-${Date.now()}.png`)
    fs.writeFileSync(filePath, pngBuffer)

    return {
      filePath,
      fileUrl: pathToFileURL(filePath).href,
      base64Data: pngBuffer.toString('base64'),
      width: size.width,
      height: size.height,
    }
  }

  // ---------------------------------------------------------------------------
  // 3. Local File & Clipboard Butler
  // ---------------------------------------------------------------------------

  public readClipboardText(): string {
    return clipboard.readText() || ''
  }

  public writeClipboardText(text: string): void {
    clipboard.writeText(text)
  }

  public searchLocalFiles(keyword: string, customRoot?: string): string[] {
    const home = os.homedir()
    const roots = customRoot
      ? [customRoot]
      : [
          path.join(home, 'Desktop'),
          path.join(home, 'Downloads'),
          path.join(home, 'Documents'),
        ]

    const matches: string[] = []
    const lowerKey = keyword.trim().toLowerCase()

    const walk = (dir: string, depth: number) => {
      if (depth > 3 || matches.length >= 25) return
      let entries: fs.Dirent[] = []
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (matches.length >= 25) break
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
        const fullPath = path.join(dir, entry.name)
        if (!lowerKey || entry.name.toLowerCase().includes(lowerKey)) {
          matches.push(fullPath)
        }
        if (entry.isDirectory()) {
          walk(fullPath, depth + 1)
        }
      }
    }

    for (const root of roots) {
      if (fs.existsSync(root)) {
        walk(root, 0)
      }
    }
    return matches
  }

  public readLocalFileExcerpt(targetPath: string, maxChars = 4000): { resolvedPath: string; content: string } {
    let resolved = targetPath.trim().replace(/^["']|["']$/g, '')
    if (!path.isAbsolute(resolved)) {
      const desktopTry = path.join(os.homedir(), 'Desktop', resolved)
      const downloadTry = path.join(os.homedir(), 'Downloads', resolved)
      if (fs.existsSync(desktopTry)) {
        resolved = desktopTry
      } else if (fs.existsSync(downloadTry)) {
        resolved = downloadTry
      } else {
        resolved = path.resolve(os.homedir(), resolved)
      }
    }

    if (!fs.existsSync(resolved)) {
      throw new Error(`找不到文件: ${resolved}`)
    }
    const stat = fs.statSync(resolved)
    if (stat.isDirectory()) {
      const items = fs.readdirSync(resolved).slice(0, 50)
      return {
        resolvedPath: resolved,
        content: `[目录内容 (${items.length} 项)]:\n${items.join('\n')}`,
      }
    }

    const raw = fs.readFileSync(resolved, 'utf-8')
    const content = raw.length > maxChars ? `${raw.slice(0, maxChars)}\n...(已截断，共 ${raw.length} 字符)` : raw
    return { resolvedPath: resolved, content }
  }

  // ---------------------------------------------------------------------------
  // 4. System Snapshot & Gated PowerShell Execution
  // ---------------------------------------------------------------------------

  public async getSystemSnapshot(): Promise<string> {
    const cpus = os.cpus()
    const totalMemGB = (os.totalmem() / 1024 / 1024 / 1024).toFixed(1)
    const freeMemGB = (os.freemem() / 1024 / 1024 / 1024).toFixed(1)
    const usedMemGB = ((os.totalmem() - os.freemem()) / 1024 / 1024 / 1024).toFixed(1)
    const memPercent = Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100)
    const uptimeHours = (os.uptime() / 3600).toFixed(1)

    let topProcesses = ''
    try {
      topProcesses = await this.runReadOnlyPowerShell(
        'Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 6 Name,Id,@{Name="MemMB";Expression={[math]::Round($_.WorkingSet64/1MB,1)}} | Format-Table -AutoSize | Out-String'
      )
    } catch {
      topProcesses = ''
    }

    return [
      `操作系统: Windows (${os.release()}) · 主机名: ${os.hostname()}`,
      `处理器: ${cpus[0]?.model || 'Unknown CPU'} (${cpus.length} 逻辑核心)`,
      `内存占用: ${usedMemGB} GB / ${totalMemGB} GB (${memPercent}% 已用，剩余 ${freeMemGB} GB)`,
      `系统运行时长: ${uptimeHours} 小时`,
      topProcesses ? `内存占用前 6 进程:\n${topProcesses.trim()}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  }

  private runReadOnlyPowerShell(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', command],
        { timeout: 10000, maxBuffer: 2 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error(stderr || err.message))
            return
          }
          resolve(stdout || '')
        }
      )
    })
  }

  /**
   * Creates a gated action that requires user confirmation in the terminal UI
   */
  public createPendingAction(
    type: PendingSecretaryAction['type'],
    title: string,
    command: string,
    description: string
  ): PendingSecretaryAction {
    const id = `sec-${crypto.randomBytes(4).toString('hex')}`
    const action: PendingSecretaryAction = {
      id,
      type,
      title,
      command,
      description,
      status: 'pending',
    }
    this.pendingActions.set(id, action)
    this.emitActionUpdated(action)
    return action
  }

  public getPendingAction(id: string): PendingSecretaryAction | undefined {
    return this.pendingActions.get(id)
  }

  public async approveAction(id: string): Promise<PendingSecretaryAction> {
    let action = this.pendingActions.get(id)
    if (!action) {
      throw new Error('未找到该待授权操作')
    }
    if (action.status === 'executed') {
      return action
    }

    action = { ...action, status: 'approved' }
    this.pendingActions.set(id, action)
    this.emitActionUpdated(action)

    return await this.executeCommandForAction(action)
  }

  public async runDirectApprovedCommand(title: string, command: string): Promise<PendingSecretaryAction> {
    const action = this.createPendingAction('powershell', title, command, '由用户在终端主动点击批准执行')
    return await this.approveAction(action.id)
  }

  public denyAction(id: string): PendingSecretaryAction {
    const action = this.pendingActions.get(id)
    if (!action) {
      throw new Error('未找到该待授权操作')
    }
    const updated: PendingSecretaryAction = {
      ...action,
      status: 'denied',
      output: '用户已拒绝执行该本地操作。',
      executedAt: Date.now(),
    }
    this.pendingActions.set(id, updated)
    this.emitActionUpdated(updated)
    return updated
  }

  private executeCommandForAction(action: PendingSecretaryAction): Promise<PendingSecretaryAction> {
    return new Promise((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', action.command],
        { timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const combined = [stdout?.trim(), stderr?.trim()].filter(Boolean).join('\n')
          const updated: PendingSecretaryAction = {
            ...action,
            status: err ? 'error' : 'executed',
            output: combined || (err ? err.message : '✓ 命令执行成功（无控制台输出）'),
            executedAt: Date.now(),
          }
          this.pendingActions.set(action.id, updated)
          this.emitActionUpdated(updated)
          resolve(updated)
        }
      )
    })
  }

  public destroy() {
    if (this.browserWindow && !this.browserWindow.isDestroyed()) {
      this.browserWindow.destroy()
      this.browserWindow = null
    }
  }
}
