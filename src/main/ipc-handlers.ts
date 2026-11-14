import { ipcMain, app, session } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { WindowManager } from './window-manager'
import { MuseClient, extractMuseSessionCookies, MUSE_PARTITION } from './muse-client'
import { SessionStore } from './session-store'
import { ProxyManager } from './proxy-manager'
import { LocalSecretary } from './local-secretary'
import { hostname } from 'node:os'
import { PcStatusBridge, pcAccount } from './pc-status-bridge'
import { HubServer, HUB_PORT } from './hub/hub-server'
import { SystemScreenApp, SYSTEM_SCREEN_APP_ID } from './hub/builtins/system-screen'
import type { HubEvent, LocalToolCall } from './hub/sdk-types'
import type {
  ChatMessage,
  MusePlugin,
  PendingSecretaryAction,
  PetBubblePayload,
  ProxyConfig,
} from '../types'

export function registerIpcHandlers(
  windowManager: WindowManager,
  museClient: MuseClient,
  sessionStore: SessionStore,
  proxyManager: ProxyManager
) {
  const localSecretary = new LocalSecretary()
  const systemScreenApp = new SystemScreenApp()
  /** Maps secretary approval-card ids → hub taskIds waiting on waitForApproval. */
  const hubApprovalByActionId = new Map<string, string>()
  const hub: HubServer = new HubServer({
    stateFilePath: path.join(app.getPath('userData'), 'hub_state.json'),
    executeTask: async (taskId: string, appId: string, toolId: string, params: any) => {
      try {
        if (appId === SYSTEM_SCREEN_APP_ID) {
          const result = await systemScreenApp.execute(toolId, params)
          hub.tasks.complete(taskId, result)
          return
        }
        hub.tasks.fail(taskId, { code: 'APP_UNREACHABLE', message: `${appId} 未连接，无法执行任务` })
      } catch (err: any) {
        hub.tasks.fail(taskId, { code: 'EXEC_ERROR', message: err?.message || String(err) })
      }
    },
    requestApproval: async (taskId: string, appId: string, toolId: string, params: any): Promise<boolean> => {
      const app = hub.registry.get(appId)
      const title = `${app?.manifest.name || appId} · ${toolId}`
      const pending = localSecretary.createPendingAction(
        'hub_tool',
        title,
        JSON.stringify(params ?? {}, null, 2),
        `本地软件「${app?.manifest.name || appId}」请求执行工具 ${toolId}。批准后由 Local Agent Hub 调度，不会运行 PowerShell。`,
        { hubAppId: appId, hubToolId: toolId }
      )
      hubApprovalByActionId.set(pending.id, taskId)
      const chatWin = windowManager.getChatWindow()
      if (chatWin && !chatWin.isDestroyed()) {
        chatWin.webContents.send('secretary:action-updated', pending)
      }
      try {
        const approved = await hub.waitForApproval(taskId)
        // HTTP approve/reject (or any non-UI resolver) leaves the card pending;
        // settle it here so a later Allow cannot fall through to PowerShell.
        const stillOpen = localSecretary.getPendingAction(pending.id)
        if (stillOpen?.status === 'pending') {
          localSecretary.settlePendingAction(
            pending.id,
            approved ? 'approved' : 'denied',
            approved
              ? '✓ 已批准，正在通过 Local Agent Hub 调度该工具。'
              : '用户已拒绝该 Local Agent Hub 工具调用。'
          )
        }
        return approved
      } finally {
        hubApprovalByActionId.delete(pending.id)
      }
    },
  })
  hub.start().catch((err: any) => console.error('[Hub] start failed:', err))
  hub.registry.register(systemScreenApp.manifest)
  hub.registry.markBuiltin(SYSTEM_SCREEN_APP_ID)

  hub.bus.subscribe('*', (event: HubEvent) => {
    const chatWin = windowManager.getChatWindow()
    if (chatWin && !chatWin.isDestroyed()) {
      chatWin.webContents.send('hub:event', event)
    }
    if (event.type === 'task.completed' || event.type === 'task.failed') {
      const app = hub.registry.get(String(event.sourceAppId))
      const appName = app?.manifest.name || String(event.sourceAppId)
      const text =
        event.type === 'task.completed'
          ? `✅ ${appName} 的任务完成了`
          : `⚠️ ${appName} 的任务失败了`
      sendPetBubble({
        id: `hub-${event.eventId}`,
        text,
        status: event.type === 'task.completed' ? 'done' : 'error',
        timestamp: Date.now(),
      })
      setTimeout(() => sendPetBubble(null), 6000)
    }
  })
  const pcLedgerPath = path.join(app.getPath('userData'), 'pc_status_ledger.json')
  const pcBridge = new PcStatusBridge({
    load: () => {
      try {
        const state = JSON.parse(fs.readFileSync(pcLedgerPath, 'utf8'))
        if (state.version === 1 && typeof state.account === 'string' && typeof state.enabled === 'boolean' && Array.isArray(state.tasks) && state.tasks.every((t: any) => t && typeof t.id === 'string' && typeof t.messageId === 'string' && typeof t.conversation === 'string' && ['queued', 'capturing', 'ready', 'sending', 'sent', 'cancelled'].includes(t.state) && (t.report === undefined || typeof t.report === 'string')) && Array.isArray(state.seen) && state.seen.every((id: unknown) => typeof id === 'string')) return state
      } catch { /* missing/corrupt state disables the bridge */ }
      return null
    },
    save: state => {
      fs.writeFileSync(pcLedgerPath + '.tmp', JSON.stringify(state), { mode: 0o600 })
      fs.renameSync(pcLedgerPath + '.tmp', pcLedgerPath)
    },
    account: () => pcAccount(sessionStore.getCookies()), device: hostname(),
    available: () => museClient.pcAvailable(),
    snapshot: () => localSecretary.getSystemSnapshot(),
    send: (report, conversation, account) => museClient.sendPcReport(report, conversation, account),
  })
  museClient.onPcObservation(o => pcBridge.observe(o))
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
  museClient.onCloudBrowserStatus((status) => {
    const chatWin = windowManager.getChatWindow()
    if (chatWin && !chatWin.isDestroyed()) {
      chatWin.webContents.send('cloud:browser-status', status)
    }
  })
  localSecretary.init()

  localSecretary.onStateUpdated((state) => {
    const chatWin = windowManager.getChatWindow()
    if (chatWin && !chatWin.isDestroyed()) {
      chatWin.webContents.send('secretary:state-updated', state)
    }
    const petWin = windowManager.getPetWindow()
    if (petWin && !petWin.isDestroyed()) {
      petWin.webContents.send('plugin:list-updated', state.plugins || [])
    }
  })

  localSecretary.onActionUpdated((action) => {
    const chatWin = windowManager.getChatWindow()
    if (chatWin && !chatWin.isDestroyed()) {
      chatWin.webContents.send('secretary:action-updated', action)
    }
    let changed = false
    messageHistory = messageHistory.map((m) => {
      if (m.pendingAction && m.pendingAction.id === action.id) {
        changed = true
        return { ...m, pendingAction: action }
      }
      return m
    })
    if (changed) {
      savePersistedHistory()
    }
  })

  // Helper to extract first PowerShell code block from assistant response
  const extractPowerShellCodeBlock = (text: string): string | null => {
    const match = text.match(/```(?:powershell|ps1|pwsh|cmd|bat|sh)\s*\n([\s\S]*?)```/i)
    return match && match[1] ? match[1].trim() : null
  }

  // Helper to run pre-flight read-only secretary actions or attach write-intent instructions
  const enrichWithLocalSecretary = async (
    rawContent: string
  ): Promise<{
    promptForMuse: string
    userAttachments?: ChatMessage['attachments']
    imageOptions?: { imageBase64: string; imageMimeType: string; imageFileName: string }
    expectsWriteApproval?: boolean
    writeActionTitle?: string
    directPendingAction?: PendingSecretaryAction
    appliedPlugin?: MusePlugin
  }> => {
    const trimmed = rawContent.trim()

    // 0. Reset UI / Plugins (`/reset-ui` or natural language asking to restore default UI)
    if (
      /^\/reset-ui(\s+|$)/i.test(trimmed) ||
      (!trimmed.startsWith('/') &&
        /(恢复默认|重置|还原|清空).*(界面|主题|样式|页面|插件)/i.test(trimmed))
    ) {
      localSecretary.resetAllPlugins()
      return {
        promptForMuse: `${rawContent}\n\n[MUSE_LOCAL_CONTEXT]\n系统已执行 \`resetAllPlugins()\`，清空了所有自定义主题与页面挂件插件，将终端与桌宠恢复为默认初始界面。请向用户确认已恢复默认界面。\n[/MUSE_LOCAL_CONTEXT]`,
      }
    }

    // 0.5 Self-Modifying UI & Live Plugin Engine (`/plugin <req>` or natural language asking to modify UI/theme/pet or add widgets like alarm clock)
    const isPluginSlash = /^\/(plugin|ui)\s+/i.test(trimmed)
    const isSelfModifyNL =
      !trimmed.startsWith('/') &&
      (/(修改|改一下|换个|换成|切换|定制|美化|调整|装修).*(终端|界面|页面|主题|配色|背景|样式|字体|边框|桌宠|宠物|气泡|外观|呈现)/i.test(
        trimmed
      ) ||
        /(加一个|增加一个|挂载|加个|做一个|弄一个|新增一个|添加).*(小闹钟|闹钟|倒计时|计时器|秒表|时钟|便签|备忘贴|小组件|挂件|插件|小功能|状态栏)/i.test(
          trimmed
        ) ||
        /(赛博朋克|黑客帝国|樱花粉|复古琥珀).*(主题|风格|界面|终端)/i.test(trimmed))

    if (isPluginSlash || isSelfModifyNL) {
      const reqBody = isPluginSlash ? trimmed.replace(/^\/(plugin|ui)\s+/i, '').trim() : trimmed
      const synthesized = localSecretary.synthesizePluginFromRequest(reqBody)
      return {
        promptForMuse: `${rawContent}\n\n[MUSE_LOCAL_CONTEXT]\n【Muse Pet 自进化界面与插件引擎已即时热加载】\n- 已生成并激活插件: 「${synthesized.name}」 (${synthesized.category})\n- 插件效果说明: ${synthesized.description}\n如果你希望进一步微调样式或功能，也可以在回复中附带 \`\`\`muse-plugin\n{"name":"...","category":"theme|widget|pet","chatCss":"...","chatHtml":"...","chatJs":"...","petCss":"..."}\n\`\`\` 代码块。\n请以灵动自豪的口吻告诉用户：我已经直接帮你修改好 Muse Pet 的界面/挂载好该小功能并立即生效啦！同时提醒他可以通过下方的【插件热加载控制卡】随时一键停用、查看或回滚默认。\n[/MUSE_LOCAL_CONTEXT]`,
        appliedPlugin: synthesized,
      }
    }

    // 1. Explicit `/ps <cmd>` -> directly create a pending authorization action without waiting
    if (/^\/ps\s+/i.test(trimmed)) {
      const cmd = trimmed.replace(/^\/ps\s+/i, '').trim()
      const pending = localSecretary.createPendingAction(
        'powershell',
        '执行自定义 PowerShell 命令',
        cmd,
        '写操作 / 系统命令必审：请确认是否允许在当前电脑执行该 PowerShell 指令'
      )
      return {
        promptForMuse: `${rawContent}\n\n[MUSE_LOCAL_CONTEXT]\n用户请求在本地执行 PowerShell 命令: \`${cmd}\`。系统已在终端弹出 [批准执行 / 拒绝] 授权卡片，请简短告知用户确认后即可执行，并说明该命令的作用。\n[/MUSE_LOCAL_CONTEXT]`,
        directPendingAction: pending,
      }
    }

    // 2. Gmail filter & summary (`/gmail ...` or natural language mentioning gmail/邮箱/筛选邮件)
    const isGmailCmd = /^\/gmail(\s+|$)/i.test(trimmed)
    const isGmailNL =
      !trimmed.startsWith('/') &&
      /(gmail|谷歌邮箱|邮箱|邮件)/i.test(trimmed) &&
      /(打开|筛选|查看|搜索|未读|查一下|看看|总结|汇总|发件人)/i.test(trimmed)

    if (isGmailCmd || isGmailNL) {
      const filterExpr = isGmailCmd ? trimmed.replace(/^\/gmail\s*/i, '').trim() : trimmed
      const res = await localSecretary.openAndInspectGmail(filterExpr || 'in:inbox', true)
      return {
        promptForMuse: `${rawContent}\n\n[MUSE_LOCAL_CONTEXT]\n【本地电脑小秘书已自动执行 Gmail 筛选】\n- 搜索条件: ${res.gmailSearchQuery}\n- 打开链接: ${res.searchUrl}\n- 抓取结果:\n${res.summaryText}\n请以贴心小秘书的口吻，向用户汇报已帮他打开对应的 Gmail 筛选页面，并根据上述抓取到的邮件列表（如有）提炼重点摘要或待办建议。\n[/MUSE_LOCAL_CONTEXT]`,
      }
    }

    // 3. Desktop Screenshot & Vision (`/screen ...` or natural language asking to look at screen/desktop)
    const isScreenCmd = /^\/screen(\s+|$)/i.test(trimmed)
    const isScreenNL =
      !trimmed.startsWith('/') &&
      /(看看|看下|截屏|截图|分析|检查).*(当前|现在|我的)?(屏幕|桌面|窗口|画面|报错)/i.test(trimmed)

    if (isScreenCmd || isScreenNL) {
      const userPrompt = isScreenCmd
        ? trimmed.replace(/^\/screen\s*/i, '').trim() || '帮我看看我现在的电脑屏幕上是什么内容，有没有需要注意的信息？'
        : trimmed
      const shot = await localSecretary.captureDesktopScreen()
      return {
        promptForMuse: userPrompt,
        userAttachments: [{ type: 'image', url: shot.fileUrl, title: `当前桌面截屏 (${shot.width}×${shot.height})` }],
        imageOptions: {
          imageBase64: shot.base64Data,
          imageMimeType: 'image/png',
          imageFileName: 'desktop-screen.png',
        },
      }
    }

    // 4. Web open & inspect (`/web ...`)
    if (/^\/web\s+/i.test(trimmed)) {
      const target = trimmed.replace(/^\/web\s+/i, '').trim()
      const webRes = await localSecretary.openAndInspectWeb(target, true)
      return {
        promptForMuse: `${rawContent}\n\n[MUSE_LOCAL_CONTEXT]\n【本地电脑小秘书已打开网页】\n- URL: ${webRes.url}\n- 页面标题: ${webRes.title}\n- 页面正文摘录: ${webRes.excerpt || '（已在系统默认浏览器打开）'}\n请向用户确认已打开该网页，并根据正文摘录给出简短重点总结。\n[/MUSE_LOCAL_CONTEXT]`,
      }
    }

    // 5. System status snapshot (`/sys` or natural language asking computer CPU/memory/port/process status)
    const isSysCmd = /^\/sys(\s+|$)/i.test(trimmed)
    const isSysNL =
      !trimmed.startsWith('/') &&
      /(电脑|系统|本地|当前).*(状态|内存|cpu|负载|卡不卡|运行情况|高占用进程)/i.test(trimmed)

    if (isSysCmd || isSysNL) {
      const snap = await localSecretary.getSystemSnapshot()
      pcBridge.skipLocallyHandled(rawContent)
      return {
        promptForMuse: `${rawContent}\n\n[MUSE_LOCAL_CONTEXT]\n【当前电脑实时硬件与进程状态】\n${snap}\n请根据以上真实本地数据，向用户汇报当前电脑运行健康度与高占用进程情况。\n[/MUSE_LOCAL_CONTEXT]`,
      }
    }

    // 6. Clipboard butler (`/clip` or natural language asking to read clipboard)
    const isClipCmd = /^\/clip(\s+|$)/i.test(trimmed)
    const isClipNL =
      !trimmed.startsWith('/') && /(读取|看看|解释|翻译|总结|分析).*(剪贴板|刚刚?复制)/i.test(trimmed)

    if (isClipCmd || isClipNL) {
      const clipText = localSecretary.readClipboardText()
      return {
        promptForMuse: `${rawContent}\n\n[MUSE_LOCAL_CONTEXT]\n【当前系统剪贴板内容】\n${clipText ? clipText.slice(0, 3500) : '（当前剪贴板为空或非文本）'}\n请根据剪贴板中的真实内容回答用户的请求。\n[/MUSE_LOCAL_CONTEXT]`,
      }
    }

    // 7. File search & read (`/find <kw>`, `/read <path>`)
    if (/^\/find\s+/i.test(trimmed)) {
      const kw = trimmed.replace(/^\/find\s+/i, '').trim()
      const found = localSecretary.searchLocalFiles(kw)
      return {
        promptForMuse: `${rawContent}\n\n[MUSE_LOCAL_CONTEXT]\n【本地桌面/下载/文档目录搜索 "${kw}" 结果】\n${found.length > 0 ? found.join('\n') : '未找到匹配文件'}\n请向用户清晰列出找到的文件路径。\n[/MUSE_LOCAL_CONTEXT]`,
      }
    }

    if (/^\/read\s+/i.test(trimmed)) {
      const targetPath = trimmed.replace(/^\/read\s+/i, '').trim()
      try {
        const fileRes = localSecretary.readLocalFileExcerpt(targetPath)
        return {
          promptForMuse: `${rawContent}\n\n[MUSE_LOCAL_CONTEXT]\n【本地文件 ${fileRes.resolvedPath} 内容】\n${fileRes.content}\n请基于该文件的真实内容进行总结或解答。\n[/MUSE_LOCAL_CONTEXT]`,
        }
      } catch (e: any) {
        return {
          promptForMuse: `${rawContent}\n\n[MUSE_LOCAL_CONTEXT]\n读取本地文件失败: ${e.message}\n[/MUSE_LOCAL_CONTEXT]`,
        }
      }
    }


    // 12. Mutating / Write / Shell operations in natural language -> ask Luna to output a ```powershell``` block so we can gate it with an approval card
    const isWriteIntent =
      !trimmed.startsWith('/') &&
      /(帮我|在本地|替我|执行|运行|清理|杀掉|结束进程|关闭端口|整理桌面|新建文件|移动文件|删除|修改配置|写一段.*脚本)/i.test(
        trimmed
      )

    if (isWriteIntent) {
      return {
        promptForMuse: `${rawContent}\n\n[MUSE_LOCAL_CONTEXT]\n你是用户的 Windows 电脑小秘书。若该请求涉及修改文件、结束进程、清理端口或执行系统操作，请在回复中给出一个完整的 \`\`\`powershell ... \`\`\` 代码块（单段可直接运行的非交互式 PowerShell 脚本）。Muse Pet 终端会自动为你的代码块生成 [批准执行 / 拒绝] 授权按钮供用户一键安全执行。\n[/MUSE_LOCAL_CONTEXT]`,
        expectsWriteApproval: true,
        writeActionTitle: trimmed.slice(0, 36),
      }
    }

    // 13. Muse Local Agent Hub — expose integrated third-party capabilities to Luna
    const hubTools = hub.describeToolsForLuna()
    if (hubTools) {
      return {
        promptForMuse: `${rawContent}\n\n[MUSE_LOCAL_TOOLS]\n${hubTools}\n只有当用户明确需要操作或查询这些本地软件时才调用；否则忽略本段。\n[/MUSE_LOCAL_TOOLS]`,
      }
    }

    return { promptForMuse: rawContent }
  }

  /** Detect and execute a `local_tool` instruction emitted by Luna. */
  const extractLocalToolCall = (text: string): LocalToolCall | null => {
    if (!text) return null
    const fence = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i)
    const candidates = [fence?.[1], text]
    for (const candidate of candidates) {
      if (!candidate) continue
      const match = candidate.match(/\{[^{}]*"action"\s*:\s*"local_tool"[^{}]*\}/i)
      if (!match) continue
      try {
        const parsed = JSON.parse(match[0])
        if (parsed.action === 'local_tool' && parsed.appId && parsed.toolId) {
          return {
            action: 'local_tool',
            appId: String(parsed.appId),
            toolId: String(parsed.toolId),
            parameters: parsed.parameters && typeof parsed.parameters === 'object' ? parsed.parameters : {},
          }
        }
      } catch {
        /* keep looking */
      }
    }
    return null
  }

  /**
   * Run a Luna-requested local tool and return a compact text summary that can
   * be sent back into the same Muse conversation.
   */
  const runLocalToolCall = async (call: LocalToolCall): Promise<string> => {
    try {
      if (call.appId === SYSTEM_SCREEN_APP_ID) {
        const result = await systemScreenApp.execute(call.toolId, call.parameters || {})
        return `[MUSE_LOCAL_TOOL_RESULT appId=${call.appId} toolId=${call.toolId}]
${result.note || ''}
画面尺寸: ${result.width}×${result.height}
采集时间: ${new Date(result.capturedAt || Date.now()).toISOString()}
图像数据已随本条消息的多模态附件提交，请直接查看画面并回答用户。`
      }

      const res = await hub.dispatch({
        appId: call.appId,
        toolId: call.toolId,
        parameters: call.parameters || {},
        origin: 'luna',
      })
      return `[MUSE_LOCAL_TOOL_RESULT appId=${call.appId} toolId=${call.toolId} taskId=${res.taskId}]
任务已创建，状态: ${res.status}。完成后结果会自动汇报。`
    } catch (err: any) {
      return `[MUSE_LOCAL_TOOL_ERROR appId=${call.appId} toolId=${call.toolId}]
${err?.message || String(err)}`
    }
  }

  // Receive background cloud message updates (e.g., from muse.ai web, media attachments, or initial cloud history)
  museClient.onCloudMessagesUpdated((cloudMessages, newAssistantMsg) => {
    if (cloudMessages.length > 0) {
      const hadNewAssistant =
        newAssistantMsg &&
        !messageHistory.some(
          (m) =>
            m.id === newAssistantMsg.id ||
            (m.role === 'assistant' &&
              m.content === newAssistantMsg.content &&
              (m.attachments?.length || 0) === (newAssistantMsg.attachments?.length || 0))
        )

      // Preserve any pendingAction, appliedPlugin, or local screenshot attachments on matching messages
      const existingActionsByContent = new Map<string, PendingSecretaryAction>()
      const existingPluginsByContent = new Map<string, MusePlugin>()
      const existingUserAttachments = new Map<string, ChatMessage['attachments']>()
      for (const oldMsg of messageHistory) {
        if (oldMsg.pendingAction) {
          existingActionsByContent.set(oldMsg.content.trim(), oldMsg.pendingAction)
        }
        if (oldMsg.appliedPlugin) {
          existingPluginsByContent.set(oldMsg.content.trim(), oldMsg.appliedPlugin)
        }
        if (oldMsg.role === 'user' && oldMsg.attachments && oldMsg.attachments.length > 0) {
          existingUserAttachments.set(oldMsg.content.trim(), oldMsg.attachments)
        }
      }

      messageHistory = cloudMessages.map((cm) => {
        const pendingAction =
          cm.pendingAction || existingActionsByContent.get(cm.content.trim())
        const appliedPlugin =
          cm.appliedPlugin || existingPluginsByContent.get(cm.content.trim())
        const attachments =
          cm.attachments && cm.attachments.length > 0
            ? cm.attachments
            : existingUserAttachments.get(cm.content.trim())
        return {
          ...cm,
          ...(pendingAction ? { pendingAction } : {}),
          ...(appliedPlugin ? { appliedPlugin } : {}),
          ...(attachments ? { attachments } : {}),
        }
      })
      savePersistedHistory()
      broadcastMessagesSynced()

      if (hadNewAssistant && newAssistantMsg && !museClient.isChatTurnActive()) {
        const isChatHidden = !windowManager.isChatWindowVisible()
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
    if (windowManager.isChatWindowVisible()) {
      unreadCount = 0
    }
  })

  ipcMain.on('pet:dismiss-bubble', () => {
    unreadCount = 0
    sendPetBubble(null)
  })

  ipcMain.on('pet:set-ignore-mouse-events', (_event, ignore: boolean) => {
    const win = windowManager.getPetWindow()
    if (win && !win.isDestroyed()) {
      win.setIgnoreMouseEvents(ignore, { forward: true })
    }
  })

  ipcMain.handle('pet:get-position', () => {
    const win = windowManager.getPetWindow()
    if (win && !win.isDestroyed()) {
      const [x, y] = win.getPosition()
      return { x, y }
    }
    return { x: 0, y: 0 }
  })

  ipcMain.on('pet:set-position', (_event, pos: { x: number; y: number }) => {
    const win = windowManager.getPetWindow()
    if (win && !win.isDestroyed() && typeof pos?.x === 'number' && typeof pos?.y === 'number') {
      win.setPosition(Math.round(pos.x), Math.round(pos.y))
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
    if (sessionStore.getProfile().isLoggedIn) {
      const hasAnyAttachments = messageHistory.some((m) => (m.attachments?.length || 0) > 0)
      if (messageHistory.length === 0 || !hasAnyAttachments) {
        const cloud = await museClient.fetchCloudMessages(false)
        if (cloud.length > 0) {
          messageHistory = cloud
          savePersistedHistory()
        }
      }
    }
    return messageHistory
  })

  ipcMain.handle('chat:sync-messages', async () => {
    if (sessionStore.getProfile().isLoggedIn) {
      museClient.syncAvatarAssets(true).catch(() => {})
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
    const pcReply = pcBridge.command(content)
    if (pcReply !== null) {
      // Local commands never enter the cloud composer or secretary prompt enrichment.
      messageHistory.push({ id: bubbleId + '-pc', role: 'assistant', content: pcReply, timestamp: Date.now() })
      savePersistedHistory()
      chatWin?.webContents.send('chat:stream-end', pcReply)
      return
    }

    // Run LocalSecretary pre-flight inspection or attachment preparation
    let enriched: Awaited<ReturnType<typeof enrichWithLocalSecretary>>
    try {
      enriched = await enrichWithLocalSecretary(content)
    } catch (e: any) {
      enriched = { promptForMuse: content }
    }

    // Record user message (preserving clean user content + any local screenshot attachment)
    const userMsg: ChatMessage = {
      id: bubbleId + '-u',
      role: 'user',
      content,
      attachments: enriched.userAttachments,
      timestamp: Date.now(),
    }
    messageHistory.push(userMsg)
    savePersistedHistory()
    if (enriched.userAttachments && enriched.userAttachments.length > 0) {
      broadcastMessagesSynced()
    }

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
      enriched.promptForMuse,
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

        // Check if a pending secretary action should be attached (either direct `/ps` or extracted PowerShell block)
        let pendingAction = enriched.directPendingAction
        if (!pendingAction && finalContent) {
          const psBlock = extractPowerShellCodeBlock(finalContent)
          if (psBlock) {
            pendingAction = localSecretary.createPendingAction(
              'powershell',
              enriched.writeActionTitle || '执行 Luna 生成的本地 PowerShell 脚本',
              psBlock,
              '写操作 / 脚本执行必审：请确认命令无误后点击 [批准执行]'
            )
          }
        }

        // Muse Local Agent Hub: Luna requested a local tool call — run it and feed the result back
        const localToolCall = extractLocalToolCall(finalContent)
        if (localToolCall) {
          void (async () => {
            if (localToolCall.appId === SYSTEM_SCREEN_APP_ID && localToolCall.toolId === 'capture') {
              try {
                const shot = await localSecretary.captureDesktopScreen()
                messageHistory.push({
                  id: bubbleId + '-hub-screen',
                  role: 'user',
                  content: '[MUSE_LOCAL_TOOL_RESULT] 已按 Luna 请求截取当前桌面画面，请查看并回答。',
                  attachments: [{ type: 'image', url: shot.fileUrl, title: '云浏览器请求的桌面截屏' }],
                  timestamp: Date.now(),
                })
                savePersistedHistory()
                broadcastMessagesSynced()
                await museClient.sendChatMessage(
                  '[MUSE_LOCAL_TOOL_RESULT appId=system.screen toolId=capture] 这是用户电脑当前桌面的真实截图，请基于画面内容回答用户之前的问题。',
                  () => {},
                  () => {},
                  () => {},
                  {
                    imageBase64: shot.base64Data,
                    imageMimeType: 'image/png',
                    imageFileName: 'hub-screen.png',
                  }
                )
              } catch (err: any) {
                await museClient.sendChatMessage(
                  `[MUSE_LOCAL_TOOL_ERROR appId=system.screen] 截屏失败: ${err?.message || err}`,
                  () => {},
                  () => {},
                  () => {},
                  {}
                )
              }
              return
            }

            const summary = await runLocalToolCall(localToolCall)
            messageHistory.push({
              id: bubbleId + '-hub',
              role: 'user',
              content: summary,
              timestamp: Date.now(),
            })
            savePersistedHistory()
            broadcastMessagesSynced()
            await museClient.sendChatMessage(summary, () => {}, () => {}, () => {}, {})
          })()
        }

        // Check if Luna emitted a custom ```muse-plugin``` JSON block or if pre-flight synthesized one
        let appliedPlugin = enriched.appliedPlugin
        if (finalContent) {
          const extractedPlugin = localSecretary.extractPluginFromText(finalContent)
          if (extractedPlugin) {
            appliedPlugin = extractedPlugin
          }
        }

        if (chatWin && !chatWin.isDestroyed()) {
          chatWin.webContents.send('chat:stream-end', finalContent)
        }
        if (finalContent) {
          messageHistory.push({
            id: bubbleId + '-a',
            role: 'assistant',
            content: finalContent,
            pendingAction,
            appliedPlugin,
            timestamp: Date.now(),
            status: 'done',
          })
          savePersistedHistory()
          if (pendingAction || appliedPlugin) {
            broadcastMessagesSynced()
          }

          const isChatHidden = !windowManager.isChatWindowVisible()
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
      },
      enriched.imageOptions
    )
  })

  // Local Secretary Agent IPC handlers
  ipcMain.handle('secretary:approve-action', async (_event, actionId: string) => {
    const hubTaskId = hubApprovalByActionId.get(actionId)
    if (hubTaskId) {
      hub.resolveApproval(hubTaskId, true)
      return localSecretary.settlePendingAction(
        actionId,
        'approved',
        '✓ 已批准，正在通过 Local Agent Hub 调度该工具。'
      )
    }
    return await localSecretary.approveAction(actionId)
  })

  ipcMain.handle('secretary:deny-action', (_event, actionId: string) => {
    const hubTaskId = hubApprovalByActionId.get(actionId)
    if (hubTaskId) {
      hub.resolveApproval(hubTaskId, false)
      return localSecretary.settlePendingAction(
        actionId,
        'denied',
        '用户已拒绝该 Local Agent Hub 工具调用。'
      )
    }
    return localSecretary.denyAction(actionId)
  })

  ipcMain.handle(
    'secretary:run-command',
    async (_event, payload: { title: string; command: string }) => {
      return await localSecretary.runDirectApprovedCommand(payload.title, payload.command)
    }
  )

  ipcMain.handle('secretary:capture-screen-and-ask', async (_event, prompt?: string) => {
    const askText = `/screen ${prompt || '帮我看看现在的桌面屏幕内容'}`
    // Reuse chat:send-message flow
    const chatWin = windowManager.getChatWindow()
    if (chatWin && !chatWin.isDestroyed()) {
      // Trigger via renderer or directly invoke send
    }
    return askText
  })

  ipcMain.handle('secretary:open-gmail-filter', async (_event, filterQuery: string) => {
    await localSecretary.openAndInspectGmail(filterQuery || 'in:inbox', true)
  })

  ipcMain.handle('secretary:get-state', () => {
    return localSecretary.getState()
  })

  // Self-Modifying UI & Live Plugin IPC handlers
  ipcMain.handle('plugin:get-list', () => {
    return localSecretary.getPlugins()
  })

  ipcMain.handle('secretary:install-plugin', (_event, pluginInput: any) => {
    localSecretary.installOrUpdatePlugin(pluginInput)
    return localSecretary.getState()
  })

  ipcMain.handle('secretary:toggle-plugin', (_event, id: string) => {
    return localSecretary.togglePlugin(id)
  })

  ipcMain.handle('secretary:remove-plugin', (_event, id: string) => {
    return localSecretary.removePlugin(id)
  })

  ipcMain.handle('secretary:reset-plugins', () => {
    return localSecretary.resetAllPlugins()
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
    pcBridge.bind('')
    sessionStore.clear()
    museClient.clearCloudBrowserStatus()
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

  // Chat Window Resizing & Bounds Control
  ipcMain.handle('chat:get-bounds', () => {
    return windowManager.getChatBounds()
  })

  ipcMain.handle('chat:set-bounds', (_event, bounds: Partial<{ x: number; y: number; width: number; height: number }>) => {
    return windowManager.setChatBounds(bounds)
  })

  ipcMain.handle('chat:reset-bounds', () => {
    return windowManager.resetChatBounds()
  })

  // Muse Cloud Hub & Native Console
  ipcMain.handle('cloud:get-snapshot', async (_event, forceRefresh?: boolean) => {
    return await museClient.fetchCloudSnapshot(Boolean(forceRefresh))
  })

  ipcMain.handle('cloud:read-file', async (_event, fileName: string) => {
    return await museClient.readCloudFile(String(fileName || 'MEMORY.md'))
  })

  ipcMain.handle('cloud:open-console', async (_event, target?: any) => {
    return await museClient.openCloudConsole(target || 'main')
  })

  ipcMain.handle('cloud:open-browser', async (_event, identity) => {
    return await museClient.openCloudBrowser(identity)
  })

  ipcMain.handle('cloud:get-browser-status', async () => {
    return await museClient.pollCloudBrowserStatus(true)
  })

  // ---------------------------------------------------------------------------
  // Muse Local Agent Hub — third-party integration API surface
  // ---------------------------------------------------------------------------

  ipcMain.handle('hub:get-state', async () => {
    return {
      port: HUB_PORT,
      apps: hub.registry.list().map((a: any) => ({
        appId: a.manifest.appId,
        name: a.manifest.name,
        version: a.manifest.version,
        description: a.manifest.description,
        online: a.online,
        activeTasks: a.activeTasks,
        lastHeartbeat: a.lastHeartbeat,
        builtin: hub.registry.isBuiltin(a.manifest.appId) || a.manifest.appId === SYSTEM_SCREEN_APP_ID,
        tools: a.manifest.tools.map((t: any) => ({
          toolId: t.toolId,
          name: t.name,
          description: t.description,
          category: t.category,
          riskLevel: t.riskLevel,
          trusted: hub.registry.isTrusted(a.manifest.appId, t.toolId),
        })),
      })),
      tasks: hub.tasks.list().slice(0, 50),
      toolSummary: hub.describeToolsForLuna(),
    }
  })

  ipcMain.handle('hub:dispatch', async (_event, call: LocalToolCall) => {
    try {
      const res = await hub.dispatch({
        appId: call.appId,
        toolId: call.toolId,
        parameters: call.parameters || {},
        origin: 'user',
      })
      return { ok: true, ...res }
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
  })

  ipcMain.handle('hub:trust-tool', async (_event, appId: string, toolId: string, trusted: boolean) => {
    if (trusted) hub.trustTool(appId, toolId)
    else hub.untrustTool(appId, toolId)
    return { ok: true }
  })

  ipcMain.handle('hub:run-tool', async (_event, appId: string, toolId: string, params: any) => {
    try {
      if (appId === SYSTEM_SCREEN_APP_ID) {
        const result = await systemScreenApp.execute(toolId, params || {})
        return { ok: true, result }
      }
      const res = await hub.dispatch({ appId, toolId, parameters: params || {}, origin: 'user' })
      return { ok: true, ...res }
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
  })

  ipcMain.handle('hub:cancel-task', async (_event, taskId: string) => {
    const task = hub.tasks.cancel(taskId, 'cancelled from terminal')
    return { ok: !!task }
  })

  ipcMain.handle('hub:remove-app', async (_event, appId: string) => {
    if (!appId || typeof appId !== 'string') {
      return { ok: false, error: 'invalid appId' }
    }
    if (appId === SYSTEM_SCREEN_APP_ID) {
      return { ok: false, error: '内置应用不可移除' }
    }
    const existed = hub.registry.get(appId)
    if (!existed) {
      return { ok: false, error: '应用未注册' }
    }
    hub.removeApp(appId)
    return { ok: true }
  })

  // App quit
  ipcMain.on('app:quit', () => {
    app.quit()
  })
}
