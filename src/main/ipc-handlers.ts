import { ipcMain, app, session } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { WindowManager } from './window-manager'
import { MuseClient, extractMuseSessionCookies, MUSE_PARTITION } from './muse-client'
import { SessionStore } from './session-store'
import { ProxyManager } from './proxy-manager'
import { LocalSecretary } from './local-secretary'
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

    return { promptForMuse: rawContent }
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
    return await localSecretary.approveAction(actionId)
  })

  ipcMain.handle('secretary:deny-action', (_event, actionId: string) => {
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

  ipcMain.handle('cloud:get-browser-status', async () => {
    return await museClient.pollCloudBrowserStatus(true)
  })

  // App quit
  ipcMain.on('app:quit', () => {
    app.quit()
  })
}
