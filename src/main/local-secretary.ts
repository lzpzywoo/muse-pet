import { app, BrowserWindow, clipboard, desktopCapturer, Notification, session, shell } from 'electron'
import { execFile } from 'child_process'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { pathToFileURL } from 'url'
import { MusePlugin, PendingSecretaryAction, SecretaryState } from '../types'

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
  private onStateUpdatedCallbacks: Array<(state: SecretaryState) => void> = []
  private stateFilePath = ''
  private state: SecretaryState = {
    plugins: [],
  }

  public init() {
    this.stateFilePath = path.join(app.getPath('userData'), 'secretary_state.json')
    this.loadState()
  }

  private loadState() {
    try {
      if (this.stateFilePath && fs.existsSync(this.stateFilePath)) {
        const raw = JSON.parse(fs.readFileSync(this.stateFilePath, 'utf-8'))
        this.state = {
          plugins: Array.isArray(raw.plugins) ? raw.plugins : [],
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

  private emitStateUpdated() {
    for (const cb of this.onStateUpdatedCallbacks) {
      try {
        cb(this.state)
      } catch (e) {
        console.error('LocalSecretary onStateUpdated error:', e)
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
    const visibleAppWindows = BrowserWindow.getAllWindows().filter(
      (w) => !w.isDestroyed() && w.isVisible()
    )
    const winBuild = Number(os.release().split('.')[2] || 0)
    const useDwmExclude =
      (process.platform === 'win32' && winBuild >= 19041) || process.platform === 'darwin'

    try {
      if (useDwmExclude) {
        for (const w of visibleAppWindows) {
          w.setContentProtection(true)
        }
        await new Promise((r) => setTimeout(r, 90))
      } else {
        for (const w of visibleAppWindows) {
          w.hide()
        }
        await new Promise((r) => setTimeout(r, 140))
      }

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
    } finally {
      if (useDwmExclude) {
        for (const w of visibleAppWindows) {
          if (!w.isDestroyed()) {
            w.setContentProtection(false)
          }
        }
      } else {
        for (const w of visibleAppWindows) {
          if (!w.isDestroyed()) {
            w.show()
          }
        }
      }
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


  // ---------------------------------------------------------------------------
  // 6. Self-Modifying UI & Live Plugin Engine
  // ---------------------------------------------------------------------------

  public getPlugins(): MusePlugin[] {
    return this.state.plugins || []
  }

  public installOrUpdatePlugin(
    input: Omit<MusePlugin, 'id' | 'createdAt'> & { id?: string }
  ): MusePlugin {
    const existingIdx = this.state.plugins.findIndex(
      (p) => (input.id && p.id === input.id) || p.name === input.name
    )
    const id =
      existingIdx >= 0
        ? this.state.plugins[existingIdx].id
        : input.id || `plg-${crypto.randomBytes(4).toString('hex')}`

    const plugin: MusePlugin = {
      id,
      name: input.name || '未命名界面插件',
      description: input.description || '由 Luna 动态生成的界面/功能扩展插件',
      category: input.category || 'bundle',
      enabled: input.enabled !== undefined ? input.enabled : true,
      chatCss: input.chatCss,
      chatHtml: input.chatHtml,
      chatJs: input.chatJs,
      petCss: input.petCss,
      petHtml: input.petHtml,
      petJs: input.petJs,
      createdAt: existingIdx >= 0 ? this.state.plugins[existingIdx].createdAt : Date.now(),
    }

    // If installing an enabled theme plugin, disable previous theme plugins to prevent style clash
    if (plugin.enabled && plugin.category === 'theme') {
      this.state.plugins = this.state.plugins.map((p) =>
        p.category === 'theme' && p.id !== plugin.id ? { ...p, enabled: false } : p
      )
    }

    if (existingIdx >= 0) {
      this.state.plugins[existingIdx] = plugin
    } else {
      this.state.plugins.unshift(plugin)
    }

    this.saveState()
    return plugin
  }

  public togglePlugin(id: string): SecretaryState {
    const target = this.state.plugins.find((p) => p.id === id)
    if (!target) return this.state
    const nextEnabled = !target.enabled

    this.state.plugins = this.state.plugins.map((p) => {
      if (p.id === id) {
        return { ...p, enabled: nextEnabled }
      }
      if (nextEnabled && target.category === 'theme' && p.category === 'theme') {
        return { ...p, enabled: false }
      }
      return p
    })
    this.saveState()
    return this.state
  }

  public removePlugin(id: string): SecretaryState {
    this.state.plugins = this.state.plugins.filter((p) => p.id !== id)
    this.saveState()
    return this.state
  }

  public resetAllPlugins(): SecretaryState {
    this.state.plugins = []
    this.saveState()
    return this.state
  }

  /**
   * Extracts a ```muse-plugin ... ``` or JSON plugin block from Luna's reply
   */
  public extractPluginFromText(text: string): MusePlugin | null {
    const blockMatch =
      text.match(/```(?:muse-plugin|json)\s*\n([\s\S]*?)```/i) ||
      text.match(/\{[\s\S]*?"(?:chatCss|chatHtml|petCss|petHtml)"[\s\S]*?\}/i)
    if (!blockMatch) return null
    const rawJson = (blockMatch[1] || blockMatch[0]).trim()
    try {
      const parsed = JSON.parse(rawJson)
      if (
        parsed &&
        typeof parsed === 'object' &&
        (parsed.chatCss || parsed.chatHtml || parsed.chatJs || parsed.petCss || parsed.petHtml)
      ) {
        return this.installOrUpdatePlugin({
          id: parsed.id,
          name: parsed.name || 'Luna 自定义界面扩展',
          description: parsed.description || '由 Luna 实时生成的界面与功能插件',
          category: parsed.category || (parsed.chatHtml || parsed.petHtml ? 'widget' : 'theme'),
          enabled: true,
          chatCss: parsed.chatCss,
          chatHtml: parsed.chatHtml,
          chatJs: parsed.chatJs,
          petCss: parsed.petCss,
          petHtml: parsed.petHtml,
          petJs: parsed.petJs,
        })
      }
    } catch {
      // ignore invalid JSON
    }
    return null
  }

  /**
   * Synthesizes a live, functional MusePlugin (themes, interactive alarm clock, sticky notes, pet aura, etc.)
   * from natural language requests so UI self-modification always succeeds immediately.
   */
  public synthesizePluginFromRequest(rawRequest: string): MusePlugin {
    const text = rawRequest.trim()

    // 1. Mini Alarm Clock / Countdown Timer Widget (小闹钟 / 倒计时器 / 秒表)
    if (/(闹钟|计时器|倒计时|秒表|番茄面板|时钟组件|alarm|timer)/i.test(text)) {
      return this.installOrUpdatePlugin({
        id: 'plg-widget-mini-alarm',
        name: '⏰ 灵动小闹钟与倒计时挂件',
        description: '在终端顶部与桌宠旁挂载实时时钟与交互式小闹钟（支持快捷倒计时、响铃与桌宠冒泡提醒）',
        category: 'widget',
        enabled: true,
        chatCss: `
          .muse-alarm-widget {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
            padding: 8px 14px;
            background: linear-gradient(90deg, rgba(14, 165, 233, 0.14), rgba(139, 92, 246, 0.14));
            border-bottom: 1px solid rgba(56, 189, 248, 0.28);
            font-family: 'JetBrains Mono', monospace;
            font-size: 12px;
            color: #e2e8f0;
          }
          .muse-alarm-clock-now {
            display: flex;
            align-items: center;
            gap: 6px;
            color: #7dd3fc;
            font-weight: 600;
          }
          .muse-alarm-controls {
            display: flex;
            align-items: center;
            gap: 6px;
            flex-wrap: wrap;
          }
          .muse-alarm-btn {
            padding: 3px 8px;
            border-radius: 6px;
            background: rgba(255, 255, 255, 0.08);
            border: 1px solid rgba(255, 255, 255, 0.16);
            color: #f1f5f9;
            cursor: pointer;
            font-size: 11px;
            transition: all 0.15s;
          }
          .muse-alarm-btn:hover {
            background: rgba(56, 189, 248, 0.25);
            border-color: rgba(56, 189, 248, 0.55);
          }
          .muse-alarm-btn.active {
            background: rgba(16, 185, 129, 0.28);
            border-color: rgba(52, 211, 153, 0.65);
            color: #a7f3d0;
          }
          .muse-alarm-input {
            background: rgba(0, 0, 0, 0.45);
            border: 1px solid rgba(255, 255, 255, 0.18);
            border-radius: 6px;
            padding: 2px 7px;
            color: #fff;
            font-size: 11px;
            width: 110px;
            outline: none;
          }
          .muse-alarm-countdown {
            font-weight: 700;
            color: #fcd34d;
            min-width: 54px;
            text-align: center;
          }
        `,
        chatHtml: `
          <div class="muse-alarm-widget">
            <div class="muse-alarm-clock-now">
              <span>🕒</span>
              <span id="muse-live-clock">--:--:--</span>
            </div>
            <div class="muse-alarm-controls">
              <input id="muse-alarm-label" class="muse-alarm-input" type="text" placeholder="闹钟提醒事项..." value="起来活动喝水" />
              <button class="muse-alarm-btn" data-mins="1">1m</button>
              <button class="muse-alarm-btn" data-mins="5">5m</button>
              <button class="muse-alarm-btn" data-mins="15">15m</button>
              <button class="muse-alarm-btn" data-mins="25">25m</button>
              <span id="muse-alarm-cd" class="muse-alarm-countdown">未定时</span>
              <button id="muse-alarm-stop" class="muse-alarm-btn" style="display:none;color:#fda4af;">停止</button>
            </div>
          </div>
        `,
        chatJs: `
          (function() {
            const clockEl = root.querySelector('#muse-live-clock');
            const cdEl = root.querySelector('#muse-alarm-cd');
            const stopBtn = root.querySelector('#muse-alarm-stop');
            const labelInput = root.querySelector('#muse-alarm-label');
            let targetDue = Number(sdk.storage.get('alarm_due') || 0);
            let targetTitle = sdk.storage.get('alarm_title') || '小闹钟时间到啦！';

            function tick() {
              const now = new Date();
              if (clockEl) {
                clockEl.textContent = now.toLocaleTimeString('zh-CN', { hour12: false });
              }
              if (targetDue > 0) {
                const remainSec = Math.max(0, Math.ceil((targetDue - Date.now()) / 1000));
                const mm = String(Math.floor(remainSec / 60)).padStart(2, '0');
                const ss = String(remainSec % 60).padStart(2, '0');
                if (cdEl) cdEl.textContent = '⏳ ' + mm + ':' + ss;
                if (stopBtn) stopBtn.style.display = 'inline-block';
                if (remainSec <= 0) {
                  targetDue = 0;
                  sdk.storage.set('alarm_due', '');
                  if (cdEl) cdEl.textContent = '🔔 已响铃!';
                  if (stopBtn) stopBtn.style.display = 'none';
                  sdk.playBeep();
                  sdk.notify('⏰ [小闹钟响铃] ' + targetTitle);
                }
              }
            }
            const timer = setInterval(tick, 1000);
            tick();

            root.querySelectorAll('[data-mins]').forEach(btn => {
              btn.addEventListener('click', () => {
                const mins = Number(btn.getAttribute('data-mins') || 5);
                targetTitle = (labelInput && labelInput.value.trim()) || '小闹钟提醒';
                targetDue = Date.now() + mins * 60 * 1000;
                sdk.storage.set('alarm_due', String(targetDue));
                sdk.storage.set('alarm_title', targetTitle);
                sdk.addReminder(targetTitle, mins);
                sdk.playBeep();
                tick();
              });
            });

            if (stopBtn) {
              stopBtn.addEventListener('click', () => {
                targetDue = 0;
                sdk.storage.set('alarm_due', '');
                if (cdEl) cdEl.textContent = '已取消';
                stopBtn.style.display = 'none';
              });
            }
            return () => clearInterval(timer);
          })();
        `,
        petCss: `
          .muse-pet-clock-pill {
            padding: 2px 8px;
            border-radius: 999px;
            background: rgba(7, 9, 15, 0.86);
            border: 1px solid rgba(56, 189, 248, 0.45);
            color: #bae6fd;
            font-family: 'JetBrains Mono', monospace;
            font-size: 10px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.45);
          }
        `,
        petHtml: `<div class="muse-pet-clock-pill" id="muse-pet-mini-clock">⏰ --:--</div>`,
        petJs: `
          (function() {
            const el = root.querySelector('#muse-pet-mini-clock');
            const update = () => {
              if (el) el.textContent = '⏰ ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
            };
            update();
            const t = setInterval(update, 1000);
            return () => clearInterval(t);
          })();
        `,
      })
    }

    // 2. Sticky Notes / Memo Pad Widget (便签 / 备忘贴 / 记事本组件)
    if (/(便签|备忘贴|记事贴|小黑板|速记|sticky|note)/i.test(text)) {
      return this.installOrUpdatePlugin({
        id: 'plg-widget-sticky-note',
        name: '📝 终端随手便签贴',
        description: '在终端顶部挂载可随时编辑、自动持久化的随手速记便签栏',
        category: 'widget',
        enabled: true,
        chatCss: `
          .muse-sticky-bar {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 7px 14px;
            background: rgba(251, 191, 36, 0.10);
            border-bottom: 1px solid rgba(251, 191, 36, 0.28);
            font-family: 'JetBrains Mono', monospace;
            font-size: 12px;
          }
          .muse-sticky-input {
            flex: 1;
            background: rgba(0, 0, 0, 0.35);
            border: 1px solid rgba(251, 191, 36, 0.3);
            border-radius: 6px;
            padding: 3px 8px;
            color: #fef3c7;
            font-size: 11.5px;
            outline: none;
          }
        `,
        chatHtml: `
          <div class="muse-sticky-bar">
            <span style="color:#fbbf24;font-weight:600;">📝 随手便签:</span>
            <input id="muse-sticky-text" class="muse-sticky-input" placeholder="输入随时要记住的灵感或备忘（自动保存）..." />
          </div>
        `,
        chatJs: `
          (function() {
            const inp = root.querySelector('#muse-sticky-text');
            if (!inp) return;
            inp.value = sdk.storage.get('sticky_note_val') || '';
            inp.addEventListener('input', () => {
              sdk.storage.set('sticky_note_val', inp.value);
            });
          })();
        `,
      })
    }

    // 3. Pet Aura / Halo / Decoration (桌宠光环 / 桌宠特效 / 气泡美化)
    if (/(桌宠|宠物|立绘|光环|特效|呼吸灯|气泡样式)/i.test(text) && !/终端/i.test(text)) {
      return this.installOrUpdatePlugin({
        id: 'plg-pet-neon-aura',
        name: '✨ 桌宠霓虹星环与流光气泡',
        description: '为桌面上的 Luna 增加动态呼吸能量星环与流光渐变冒泡卡片',
        category: 'pet',
        enabled: true,
        petCss: `
          canvas {
            filter: drop-shadow(0 0 16px rgba(56, 189, 248, 0.55)) drop-shadow(0 0 28px rgba(168, 85, 247, 0.35)) !important;
          }
          .pet-speech-bubble {
            background: linear-gradient(135deg, rgba(15, 23, 42, 0.96), rgba(49, 16, 66, 0.94)) !important;
            border: 1px solid rgba(232, 121, 249, 0.55) !important;
            box-shadow: 0 12px 32px rgba(168, 85, 247, 0.35) !important;
          }
        `,
      })
    }

    // 4. Terminal & Pet Theme Customizations (赛博朋克 / 黑客帝国绿 / 樱花粉 / 复古琥珀 / 极光蓝紫)
    if (/(黑客帝国|matrix|绿|荧光绿|黑绿)/i.test(text)) {
      return this.installOrUpdatePlugin({
        id: 'plg-theme-matrix',
        name: '🟢 Matrix 黑客帝国终端主题',
        description: '经典黑客帝国荧光绿 CRT 终端配色与扫描线光效',
        category: 'theme',
        enabled: true,
        chatCss: `
          .liquid-glass-terminal {
            background: linear-gradient(180deg, rgba(2, 14, 6, 0.98) 0%, rgba(1, 8, 3, 0.99) 100%) !important;
            border: 1px solid rgba(34, 197, 94, 0.55) !important;
            box-shadow: 0 0 36px rgba(34, 197, 94, 0.22), inset 0 1px 0 rgba(74, 222, 128, 0.35) !important;
          }
          .liquid-glass-header, .liquid-glass-prompt {
            background: rgba(4, 24, 10, 0.92) !important;
            border-color: rgba(34, 197, 94, 0.3) !important;
          }
          .liquid-glass-pill {
            border-color: rgba(34, 197, 94, 0.35) !important;
            color: #86efac !important;
          }
          .liquid-glass-terminal * {
            border-color: rgba(34, 197, 94, 0.24);
          }
        `,
        petCss: `
          .pet-speech-bubble {
            background: rgba(2, 18, 7, 0.96) !important;
            border: 1px solid rgba(34, 197, 94, 0.6) !important;
            color: #bbf7d0 !important;
          }
        `,
      })
    }

    if (/(樱花|粉|pink|sakura|少女|可爱)/i.test(text)) {
      return this.installOrUpdatePlugin({
        id: 'plg-theme-sakura',
        name: '🌸 樱花霓虹微醺主题',
        description: '深邃暗夜樱花粉紫渐变边框与柔和星光呼吸灯效',
        category: 'theme',
        enabled: true,
        chatCss: `
          .liquid-glass-terminal {
            background: linear-gradient(165deg, rgba(26, 11, 24, 0.98) 0%, rgba(15, 7, 18, 0.99) 100%) !important;
            border: 1px solid rgba(244, 114, 182, 0.55) !important;
            box-shadow: 0 0 40px rgba(236, 72, 153, 0.25), inset 0 1px 0 rgba(251, 207, 232, 0.35) !important;
          }
          .liquid-glass-header, .liquid-glass-prompt {
            background: rgba(38, 14, 34, 0.9) !important;
            border-color: rgba(244, 114, 182, 0.3) !important;
          }
          .liquid-glass-pill {
            background: rgba(244, 114, 182, 0.14) !important;
            border-color: rgba(244, 114, 182, 0.4) !important;
            color: #fbcfe8 !important;
          }
        `,
        petCss: `
          canvas {
            filter: drop-shadow(0 0 14px rgba(244, 114, 182, 0.45)) !important;
          }
          .pet-speech-bubble {
            background: rgba(31, 11, 27, 0.95) !important;
            border: 1px solid rgba(244, 114, 182, 0.6) !important;
          }
        `,
      })
    }

    if (/(琥珀|复古|橙|金|amber|retro|warm)/i.test(text)) {
      return this.installOrUpdatePlugin({
        id: 'plg-theme-amber-crt',
        name: '🟠 复古琥珀流金终端主题',
        description: '经典暖金琥珀色高对比度护眼终端主题',
        category: 'theme',
        enabled: true,
        chatCss: `
          .liquid-glass-terminal {
            background: linear-gradient(180deg, rgba(20, 13, 4, 0.98) 0%, rgba(12, 8, 2, 0.99) 100%) !important;
            border: 1px solid rgba(245, 158, 11, 0.55) !important;
            box-shadow: 0 0 36px rgba(245, 158, 11, 0.2), inset 0 1px 0 rgba(253, 230, 138, 0.3) !important;
          }
          .liquid-glass-header, .liquid-glass-prompt {
            background: rgba(32, 20, 6, 0.92) !important;
            border-color: rgba(245, 158, 11, 0.3) !important;
          }
          .liquid-glass-pill {
            background: rgba(245, 158, 11, 0.14) !important;
            border-color: rgba(245, 158, 11, 0.4) !important;
            color: #fde68a !important;
          }
        `,
        petCss: `
          .pet-speech-bubble {
            background: rgba(24, 15, 4, 0.96) !important;
            border: 1px solid rgba(245, 158, 11, 0.6) !important;
          }
        `,
      })
    }

    // Default Theme: Cyberpunk Neon Synthwave (赛博朋克霓虹极光主题)
    return this.installOrUpdatePlugin({
      id: 'plg-theme-cyberpunk',
      name: '⚡ 赛博朋克霓虹电光主题',
      description: '赛博电光青与霓虹紫双色流光边框、深空蓝紫基底与桌宠能量光晕',
      category: 'theme',
      enabled: true,
      chatCss: `
        .liquid-glass-terminal {
          background: radial-gradient(circle at top right, rgba(88, 28, 135, 0.42), transparent 55%),
                      radial-gradient(circle at bottom left, rgba(6, 182, 212, 0.28), transparent 55%),
                      rgba(8, 7, 20, 0.98) !important;
          border: 1px solid rgba(34, 211, 238, 0.6) !important;
          box-shadow: 0 0 38px rgba(168, 85, 247, 0.28), 0 0 16px rgba(34, 211, 238, 0.25) !important;
        }
        .liquid-glass-header, .liquid-glass-prompt {
          background: linear-gradient(90deg, rgba(15, 12, 36, 0.92), rgba(32, 13, 52, 0.92)) !important;
          border-color: rgba(34, 211, 238, 0.35) !important;
        }
        .liquid-glass-pill {
          background: rgba(34, 211, 238, 0.13) !important;
          border-color: rgba(217, 70, 239, 0.45) !important;
          color: #a5f3fc !important;
        }
      `,
      petCss: `
        canvas {
          filter: drop-shadow(0 0 14px rgba(34, 211, 238, 0.5)) drop-shadow(0 0 24px rgba(217, 70, 239, 0.35)) !important;
        }
        .pet-speech-bubble {
          background: linear-gradient(135deg, rgba(12, 10, 30, 0.96), rgba(40, 12, 60, 0.95)) !important;
          border: 1px solid rgba(34, 211, 238, 0.6) !important;
        }
      `,
    })
  }
}
