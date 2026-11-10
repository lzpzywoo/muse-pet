import { app, BrowserWindow, clipboard, desktopCapturer, Notification, session, shell } from 'electron'
import { execFile } from 'child_process'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { pathToFileURL } from 'url'
import {
  PendingSecretaryAction,
  SecretaryReminder,
  SecretaryState,
  SecretaryTodoItem,
  WorkflowMacroConfig,
  WorkflowMacroId,
} from '../types'

const SECRETARY_PARTITION = 'persist:secretary_browser'

const DEFAULT_WORKFLOWS: Record<WorkflowMacroId, WorkflowMacroConfig> = {
  work: {
    id: 'work',
    name: '🚀 工作模式',
    description: '一键打开核心办公网页、启动常用软件并汇报今日待办与未读邮件',
    urls: [
      'https://mail.google.com/mail/u/0/#search/is%3Aunread',
      'https://github.com',
    ],
    apps: ['code'],
  },
  focus: {
    id: 'focus',
    name: '🎯 专注番茄钟',
    description: '开启深度专注倒计时，到点由桌宠 Luna 主动冒泡提醒休息',
    urls: [],
    apps: [],
    defaultMinutes: 25,
  },
  meeting: {
    id: 'meeting',
    name: '🎙️ 会议准备模式',
    description: '打开日历/会议页、设定 45 分钟散会纪要提醒并提供静音快捷控制',
    urls: ['https://calendar.google.com'],
    apps: [],
    defaultMinutes: 45,
  },
  off: {
    id: 'off',
    name: '🌙 收工复盘模式',
    description: '汇总今日已完成与未完成待办、检查高负载后台进程并提供一键锁屏授权',
    urls: [],
    apps: [],
  },
}

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
  private onStateUpdatedCallbacks: Array<(state: SecretaryState) => void> = []
  private onReminderFiredCallbacks: Array<(reminder: SecretaryReminder) => void> = []
  private stateFilePath = ''
  private state: SecretaryState = {
    reminders: [],
    todos: [],
    workflows: JSON.parse(JSON.stringify(DEFAULT_WORKFLOWS)),
  }
  private schedulerTimer: NodeJS.Timeout | null = null

  public init() {
    this.stateFilePath = path.join(app.getPath('userData'), 'secretary_state.json')
    this.loadState()
    this.startScheduler()
  }

  private loadState() {
    try {
      if (this.stateFilePath && fs.existsSync(this.stateFilePath)) {
        const raw = JSON.parse(fs.readFileSync(this.stateFilePath, 'utf-8'))
        this.state = {
          reminders: Array.isArray(raw.reminders) ? raw.reminders : [],
          todos: Array.isArray(raw.todos) ? raw.todos : [],
          workflows: {
            ...JSON.parse(JSON.stringify(DEFAULT_WORKFLOWS)),
            ...(raw.workflows || {}),
          },
          lastBriefDate: raw.lastBriefDate,
        }
      }
    } catch (e) {
      console.error('LocalSecretary loadState error:', e)
    }
  }

  private saveState() {
    try {
      if (!this.stateFilePath) {
        this.stateFilePath = path.join(app.getPath('userData'), 'secretary_state.json')
      }
      fs.writeFileSync(this.stateFilePath, JSON.stringify(this.state, null, 2), 'utf-8')
      this.emitStateUpdated()
    } catch (e) {
      console.error('LocalSecretary saveState error:', e)
    }
  }

  public getState(): SecretaryState {
    return this.state
  }

  public onStateUpdated(cb: (state: SecretaryState) => void) {
    this.onStateUpdatedCallbacks.push(cb)
  }

  public onReminderFired(cb: (reminder: SecretaryReminder) => void) {
    this.onReminderFiredCallbacks.push(cb)
  }

  private emitStateUpdated() {
    for (const cb of this.onStateUpdatedCallbacks) {
      try {
        cb(this.state)
      } catch (e) {
        console.error('LocalSecretary onStateUpdated error:', e)
      }
    }
  }

  private startScheduler() {
    if (this.schedulerTimer) clearInterval(this.schedulerTimer)
    this.schedulerTimer = setInterval(() => {
      const now = Date.now()
      let changed = false
      for (const rem of this.state.reminders) {
        if (!rem.fired && now >= rem.dueAt) {
          rem.fired = true
          changed = true
          this.fireReminderNotification(rem)
        }
      }
      if (changed) {
        this.saveState()
      }
    }, 3000)
  }

  private fireReminderNotification(rem: SecretaryReminder) {
    try {
      if (Notification.isSupported()) {
        const n = new Notification({
          title:
            rem.source === 'focus'
              ? '🎯 专注番茄钟完成！'
              : rem.source === 'meeting'
              ? '🎙️ 会议时段提醒'
              : '⏰ Luna 小秘书日程提醒',
          body: rem.title,
        })
        n.show()
      }
    } catch (e) {
      console.warn('Notification error:', e)
    }

    for (const cb of this.onReminderFiredCallbacks) {
      try {
        cb(rem)
      } catch (e) {
        console.error('onReminderFired callback error:', e)
      }
    }
  }

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
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer)
      this.schedulerTimer = null
    }
    if (this.browserWindow && !this.browserWindow.isDestroyed()) {
      this.browserWindow.destroy()
      this.browserWindow = null
    }
  }

  // ---------------------------------------------------------------------------
  // 5. Proactive Reminders, Todos, Briefing & Workspace Workflows
  // ---------------------------------------------------------------------------

  public addReminder(
    title: string,
    delayMinutes: number,
    source: SecretaryReminder['source'] = 'reminder'
  ): SecretaryReminder {
    const cleanTitle = title.trim() || '未命名日程提醒'
    const dueAt = Date.now() + Math.max(0.1, delayMinutes) * 60 * 1000
    const rem: SecretaryReminder = {
      id: `rem-${crypto.randomBytes(4).toString('hex')}`,
      title: cleanTitle,
      dueAt,
      createdAt: Date.now(),
      fired: false,
      source,
    }
    this.state.reminders = [
      ...this.state.reminders.filter((r) => !r.fired || Date.now() - r.dueAt < 12 * 3600 * 1000),
      rem,
    ].sort((a, b) => a.dueAt - b.dueAt)
    this.saveState()
    return rem
  }

  public removeReminder(id: string): SecretaryState {
    this.state.reminders = this.state.reminders.filter((r) => r.id !== id)
    this.saveState()
    return this.state
  }

  public addTodo(text: string): SecretaryTodoItem {
    const item: SecretaryTodoItem = {
      id: `todo-${crypto.randomBytes(4).toString('hex')}`,
      text: text.trim(),
      done: false,
      createdAt: Date.now(),
    }
    this.state.todos.push(item)
    this.saveState()
    return item
  }

  public toggleTodo(id: string): SecretaryState {
    this.state.todos = this.state.todos.map((t) =>
      t.id === id
        ? { ...t, done: !t.done, completedAt: !t.done ? Date.now() : undefined }
        : t
    )
    this.saveState()
    return this.state
  }

  public removeTodo(id: string): SecretaryState {
    this.state.todos = this.state.todos.filter((t) => t.id !== id)
    this.saveState()
    return this.state
  }

  public updateWorkflowConfig(
    id: WorkflowMacroId,
    patch: Partial<WorkflowMacroConfig>
  ): SecretaryState {
    const current = this.state.workflows[id] || DEFAULT_WORKFLOWS[id]
    this.state.workflows[id] = {
      ...current,
      ...patch,
      id,
    }
    this.saveState()
    return this.state
  }

  /**
   * Parses natural language time expressions like:
   * - "25分钟后提醒我复盘代码" / "/remind 25m 复盘代码" / "半小时后提醒我喝水"
   * - "15:30提醒我参加周会" / "下午3点半提醒我开会"
   */
  public parseReminderFromText(rawText: string): { delayMinutes: number; title: string } | null {
    const text = rawText.trim()

    // Slash command: /remind 25m 复盘代码 or /remind 10 喝水
    if (/^\/remind\b/i.test(text)) {
      const rest = text.replace(/^\/remind\s*/i, '').trim()
      const m = rest.match(/^(\d+(?:\.\d+)?)\s*(s|sec|秒|m|min|分钟?|h|hr|小时)?\s+(.+)$/i)
      if (m) {
        const val = parseFloat(m[1])
        const unit = (m[2] || 'm').toLowerCase()
        const delayMinutes =
          unit.startsWith('h') || unit.includes('小时')
            ? val * 60
            : unit.startsWith('s') || unit.includes('秒')
            ? val / 60
            : val
        return { delayMinutes, title: m[3].trim() }
      }
    }

    // Relative Chinese time: "25分钟后提醒我..." / "半小时后叫我..." / "10秒后提醒我..."
    const relMatch = text.match(
      /(?:(\d+(?:\.\d+)?)\s*(秒钟?|分钟?|小时|个小时)|半小时|一刻钟)(?:后|之后|以后)?\s*(?:提醒我|叫我|通知我|记得|提醒)?\s*(.+)/i
    )
    if (relMatch) {
      let delayMinutes = 25
      if (text.includes('半小时')) {
        delayMinutes = 30
      } else if (text.includes('一刻钟')) {
        delayMinutes = 15
      } else if (relMatch[1]) {
        const num = parseFloat(relMatch[1])
        const unit = relMatch[2] || '分钟'
        if (unit.includes('小时')) delayMinutes = num * 60
        else if (unit.includes('秒')) delayMinutes = Math.max(0.1, num / 60)
        else delayMinutes = num
      }
      const title = (relMatch[3] || '定时提醒事项').replace(/[。！!]+$/, '').trim()
      return { delayMinutes, title: title || '定时提醒事项' }
    }

    // Absolute clock time today: "下午3点30分提醒我开会" / "15:30提醒我开会"
    const clockMatch = text.match(
      /(?:今天)?(上午|下午|晚上)?\s*(\d{1,2})\s*(?:[:：点时])\s*(\d{1,2}|半)?\s*分?\s*(?:提醒我|叫我|通知我)\s*(.+)/i
    )
    if (clockMatch) {
      const period = clockMatch[1] || ''
      let hour = parseInt(clockMatch[2], 10)
      const minRaw = clockMatch[3]
      const minute = minRaw === '半' ? 30 : minRaw ? parseInt(minRaw, 10) : 0
      if ((period === '下午' || period === '晚上') && hour < 12) {
        hour += 12
      }
      const now = new Date()
      const target = new Date()
      target.setHours(hour, minute, 0, 0)
      if (target.getTime() <= now.getTime()) {
        target.setDate(target.getDate() + 1)
      }
      const delayMinutes = Math.max(1, (target.getTime() - now.getTime()) / 60000)
      const title = clockMatch[4].replace(/[。！!]+$/, '').trim()
      return { delayMinutes, title: title || '日程提醒' }
    }

    return null
  }

  public getScheduleSummaryText(): string {
    const activeReminders = this.state.reminders.filter((r) => !r.fired)
    const pendingTodos = this.state.todos.filter((t) => !t.done)
    const doneTodos = this.state.todos.filter((t) => t.done)

    const remLines =
      activeReminders.length > 0
        ? activeReminders
            .map((r, i) => {
              const minsLeft = Math.max(1, Math.round((r.dueAt - Date.now()) / 60000))
              const timeStr = new Date(r.dueAt).toLocaleTimeString('zh-CN', {
                hour: '2-digit',
                minute: '2-digit',
              })
              return `${i + 1}. [${timeStr} · 约 ${minsLeft} 分钟后] ${r.title}`
            })
            .join('\n')
        : '暂无倒计时提醒'

    const todoLines =
      pendingTodos.length > 0
        ? pendingTodos.map((t, i) => `${i + 1}. [待完成] ${t.text}`).join('\n')
        : '暂无未完成待办'

    return [
      `⏰ 当前倒计时提醒 (${activeReminders.length} 项):\n${remLines}`,
      `📋 今日待办事项 (未完成 ${pendingTodos.length} 项 / 已完成 ${doneTodos.length} 项):\n${todoLines}`,
    ].join('\n\n')
  }

  /**
   * Builds a comprehensive Daily Briefing (Todos + Reminders + Gmail Unread + System Health)
   */
  public async generateDailyBriefing(markDailyDate = true): Promise<string> {
    if (markDailyDate) {
      const todayStr = new Date().toISOString().slice(0, 10)
      this.state.lastBriefDate = todayStr
      this.saveState()
    }

    const scheduleText = this.getScheduleSummaryText()
    const sysText = await this.getSystemSnapshot()
    let gmailSummary = ''
    try {
      const gmailRes = await this.openAndInspectGmail('未读', false)
      gmailSummary = gmailRes.summaryText
    } catch {
      gmailSummary = 'Gmail 未读检查暂不可用'
    }

    return [
      `📅 日期: ${new Date().toLocaleString('zh-CN')}`,
      scheduleText,
      `📧 Gmail 未读邮件巡检:\n${gmailSummary}`,
      `🖥️ 电脑系统状态:\n${sysText}`,
    ].join('\n\n')
  }

  public shouldRunDailyFirstBrief(): boolean {
    const todayStr = new Date().toISOString().slice(0, 10)
    return this.state.lastBriefDate !== todayStr
  }

  public markDailyFirstBriefDone() {
    this.state.lastBriefDate = new Date().toISOString().slice(0, 10)
    this.saveState()
  }

  /**
   * Executes one of the 4 Workspace Quick Macros: work | focus | meeting | off
   */
  public async executeWorkflowMacro(
    id: WorkflowMacroId,
    argText = ''
  ): Promise<{
    summary: string
    pendingAction?: PendingSecretaryAction
  }> {
    const wf = this.state.workflows[id] || DEFAULT_WORKFLOWS[id]

    if (id === 'work') {
      const openedUrls: string[] = []
      for (const u of wf.urls) {
        if (u.trim()) {
          await shell.openExternal(u.trim())
          openedUrls.push(u.trim())
        }
      }
      const launchedApps: string[] = []
      for (const appCmd of wf.apps) {
        const clean = appCmd.trim()
        if (!clean) continue
        try {
          execFile('cmd.exe', ['/c', 'start', '""', clean], { timeout: 5000 }, () => {})
          launchedApps.push(clean)
        } catch {
          // ignore individual app launch failure
        }
      }

      const brief = await this.generateDailyBriefing(true)
      return {
        summary: [
          `已启动【${wf.name}】：`,
          openedUrls.length > 0 ? `- 已打开工作网页: ${openedUrls.join(', ')}` : '',
          launchedApps.length > 0 ? `- 已唤醒本地应用: ${launchedApps.join(', ')}` : '',
          `\n--- 今日工作简报数据 ---\n${brief}`,
        ]
          .filter(Boolean)
          .join('\n'),
      }
    }

    if (id === 'focus') {
      const m = argText.match(/(\d+)/)
      const minutes = m ? Math.max(1, parseInt(m[1], 10)) : wf.defaultMinutes || 25
      const topic =
        argText.replace(/\d+\s*(m|min|分钟)?/gi, '').trim() || '专注工作时段完成，起来活动喝口水吧！'
      const rem = this.addReminder(`🎯 专注完成 (${minutes}分钟)：${topic}`, minutes, 'focus')
      const timeStr = new Date(rem.dueAt).toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
      })
      return {
        summary: `已开启 **${minutes} 分钟深度专注番茄钟**（将于 ${timeStr} 到点提醒：${topic}）。\n当前待办列表：\n${this.getScheduleSummaryText()}`,
      }
    }

    if (id === 'meeting') {
      const openedUrls: string[] = []
      for (const u of wf.urls) {
        if (u.trim()) {
          await shell.openExternal(u.trim())
          openedUrls.push(u.trim())
        }
      }
      const minutes = wf.defaultMinutes || 45
      const rem = this.addReminder('🎙️ 会议结束提醒：整理会议纪要与跟进事项', minutes, 'meeting')
      const timeStr = new Date(rem.dueAt).toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
      })
      const muteAction = this.createPendingAction(
        'powershell',
        '会议模式：一键切换系统静音状态',
        `(New-Object -ComObject WScript.Shell).SendKeys([char]173); Write-Output "已切换系统静音状态"`,
        '通过发送系统音量静音键 (VK_VOLUME_MUTE) 避免会议中桌面通知打扰'
      )
      return {
        summary: `已启动【${wf.name}】：\n- 已打开日历/会议页: ${openedUrls.join(', ') || '无'}\n- 已设定 ${minutes} 分钟散会纪要提醒（${timeStr} 到点）\n- 如需将电脑静音，请点击下方授权卡片：`,
        pendingAction: muteAction,
      }
    }

    // id === 'off' (收工复盘模式)
    const scheduleText = this.getScheduleSummaryText()
    const sysText = await this.getSystemSnapshot()
    const lockAction = this.createPendingAction(
      'powershell',
      '收工锁屏：一键锁定 Windows 桌面',
      `rundll32.exe user32.dll,LockWorkStation; Write-Output "已锁定工作站"`,
      '锁定当前 Windows 会话屏幕，保护下班期间隐私安全'
    )
    return {
      summary: [
        `已启动【${wf.name}】：`,
        scheduleText,
        `🖥️ 当前后台资源状态:\n${sysText}`,
        `如需离开工位锁屏，可点击下方授权卡片一键锁屏：`,
      ].join('\n\n'),
      pendingAction: lockAction,
    }
  }
}
