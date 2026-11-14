import React, { useState, useEffect, useRef } from 'react'
import type {
  ChatMessage,
  UserProfile,
  ProxyConfig,
  NetworkTestResult,
  SecretaryState,
  MuseCloudSnapshot,
  MuseCloudConsoleTarget,
  MuseCloudBrowserStatus,
  MuseHubState,
  MuseHubEvent,
} from '../../types'
import {
  Square,
  Sparkles,
  X,
  LogIn,
  Bot,
  ExternalLink,
  Copy,
  Check,
  Code,
  Wifi,
  Key,
  Globe,
  Loader2,
  CornerDownLeft,
  Terminal,
  ShieldAlert,
  Play,
  Camera,
  Mail,
  Cpu,
  Trash2,
  Cloud,
  RefreshCw,
  FileText,
  Folder,
  Clock,
  Target,
  Lightbulb,
  Cpu as CpuIcon,
  Plug,
} from 'lucide-react'

function formatHubRelativeTime(ts: number): string {
  if (!ts) return '未知'
  const delta = Date.now() - ts
  if (delta < 15_000) return '刚刚'
  if (delta < 60_000) return `${Math.max(1, Math.floor(delta / 1000))} 秒前`
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`
  return `${Math.floor(delta / 86_400_000)} 天前`
}

function formatHubTaskStatus(status: string): string {
  switch (status) {
    case 'pending':
      return '排队中'
    case 'awaiting_approval':
      return '待批准'
    case 'running':
      return '运行中'
    case 'paused':
      return '已暂停'
    case 'completed':
      return '已完成'
    case 'failed':
      return '失败'
    case 'cancelled':
      return '已取消'
    default:
      return status
  }
}

function formatHubTaskOrigin(origin: string): string {
  if (origin === 'luna') return 'Luna'
  if (origin === 'system') return '系统'
  return '用户'
}

// Lightweight Markdown & Code Block Formatter in Liquid Glass Terminal style
function MarkdownContent({
  content,
  isStreaming,
  onRunCodeBlock,
}: {
  content: string
  isStreaming?: boolean
  onRunCodeBlock?: (code: string, lang: string) => void
}) {
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null)
  const [runningIndex, setRunningIndex] = useState<number | null>(null)

  const handleCopy = (text: string, index: number) => {
    navigator.clipboard.writeText(text)
    setCopiedIndex(index)
    setTimeout(() => setCopiedIndex(null), 2000)
  }

  const handleRun = async (code: string, lang: string, index: number) => {
    if (!onRunCodeBlock) return
    setRunningIndex(index)
    try {
      await onRunCodeBlock(code, lang)
    } finally {
      setRunningIndex(null)
    }
  }

  const parts = content.split(/(```[\s\S]*?```)/g)

  return (
    <div className="space-y-2.5 text-[13.5px] leading-relaxed text-slate-100/95">
      {parts.map((part, index) => {
        if (part.startsWith('```') && part.endsWith('```')) {
          const firstLineEnd = part.indexOf('\n')
          const language = firstLineEnd !== -1 ? part.slice(3, firstLineEnd).trim() : ''
          const code = firstLineEnd !== -1 ? part.slice(firstLineEnd + 1, -3) : part.slice(3, -3)
          const isRunnableShell = /^(powershell|ps1|pwsh|shell|sh|cmd|bat|bash|)$/i.test(language)

          return (
            <div
              key={index}
              className="my-2 rounded-xl bg-slate-950/65 border border-white/15 shadow-inner overflow-hidden text-xs"
            >
              <div className="flex items-center justify-between px-3 py-1.5 bg-white/[0.06] border-b border-white/10 text-slate-300">
                <span className="flex items-center gap-1.5 font-terminal text-[11px] text-sky-300">
                  <Code className="w-3.5 h-3.5 text-sky-400" />
                  {language || 'shell'}
                </span>
                <div className="flex items-center gap-2.5">
                  {isRunnableShell && onRunCodeBlock && (
                    <button
                      onClick={() => handleRun(code, language, index)}
                      disabled={runningIndex === index}
                      title="批准并在本地 PowerShell 执行此脚本"
                      className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-500/20 border border-emerald-400/40 text-emerald-200 hover:bg-emerald-500/35 transition-colors font-terminal text-[10.5px]"
                    >
                      {runningIndex === index ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <Play className="w-3 h-3 fill-emerald-300" />
                      )}
                      <span>本地执行</span>
                    </button>
                  )}
                  <button
                    onClick={() => handleCopy(code, index)}
                    className="flex items-center gap-1 hover:text-white transition-colors font-terminal text-[11px]"
                  >
                    {copiedIndex === index ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                        <span className="text-emerald-400">copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span>copy</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
              <pre className="p-3 overflow-x-auto text-sky-100 font-terminal text-xs whitespace-pre-wrap selection:bg-sky-500/30">
                <code>{code}</code>
              </pre>
            </div>
          )
        }

        const paragraphs = part.split('\n\n')
        return (
          <React.Fragment key={index}>
            {paragraphs.map((p, pIdx) => {
              const lines = p.split('\n')
              const isLastParagraph = index === parts.length - 1 && pIdx === paragraphs.length - 1
              return (
                <p key={pIdx} className="whitespace-pre-wrap">
                  {lines.map((line, lIdx) => (
                    <React.Fragment key={lIdx}>
                      {line}
                      {lIdx < lines.length - 1 && <br />}
                    </React.Fragment>
                  ))}
                  {isStreaming && isLastParagraph && (
                    <span className="ml-1 animate-terminal-cursor" />
                  )}
                </p>
              )
            })}
          </React.Fragment>
        )
      })}
    </div>
  )
}

export default function ChatApp() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [browserErrors, setBrowserErrors] = useState<Record<string, string>>({})
  const [openingBrowser, setOpeningBrowser] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [authProfile, setAuthProfile] = useState<UserProfile>({ isLoggedIn: false })
  const [showSettings, setShowSettings] = useState(false)
  const [isCompact, setIsCompact] = useState(false)
  const [winBounds, setWinBounds] = useState<{ width: number; height: number }>({
    width: 640,
    height: 560,
  })
  const preZoomSizeRef = useRef<{ width: number; height: number } | null>(null)
  const [previewMedia, setPreviewMedia] = useState<{
    type: 'image' | 'video'
    url: string
    title?: string
  } | null>(null)

  // Terminal appearance configuration (default: 100% solid obsidian black, user-configurable)
  const [appearance, setAppearance] = useState<{
    preset: 'obsidian' | 'carbon' | 'crystal'
    opacity: number
  }>(() => {
    try {
      const saved = localStorage.getItem('muse_terminal_appearance')
      if (saved) {
        const parsed = JSON.parse(saved)
        if (typeof parsed.opacity === 'number') return parsed
      }
    } catch {
      // ignore
    }
    return { preset: 'obsidian', opacity: 100 }
  })

  const updateAppearance = (next: { preset: 'obsidian' | 'carbon' | 'crystal'; opacity: number }) => {
    setAppearance(next)
    try {
      localStorage.setItem('muse_terminal_appearance', JSON.stringify(next))
    } catch {
      // ignore
    }
  }

  // Command history for Up/Down arrow navigation
  const [cmdHistory, setCmdHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState<number>(-1)

  // Settings state
  const [proxyConfig, setProxyConfig] = useState<ProxyConfig>({
    mode: 'system',
    customRules: 'http://127.0.0.1:7890',
  })
  const [testResult, setTestResult] = useState<NetworkTestResult | null>(null)
  const [isTestingNet, setIsTestingNet] = useState(false)
  const [manualCookie, setManualCookie] = useState('')
  const [cookieSavedToast, setCookieSavedToast] = useState(false)

  // Plugin state
  const [secretaryState, setSecretaryState] = useState<SecretaryState | null>(null)

  // Muse Cloud Hub (/cloud) state
  const [showCloudHub, setShowCloudHub] = useState(false)
  const [showHubPanel, setShowHubPanel] = useState(false)
  const [hubState, setHubState] = useState<MuseHubState | null>(null)
  const [isLoadingHub, setIsLoadingHub] = useState(false)
  const [runningHubTool, setRunningHubTool] = useState<string | null>(null)
  const [cloudTab, setCloudTab] = useState<'activity' | 'goals' | 'files' | 'console'>('activity')
  const [cloudSnapshot, setCloudSnapshot] = useState<MuseCloudSnapshot | null>(null)
  const [isLoadingCloud, setIsLoadingCloud] = useState(false)
  const [selectedCloudFile, setSelectedCloudFile] = useState<{
    fileName: string
    content: string
  } | null>(null)
  const [isReadingCloudFile, setIsReadingCloudFile] = useState(false)
  const [cloudBrowserStatus, setCloudBrowserStatus] = useState<MuseCloudBrowserStatus | null>(null)

  const handleOpenCloudHub = async (
    initialTab?: 'activity' | 'goals' | 'files' | 'console',
    forceRefresh = false
  ) => {
    setShowSettings(false)
    if (initialTab) setCloudTab(initialTab)
    setShowCloudHub(true)
    if (!cloudSnapshot || forceRefresh) {
      setIsLoadingCloud(true)
      try {
        const snap = await window.chatApi?.getCloudSnapshot(forceRefresh)
        if (snap) setCloudSnapshot(snap)
      } finally {
        setIsLoadingCloud(false)
      }
    }
  }

  const handleReadCloudFile = async (fileName: string) => {
    setIsReadingCloudFile(true)
    try {
      const res = await window.chatApi?.readCloudFile(fileName)
      if (res) setSelectedCloudFile(res)
    } finally {
      setIsReadingCloudFile(false)
    }
  }

  const handleOpenCloudConsole = async (target: MuseCloudConsoleTarget = 'main') => {
    await window.chatApi?.openCloudConsole(target)
  }

  const refreshHubState = async () => {
    setIsLoadingHub(true)
    try {
      const state = await window.chatApi?.getHubState()
      if (state) setHubState(state)
    } finally {
      setIsLoadingHub(false)
    }
  }

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const pluginDockRef = useRef<HTMLDivElement>(null)

  const agentSlug = (authProfile.agentName || 'luna').toLowerCase().replace(/\s+/g, '-')
  const agentDisplayName = authProfile.agentName || 'Luna'
  const activePlugins = (secretaryState?.plugins || []).filter((p) => p.enabled)
  const combinedChatCss = activePlugins
    .filter((p) => p.chatCss)
    .map((p) => `/* Plugin: ${p.name} */\n${p.chatCss}`)
    .join('\n')

  // Mount & execute enabled ChatWindow widget plugins (chatHtml + chatJs + sdk)
  useEffect(() => {
    const dock = pluginDockRef.current
    if (!dock) return
    dock.innerHTML = ''
    const cleanups: Array<() => void> = []

    const playBeep = () => {
      try {
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext
        if (!AudioCtx) return
        const ctx = new AudioCtx()
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.setValueAtTime(880, ctx.currentTime)
        gain.gain.setValueAtTime(0.12, ctx.currentTime)
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35)
        osc.connect(gain)
        gain.connect(ctx.destination)
        osc.start()
        osc.stop(ctx.currentTime + 0.35)
      } catch {
        // ignore audio errors
      }
    }

    const widgets = (secretaryState?.plugins || []).filter(
      (p) => p.enabled && (p.chatHtml || p.chatJs)
    )
    for (const plg of widgets) {
      const container = document.createElement('div')
      container.setAttribute('data-muse-plugin-id', plg.id)
      if (plg.chatHtml) {
        container.innerHTML = plg.chatHtml
      }
      dock.appendChild(container)
      if (plg.chatJs) {
        const sdk = {
          sendCommand: (cmd: string) => handleSend(cmd),
          addReminder: (title: string, mins: number) => {
            // Plugin-local timer reminder (no secretary IPC needed)
            setTimeout(() => {
              sdk.notify(`⏰ ${title}`)
            }, Math.max(100, mins * 60 * 1000))
          },
          addTodo: (_text: string) => { /* noop – todos are plugin-managed */ },
          notify: (msg: string) => {
            setMessages((prev) => [
              ...prev,
              {
                id: String(Date.now()),
                role: 'assistant',
                content: msg,
                timestamp: Date.now(),
                status: 'done',
              },
            ])
          },
          playBeep,
          storage: {
            get: (key: string) => localStorage.getItem(`muse_plg_${plg.id}_${key}`),
            set: (key: string, val: string) =>
              localStorage.setItem(`muse_plg_${plg.id}_${key}`, val),
          },
        }
        try {
          const fn = new Function('root', 'sdk', plg.chatJs)
          const cleanup = fn(container, sdk)
          if (typeof cleanup === 'function') {
            cleanups.push(cleanup)
          }
        } catch (err) {
          console.warn('Chat plugin JS error:', err)
        }
      }
    }

    return () => {
      cleanups.forEach((fn) => {
        try {
          fn()
        } catch {
          // ignore
        }
      })
    }
  }, [secretaryState?.plugins])

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages, isStreaming])

  // Auto-focus prompt when window gains focus or mounts
  useEffect(() => {
    textareaRef.current?.focus()
    const onFocus = () => textareaRef.current?.focus()
    const onGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (previewMedia) {
          setPreviewMedia(null)
        } else if (showSettings) {
          setShowSettings(false)
        } else {
          window.chatApi?.hide()
        }
      }
    }
    window.addEventListener('focus', onFocus)
    window.addEventListener('keydown', onGlobalKeyDown)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('keydown', onGlobalKeyDown)
    }
  }, [showSettings, previewMedia])

  // Load auth status, proxy config & messages on mount
  useEffect(() => {
    window.chatApi?.getAuthStatus().then((profile) => {
      if (profile) setAuthProfile(profile)
    })

    window.chatApi?.getProxyConfig().then((cfg) => {
      if (cfg) setProxyConfig(cfg)
    })

    window.chatApi?.getSecretaryState().then((st) => {
      if (st) setSecretaryState(st)
    })

    window.chatApi?.getCloudBrowserStatus().then((status) => {
      if (status) setCloudBrowserStatus(status)
    })

    window.chatApi?.getBounds().then((b) => {
      if (b && b.width && b.height) {
        setWinBounds({ width: b.width, height: b.height })
      }
    })

    window.chatApi?.getMessages().then((loaded) => {
      if (loaded && loaded.length > 0) {
        setMessages(loaded)
        const userHistory = loaded
          .filter((m) => m.role === 'user')
          .map((m) => m.content)
        setCmdHistory(userHistory)
      } else {
        setMessages([
          {
            id: 'welcome',
            role: 'assistant',
            content:
              '终端已就绪。直接输入问题与我对话，或使用 `/clear` 清屏、`/proxy` 配置网络、`/login` 同步会话、`Esc` 快速收起。',
            timestamp: Date.now(),
          },
        ])
      }
    })

    const unsubChunk = window.chatApi?.onStreamChunk((chunk) => {
      setIsStreaming(true)
      setMessages((prev) => {
        const lastMsg = prev[prev.length - 1]
        if (lastMsg && lastMsg.role === 'assistant' && lastMsg.status === 'streaming') {
          return [...prev.slice(0, -1), { ...lastMsg, content: lastMsg.content + chunk }]
        } else {
          return [
            ...prev,
            {
              id: String(Date.now()),
              role: 'assistant',
              content: chunk,
              timestamp: Date.now(),
              status: 'streaming',
            },
          ]
        }
      })
    })

    const unsubEnd = window.chatApi?.onStreamEnd((_fullContent) => {
      setIsStreaming(false)
      setMessages((prev) => {
        const lastMsg = prev[prev.length - 1]
        if (lastMsg && lastMsg.role === 'assistant') {
          return [...prev.slice(0, -1), { ...lastMsg, status: 'done' }]
        }
        return prev
      })
    })

    const unsubError = window.chatApi?.onStreamError((err) => {
      setIsStreaming(false)
      setMessages((prev) => [
        ...prev,
        {
          id: String(Date.now()),
          role: 'system',
          content: `通信异常: ${err}`,
          timestamp: Date.now(),
          status: 'error',
        },
      ])
    })

    const unsubAuth = window.chatApi?.onAuthChanged((profile) => {
      setAuthProfile(profile)
    })

    const unsubSynced = window.chatApi?.onMessagesSynced((synced) => {
      if (synced && synced.length > 0) {
        setMessages(synced)
        const userHistory = synced
          .filter((m) => m.role === 'user')
          .map((m) => m.content)
        setCmdHistory(userHistory)
      }
    })

    const unsubSecAction = window.chatApi?.onSecretaryActionUpdated((updatedAction) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.pendingAction && m.pendingAction.id === updatedAction.id
            ? { ...m, pendingAction: updatedAction }
            : m
        )
      )
    })

    const unsubSecState = window.chatApi?.onSecretaryStateUpdated((st) => {
      setSecretaryState(st)
    })

    const unsubBrowser = window.chatApi?.onCloudBrowserStatus((status) => {
      setCloudBrowserStatus(status)
    })

    const unsubHub = window.chatApi?.onHubEvent((event: MuseHubEvent) => {
      // Keep the hub panel live when it is open.
      if (showHubPanel) {
        void refreshHubState()
      }
      if (event.type === 'app.registered') {
        setMessages((prev) => [
          ...prev,
          {
            id: String(Date.now()),
            role: 'assistant',
            content: `🔌 新软件已接入 Muse Local Agent Hub：${event.payload?.name || event.payload?.appId}`,
            timestamp: Date.now(),
          },
        ])
      }
    })

    const unsubBounds = window.chatApi?.onBoundsChanged((b) => {
      if (b && b.width && b.height) {
        setWinBounds({ width: b.width, height: b.height })
      }
    })

    return () => {
      unsubChunk?.()
      unsubEnd?.()
      unsubError?.()
      unsubAuth?.()
      unsubSynced?.()
      unsubSecAction?.()
      unsubSecState?.()
      unsubBrowser?.()
      unsubHub?.()
      unsubBounds?.()
    }
  }, [showHubPanel])

  const handleClear = async () => {
    await window.chatApi?.clearMessages()
    setMessages([
      {
        id: String(Date.now()),
        role: 'assistant',
        content: '终端缓冲区已清空 (`clear`)。请继续输入指令。',
        timestamp: Date.now(),
      },
    ])
  }

  const handleClose = () => {
    window.chatApi?.hide()
  }

  const handleLogin = () => {
    window.chatApi?.openLogin()
  }

  const executeSlashCommand = async (raw: string): Promise<boolean> => {
    const cmd = raw.trim().toLowerCase()
    if (cmd === '/clear' || cmd === 'clear' || cmd === 'cls') {
      await handleClear()
      return true
    }
    if (cmd === '/login' || cmd === 'login') {
      handleLogin()
      setMessages((prev) => [
        ...prev,
        {
          id: String(Date.now()),
          role: 'assistant',
          content: '已唤起 Meta Muse 认证会话检测。',
          timestamp: Date.now(),
        },
      ])
      return true
    }
    if (cmd === '/proxy' || cmd === '/settings' || cmd === '/net' || cmd === '/theme' || cmd === '/plugins') {
      setShowSettings((s) => !s)
      return true
    }
    if (cmd === '/hub' || cmd === 'hub' || cmd === '/agent-hub' || cmd === '/integrations') {
      setShowSettings(false)
      setShowCloudHub(false)
      setShowHubPanel((s) => !s)
      void refreshHubState()
      return true
    }
    if (cmd === '/reset-ui') {
      const st = await window.chatApi?.resetAllPlugins()
      if (st) setSecretaryState(st)
      setMessages((prev) => [
        ...prev,
        {
          id: String(Date.now()),
          role: 'assistant',
          content: '✨ 已清空所有自定义主题与小组件插件，恢复终端与桌宠默认界面。',
          timestamp: Date.now(),
          status: 'done',
        },
      ])
      return true
    }
    if (cmd === '/cloud' || cmd === 'cloud') {
      await handleOpenCloudHub('activity', false)
      return true
    }
    if (cmd === '/console' || cmd === 'console') {
      await handleOpenCloudConsole('main')
      return true
    }
    if (cmd === '/sync' || cmd === 'sync') {
      const synced = await window.chatApi?.syncMessages()
      if (synced && synced.length > 0) {
        setMessages(synced)
      }
      return true
    }
    if (cmd === '/solid' || cmd === '/black') {
      updateAppearance({ preset: 'obsidian', opacity: 100 })
      return true
    }
    if (cmd === '/glass') {
      updateAppearance({ preset: 'crystal', opacity: 72 })
      return true
    }
    if (cmd === '/exit' || cmd === 'exit' || cmd === '/hide' || cmd === 'quit') {
      handleClose()
      return true
    }
    if (cmd === '/help' || cmd === 'help') {
      setMessages((prev) => [
        ...prev,
        {
          id: String(Date.now()),
          role: 'assistant',
          content:
            '支持的终端快捷命令（也支持直接用自然语言吩咐）：\n```shell\n/cloud          # 打开 Muse 云端中枢 (动态、预定任务、目标点子、云端文件)\n/console        # 呼出共享会话的原生 muse.ai 工作台 (关闭自动退回后台保活)\n/plugin <修改需求> # 让 Luna 自修改界面或挂载小功能\n/reset-ui       # 清空自定义主题与插件，恢复默认界面\n/gmail <条件>    # 打开 Gmail 按条件筛选并由 Luna 提炼邮件重点\n/screen [问题]   # 截取当前桌面发送给 Luna 看图分析\n/sys            # 查看当前电脑 CPU、内存与高占用进程\n/ps <命令>       # 创建待授权的本地 PowerShell 执行卡片\n/settings       # 打开设置面板\n/clear          # 清空当前终端缓冲区\n/exit           # 收起终端窗口 (同 Esc / Alt+Space)\n```',
          timestamp: Date.now(),
        },
      ])
      return true
    }
    return false
  }

  const handleSend = async (overrideText?: string) => {
    const userText = (overrideText ?? input).trim()
    if (!userText || isStreaming) return

    setInput('')
    setCmdHistory((prev) => [...prev, userText])
    setHistoryIndex(-1)

    if (await executeSlashCommand(userText)) {
      return
    }

    const userMsg: ChatMessage = {
      id: String(Date.now()),
      role: 'user',
      content: userText,
      timestamp: Date.now(),
    }

    setMessages((prev) => [
      ...prev,
      userMsg,
      {
        id: String(Date.now() + 1),
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        status: 'streaming',
      },
    ])
    setIsStreaming(true)

    try {
      await window.chatApi?.sendMessage(userText)
    } catch (err: any) {
      setIsStreaming(false)
      setMessages((prev) => [
        ...prev,
        {
          id: String(Date.now() + 2),
          role: 'system',
          content: `请求发送失败: ${err?.message || err}`,
          timestamp: Date.now(),
          status: 'error',
        },
      ])
    }
  }

  // Approve or Deny pending local secretary action
  const handleApproveAction = async (actionId: string) => {
    try {
      const updated = await window.chatApi?.approveSecretaryAction(actionId)
      if (updated) {
        setMessages((prev) =>
          prev.map((m) =>
            m.pendingAction && m.pendingAction.id === actionId
              ? { ...m, pendingAction: updated }
              : m
          )
        )
      }
    } catch (e: any) {
      console.error('approveSecretaryAction error:', e)
    }
  }

  const handleDenyAction = async (actionId: string) => {
    try {
      const updated = await window.chatApi?.denySecretaryAction(actionId)
      if (updated) {
        setMessages((prev) =>
          prev.map((m) =>
            m.pendingAction && m.pendingAction.id === actionId
              ? { ...m, pendingAction: updated }
              : m
          )
        )
      }
    } catch (e: any) {
      console.error('denySecretaryAction error:', e)
    }
  }

  const handleRunCodeBlock = async (code: string, _lang: string) => {
    try {
      const executed = await window.chatApi?.runSecretaryCommand('终端内联代码块执行', code)
      if (executed) {
        setMessages((prev) => [
          ...prev,
          {
            id: String(Date.now()),
            role: 'assistant',
            content: '已在本地执行你批准的 PowerShell 脚本：',
            pendingAction: executed,
            timestamp: Date.now(),
            status: 'done',
          },
        ])
      }
    } catch (e: any) {
      console.error('runSecretaryCommand error:', e)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
      return
    }

    // Up arrow: previous command in history
    if (e.key === 'ArrowUp' && !input.includes('\n')) {
      if (cmdHistory.length === 0) return
      e.preventDefault()
      const nextIdx = historyIndex === -1 ? cmdHistory.length - 1 : Math.max(0, historyIndex - 1)
      setHistoryIndex(nextIdx)
      setInput(cmdHistory[nextIdx])
      return
    }

    // Down arrow: next command in history
    if (e.key === 'ArrowDown' && !input.includes('\n') && historyIndex !== -1) {
      e.preventDefault()
      const nextIdx = historyIndex + 1
      if (nextIdx >= cmdHistory.length) {
        setHistoryIndex(-1)
        setInput('')
      } else {
        setHistoryIndex(nextIdx)
        setInput(cmdHistory[nextIdx])
      }
    }
  }

  const handleStop = () => {
    window.chatApi?.stopGeneration()
    setIsStreaming(false)
  }

  const handleSaveProxy = async (newConfig: ProxyConfig) => {
    setProxyConfig(newConfig)
    await window.chatApi?.setProxyConfig(newConfig)
  }

  const handleTestProxy = async () => {
    setIsTestingNet(true)
    setTestResult(null)
    try {
      const res = await window.chatApi?.testProxyConnection()
      if (res) setTestResult(res)
    } finally {
      setIsTestingNet(false)
    }
  }

  const handleSaveManualCookie = async () => {
    if (!manualCookie.trim()) return
    await window.chatApi?.saveManualCookie(manualCookie.trim())
    setCookieSavedToast(true)
    setTimeout(() => setCookieSavedToast(false), 2500)
    setManualCookie('')
  }

  // 8-direction mouse drag window resizing (for frameless transparent Electron window)
  const startWindowResize = async (
    dir: 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se',
    e: React.MouseEvent
  ) => {
    e.preventDefault()
    e.stopPropagation()
    const startScreenX = e.screenX
    const startScreenY = e.screenY
    const initial = (await window.chatApi?.getBounds()) || {
      x: window.screenX,
      y: window.screenY,
      width: winBounds.width,
      height: winBounds.height,
    }
    setIsCompact(false)

    const MIN_W = 460
    const MIN_H = 380

    const onMouseMove = (ev: MouseEvent) => {
      const dx = ev.screenX - startScreenX
      const dy = ev.screenY - startScreenY
      let nextX = initial.x
      let nextY = initial.y
      let nextW = initial.width
      let nextH = initial.height

      if (dir.includes('e')) {
        nextW = Math.max(MIN_W, initial.width + dx)
      }
      if (dir.includes('s')) {
        nextH = Math.max(MIN_H, initial.height + dy)
      }
      if (dir.includes('w')) {
        const candidateW = initial.width - dx
        if (candidateW >= MIN_W) {
          nextW = candidateW
          nextX = initial.x + dx
        } else {
          nextW = MIN_W
          nextX = initial.x + (initial.width - MIN_W)
        }
      }
      if (dir.includes('n')) {
        const candidateH = initial.height - dy
        if (candidateH >= MIN_H) {
          nextH = candidateH
          nextY = initial.y + dy
        } else {
          nextH = MIN_H
          nextY = initial.y + (initial.height - MIN_H)
        }
      }

      setWinBounds({ width: nextW, height: nextH })
      window.chatApi?.setBounds({ x: nextX, y: nextY, width: nextW, height: nextH })
    }

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  const handleToggleZoomSize = async () => {
    setIsCompact(false)
    const cur = (await window.chatApi?.getBounds()) || {
      x: 0,
      y: 0,
      width: winBounds.width,
      height: winBounds.height,
    }
    if (cur.width >= 860 && cur.height >= 680 && preZoomSizeRef.current) {
      const prev = preZoomSizeRef.current
      preZoomSizeRef.current = null
      await window.chatApi?.setBounds({ width: prev.width, height: prev.height })
    } else {
      preZoomSizeRef.current = { width: cur.width, height: cur.height }
      await window.chatApi?.setBounds({ width: 920, height: 720 })
    }
  }

  return (
    <div className="relative w-screen h-screen p-2 flex flex-col select-none overflow-hidden">
      {/* 8-Direction Invisible Mouse Resize Handles Around Terminal Edges & Corners */}
      <div
        onMouseDown={(e) => startWindowResize('n', e)}
        className="no-drag fixed top-0 left-3 right-3 h-2 cursor-ns-resize z-50"
      />
      <div
        onMouseDown={(e) => startWindowResize('s', e)}
        className="no-drag fixed bottom-0 left-3 right-3 h-2 cursor-ns-resize z-50"
      />
      <div
        onMouseDown={(e) => startWindowResize('w', e)}
        className="no-drag fixed left-0 top-3 bottom-3 w-2 cursor-ew-resize z-50"
      />
      <div
        onMouseDown={(e) => startWindowResize('e', e)}
        className="no-drag fixed right-0 top-3 bottom-3 w-2 cursor-ew-resize z-50"
      />
      <div
        onMouseDown={(e) => startWindowResize('nw', e)}
        className="no-drag fixed top-0 left-0 w-3.5 h-3.5 cursor-nwse-resize z-50"
      />
      <div
        onMouseDown={(e) => startWindowResize('ne', e)}
        className="no-drag fixed top-0 right-0 w-3.5 h-3.5 cursor-nesw-resize z-50"
      />
      <div
        onMouseDown={(e) => startWindowResize('sw', e)}
        className="no-drag fixed bottom-0 left-0 w-3.5 h-3.5 cursor-nesw-resize z-50"
      />
      <div
        onMouseDown={(e) => startWindowResize('se', e)}
        title="按住拖拽调整终端窗口大小"
        className="no-drag fixed bottom-0 right-0 w-5 h-5 cursor-nwse-resize z-50 flex items-end justify-end pr-2.5 pb-2.5 group"
      >
        <svg
          viewBox="0 0 10 10"
          className="w-2.5 h-2.5 text-slate-400/50 group-hover:text-sky-400 transition-colors pointer-events-none"
        >
          <path
            d="M9 1L1 9M9 5L5 9M9 8.5L8.5 9"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      </div>

      {combinedChatCss && <style id="muse-custom-plugins-css">{combinedChatCss}</style>}
      <div
        style={{ '--terminal-alpha': appearance.opacity / 100 } as React.CSSProperties}
        className={`liquid-glass-terminal liquid-glass-shell w-full ${
          isCompact ? 'h-[430px]' : 'h-full'
        } flex flex-col text-slate-100 overflow-hidden`}
      >
        {/* macOS Terminal Titlebar (Draggable) */}
        <div
          onDoubleClick={handleToggleZoomSize}
          className="draggable liquid-glass-header flex items-center justify-between px-4 py-2.5 select-none"
        >
          {/* Left: macOS Traffic Lights */}
          <div className="no-drag flex items-center gap-2 group">
            <button
              onClick={handleClose}
              title="收起终端 (Esc)"
              className="w-3 h-3 rounded-full bg-[#ff5f56] border border-black/15 shadow-inner flex items-center justify-center text-[9px] font-bold text-black/75 hover:brightness-110 transition-all"
            >
              <span className="opacity-0 group-hover:opacity-100 leading-none">×</span>
            </button>
            <button
              onClick={handleClose}
              title="最小化隐藏 (Alt+Space)"
              className="w-3 h-3 rounded-full bg-[#ffbd2e] border border-black/15 shadow-inner flex items-center justify-center text-[9px] font-bold text-black/75 hover:brightness-110 transition-all"
            >
              <span className="opacity-0 group-hover:opacity-100 leading-none">−</span>
            </button>
            <button
              onClick={handleToggleZoomSize}
              title="放大/还原终端窗口尺寸 (或拖拽窗口四周边缘自由缩放)"
              className="w-3 h-3 rounded-full bg-[#27c93f] border border-black/15 shadow-inner flex items-center justify-center text-[9px] font-bold text-black/75 hover:brightness-110 transition-all"
            >
              <span className="opacity-0 group-hover:opacity-100 leading-none">+</span>
            </button>
          </div>

          {/* Center: Terminal Path & Live Session Status */}
          <div className="flex items-center gap-2 font-terminal text-xs text-slate-200/90">
            {authProfile.avatarUrl ? (
              <button
                type="button"
                onClick={() =>
                  setPreviewMedia({
                    type: 'image',
                    url: authProfile.avatarUrl!,
                    title: `${agentDisplayName} · 完整全身立绘 (1600×1600)`,
                  })
                }
                title="点击查看完整全身立绘"
                className="no-drag rounded-full focus:outline-none hover:ring-2 hover:ring-sky-400/60 transition-all"
              >
                <img
                  src={authProfile.avatarUrl}
                  alt={agentDisplayName}
                  className="w-4 h-4 rounded-full object-cover object-[50%_10%] border border-white/30 shadow-sm"
                  draggable={false}
                />
              </button>
            ) : (
              <Terminal className="w-3.5 h-3.5 text-sky-400" />
            )}
            <span className="tracking-tight font-medium">{agentSlug}@muse:~</span>
            <span
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] border ${
                authProfile.isLoggedIn
                  ? 'bg-emerald-500/15 border-emerald-400/35 text-emerald-300'
                  : 'bg-amber-500/15 border-amber-400/35 text-amber-300'
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  authProfile.isLoggedIn ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'
                }`}
              />
              {authProfile.isLoggedIn ? 'connected' : 'offline'}
            </span>
          </div>

          {/* Right: Quick Glass Chips */}
          <div className="no-drag flex items-center gap-1.5 font-terminal text-[11px]">
            {!authProfile.isLoggedIn && (
              <button
                onClick={handleLogin}
                className="liquid-glass-pill px-2.5 py-1 rounded-lg text-sky-200 flex items-center gap-1 transition-all"
              >
                <LogIn className="w-3 h-3 text-sky-400" />
                <span>/login</span>
              </button>
            )}
            <button
              onClick={async () => {
                const synced = await window.chatApi?.syncMessages()
                if (synced && synced.length > 0) setMessages(synced)
              }}
              title="从 muse.ai 同步会话历史 (/sync)"
              className="liquid-glass-pill px-2 py-1 rounded-lg text-slate-200/85 hover:text-white transition-all"
            >
              /sync
            </button>
            <button
              onClick={() => {
                if (showCloudHub) {
                  setShowCloudHub(false)
                } else {
                  handleOpenCloudHub('activity', false)
                }
              }}
              title="Muse 云端中枢：动态、预定任务、目标点子、云端文件与原生衣柜 (/cloud)"
              className={`liquid-glass-pill px-2 py-1 rounded-lg flex items-center gap-1 transition-all ${
                showCloudHub
                  ? 'text-sky-300 border-sky-400/50 bg-sky-500/20'
                  : 'text-slate-200/85 hover:text-white'
              }`}
            >
              <Cloud className="w-3 h-3 text-sky-400" />
              <span>/cloud</span>
            </button>
            <button
              onClick={() => {
                setShowCloudHub(false)
                setShowSettings(false)
                setShowHubPanel((s) => !s)
                void refreshHubState()
              }}
              title="Muse Local Agent Hub：已接入的本地软件、能力与任务 (/hub)"
              className={`liquid-glass-pill px-2 py-1 rounded-lg flex items-center gap-1 transition-all ${
                showHubPanel
                  ? 'text-fuchsia-300 border-fuchsia-400/50 bg-fuchsia-500/20'
                  : 'text-slate-200/85 hover:text-white'
              }`}
            >
              <Plug className="w-3 h-3 text-fuchsia-400" />
              <span>/hub</span>
            </button>
            <button
              onClick={handleClear}
              title="清屏 (/clear)"
              className="liquid-glass-pill px-2 py-1 rounded-lg text-slate-200/85 hover:text-white transition-all"
            >
              /clear
            </button>
            <button
              onClick={() => {
                setShowCloudHub(false)
                setShowSettings((s) => !s)
              }}
              title="外观透明度与网络配置 (/settings)"
              className={`liquid-glass-pill px-2 py-1 rounded-lg transition-all ${
                showSettings ? 'text-sky-300 border-sky-400/50' : 'text-slate-200/85 hover:text-white'
              }`}
            >
              /settings
            </button>
          </div>
        </div>

        {/* Dynamic Plugin Widget Dock (e.g., Mini Alarm Clock, Sticky Note, Custom Widgets) */}
        <div ref={pluginDockRef} id="muse-plugin-dock" className="no-drag" />

        {/* Auto cloud-browser status card — only while Luna's Hatch browser task is active */}
        {cloudBrowserStatus?.active && (
          <div className="no-drag mx-3 mt-2 mb-1 px-3 py-2.5 rounded-xl bg-sky-500/10 border border-sky-400/35 backdrop-blur-xl flex items-center justify-between gap-3 animate-in slide-in-from-top-2 duration-200">
            <div className="min-w-0 flex items-start gap-2.5">
              <Globe className="w-4 h-4 text-sky-300 mt-0.5 flex-shrink-0" />
              <div className="min-w-0">
                <div className="font-terminal text-[11px] text-sky-200 flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-pulse" />
                  <span>{agentDisplayName} 正在使用云浏览器</span>
                </div>
                <div className="text-[11.5px] text-slate-100 truncate mt-0.5">
                  {cloudBrowserStatus.title || '浏览任务进行中'}
                </div>
                {(cloudBrowserStatus.url || cloudBrowserStatus.summary) && (
                  <div className="font-terminal text-[10.5px] text-slate-400 truncate mt-0.5">
                    {cloudBrowserStatus.url || cloudBrowserStatus.summary}
                  </div>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={() => handleOpenCloudConsole('main')}
              className="liquid-glass-pill flex-shrink-0 px-3 py-1.5 rounded-lg font-terminal text-[11px] text-emerald-100 border-emerald-400/45 bg-emerald-500/20 hover:bg-emerald-500/30 flex items-center gap-1.5"
              title="打开原生 muse.ai 工作台；控制权限由原生页面提供"
            >
              <ExternalLink className="w-3.5 h-3.5 text-emerald-300" />
              <span>打开工作台</span>
            </button>
          </div>
        )}

        {/* Muse Cloud Hub Drawer (/cloud · Activity, Scheduled Tasks, Goals, Ideas, Hatch VM Files & Native Console) */}
        {showCloudHub && (
          <div className="no-drag bg-[#07090f]/95 backdrop-blur-2xl border-b border-white/15 px-4 py-3.5 space-y-3 text-xs animate-in slide-in-from-top-2 duration-200 max-h-[410px] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-white/10 pb-2">
              <div className="flex items-center gap-2 text-white font-terminal text-xs">
                <Cloud className="w-3.5 h-3.5 text-sky-400" />
                <span>
                  {agentDisplayName} cloud hub · 云端动态 / 预定任务 / 目标点子 / Hatch VM 资源库
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleOpenCloudHub(cloudTab, true)}
                  disabled={isLoadingCloud}
                  title="从 muse.ai 实时刷新云端状态"
                  className="liquid-glass-pill px-2 py-0.5 rounded-md font-terminal text-[10.5px] text-sky-200 flex items-center gap-1 disabled:opacity-50"
                >
                  <RefreshCw className={`w-3 h-3 ${isLoadingCloud ? 'animate-spin' : ''}`} />
                  <span>{isLoadingCloud ? '同步中...' : '刷新云端'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleOpenCloudConsole('main')}
                  title="呼出共享会话的完整 muse.ai 原生窗口 (/console)"
                  className="liquid-glass-pill px-2 py-0.5 rounded-md font-terminal text-[10.5px] text-emerald-200 border-emerald-400/35 flex items-center gap-1 hover:bg-emerald-500/20"
                >
                  <ExternalLink className="w-3 h-3 text-emerald-300" />
                  <span>原生工作台</span>
                </button>
                <button
                  onClick={() => setShowCloudHub(false)}
                  className="text-slate-400 hover:text-white ml-1"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Cloud Hub Sub-navigation Tabs */}
            <div className="grid grid-cols-4 gap-1.5 font-terminal text-[11px]">
              {[
                { id: 'activity', label: '⚡ 动态与预定任务' },
                { id: 'goals', label: '🎯 目标与点子卡片' },
                { id: 'files', label: '📂 云端系统文件 (MEMORY/SOUL)' },
                { id: 'console', label: '🌐 原生云端工作台' },
              ].map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setCloudTab(t.id as any)}
                  className={`py-1.5 px-2 rounded-lg border text-center transition-all truncate ${
                    cloudTab === t.id
                      ? 'bg-sky-500/25 border-sky-400/60 text-sky-100 font-medium shadow-inner'
                      : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {/* Tab 1: Cloud Activity & Scheduled Tasks */}
            {cloudTab === 'activity' && (
              <div className="space-y-3">
                {cloudSnapshot?.identityVibe && (
                  <div className="px-3 py-2 rounded-xl bg-white/[0.04] border border-white/10 flex items-center justify-between gap-2">
                    <div className="text-[11px] text-slate-300">
                      <span className="text-sky-300 font-terminal mr-1.5">[{agentDisplayName} 风格气质]</span>
                      <span>{cloudSnapshot.identityVibe}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setCloudTab('files')
                        handleReadCloudFile('SOUL.md')
                      }}
                      className="text-[10.5px] font-terminal text-sky-300 hover:underline flex-shrink-0"
                    >
                      查看 SOUL.md →
                    </button>
                  </div>
                )}

                {/* Scheduled Tasks */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-slate-200 font-medium font-terminal text-[11px]">
                    <span className="flex items-center gap-1.5">
                      <Clock className="w-3.5 h-3.5 text-amber-400" />
                      <span>云端预定任务 (Scheduled Tasks · {(cloudSnapshot?.scheduledTasks || []).length})</span>
                    </span>
                  </div>
                  {(cloudSnapshot?.scheduledTasks || []).length === 0 ? (
                    <div className="text-[11px] text-slate-400 py-1">
                      {isLoadingCloud ? '正在从 muse.ai 读取预定任务...' : '暂无预定任务'}
                    </div>
                  ) : (
                    <div className="grid grid-cols-3 gap-2">
                      {(cloudSnapshot?.scheduledTasks || []).map((task, idx) => (
                        <div
                          key={idx}
                          className="p-2 rounded-lg bg-white/[0.04] border border-white/10 flex flex-col justify-between gap-1"
                        >
                          <div className="font-medium text-slate-100 text-[11.5px] truncate">
                            {task.title}
                          </div>
                          <div className="font-terminal text-[10px] text-amber-300/90">
                            ⏰ {task.schedule}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Activity Timeline */}
                <div className="space-y-1.5 pt-1 border-t border-white/10">
                  <div className="flex items-center justify-between text-slate-200 font-medium font-terminal text-[11px]">
                    <span>云端自治动态日志 (Hatch VM Activity · {(cloudSnapshot?.activities || []).length})</span>
                  </div>
                  {(cloudSnapshot?.activities || []).length === 0 ? (
                    <div className="text-[11px] text-slate-400 py-2">
                      {isLoadingCloud ? '正在同步云端动态...' : '暂无云端动态记录'}
                    </div>
                  ) : (
                    <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                      {(cloudSnapshot?.activities || []).map((act, idx) => (
                        <div
                          key={idx}
                          className="px-2.5 py-1.5 rounded-lg bg-white/[0.03] border border-white/10 flex items-start justify-between gap-2"
                        >
                          <div className="min-w-0">
                            <div className="text-slate-100 font-medium text-[11.5px] truncate">
                              {act.title}
                            </div>
                            {act.summary && (
                              <div className="text-slate-400 text-[10.5px] truncate">
                                {act.summary}
                              </div>
                            )}
                          </div>
                          <span className="font-terminal text-[10px] text-slate-400 flex-shrink-0">
                            {act.day} {act.time}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Tab 2: Goals & Ideas */}
            {cloudTab === 'goals' && (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-slate-200 font-medium font-terminal text-[11px]">
                    <span className="flex items-center gap-1.5">
                      <Target className="w-3.5 h-3.5 text-emerald-400" />
                      <span>正在追踪的云端目标 (Goals · {(cloudSnapshot?.goals || []).length})</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => handleOpenCloudConsole('goals')}
                      className="text-[10.5px] text-sky-300 hover:underline"
                    >
                      在原生窗口管理目标 →
                    </button>
                  </div>
                  {(cloudSnapshot?.goals || []).length === 0 ? (
                    <div className="text-[11px] text-slate-400">暂无云端追踪目标</div>
                  ) : (
                    <div className="grid grid-cols-2 gap-2">
                      {(cloudSnapshot?.goals || []).map((g, idx) => (
                        <div
                          key={idx}
                          className="p-2.5 rounded-xl bg-emerald-500/[0.07] border border-emerald-400/25 space-y-1 flex flex-col justify-between"
                        >
                          <div>
                            <div className="text-emerald-200 font-medium text-[11.5px]">{g.title}</div>
                            <div className="text-slate-300/90 text-[10.5px] leading-snug line-clamp-2 mt-0.5">
                              {g.description}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              setShowCloudHub(false)
                              handleSend(`关于我的目标「${g.title}」，现在进展如何？`)
                            }}
                            className="text-left font-terminal text-[10px] text-emerald-300 hover:text-emerald-200 underline pt-1"
                          >
                            ❯ 向 {agentDisplayName} 追问此目标进展
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="space-y-1.5 pt-2 border-t border-white/10">
                  <div className="flex items-center justify-between text-slate-200 font-medium font-terminal text-[11px]">
                    <span className="flex items-center gap-1.5">
                      <Lightbulb className="w-3.5 h-3.5 text-amber-400" />
                      <span>个性化推荐点子卡片 (Ideas · 点击直接发送给 {agentDisplayName})</span>
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 max-h-48 overflow-y-auto pr-1">
                    {(cloudSnapshot?.ideas || []).map((idea, idx) => (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => {
                          setShowCloudHub(false)
                          handleSend(idea.title)
                        }}
                        className="p-2.5 rounded-xl bg-white/[0.04] hover:bg-sky-500/15 border border-white/10 hover:border-sky-400/40 text-left transition-all space-y-1 group"
                      >
                        <div className="text-slate-100 group-hover:text-sky-200 font-medium text-[11.5px] truncate">
                          💡 {idea.title}
                        </div>
                        <div className="text-slate-400 text-[10.5px] line-clamp-2 leading-snug">
                          {idea.description}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Tab 3: Cloud System Files (MEMORY.md, SOUL.md, IDENTITY.md, etc.) */}
            {cloudTab === 'files' && (
              <div className="space-y-2.5">
                <div className="flex items-center justify-between text-slate-200 font-terminal text-[11px]">
                  <span>Hatch VM 云端文件系统 (/library/files · 点击文件直接在线读取预览)</span>
                  <button
                    type="button"
                    onClick={() => handleOpenCloudConsole('library')}
                    className="text-sky-300 hover:underline text-[10.5px]"
                  >
                    在原生窗口编辑文件 →
                  </button>
                </div>

                {/* Quick Pinned Core Markdown Files */}
                <div className="flex flex-wrap gap-1.5">
                  {[
                    'MEMORY.md',
                    'SOUL.md',
                    'IDENTITY.md',
                    'PROACTIVE_PREFERENCES.md',
                    'USER.md',
                    'HEARTBEAT.md',
                    'AGENTS.md',
                    'TOOLS.md',
                  ].map((fname) => (
                    <button
                      key={fname}
                      type="button"
                      onClick={() => handleReadCloudFile(fname)}
                      className={`px-2.5 py-1 rounded-lg font-terminal text-[10.5px] border flex items-center gap-1 transition-all ${
                        selectedCloudFile?.fileName === fname
                          ? 'bg-sky-500/25 border-sky-400/60 text-sky-100'
                          : 'bg-white/5 border-white/10 text-slate-200 hover:bg-white/10'
                      }`}
                    >
                      <FileText className="w-3 h-3 text-sky-400" />
                      <span>{fname}</span>
                    </button>
                  ))}
                </div>

                {isReadingCloudFile && (
                  <div className="p-3 rounded-xl bg-black/40 border border-white/10 flex items-center gap-2 text-sky-300 font-terminal text-xs">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>正在从云端 Hatch VM 读取文件内容...</span>
                  </div>
                )}

                {!isReadingCloudFile && selectedCloudFile && (
                  <div className="rounded-xl bg-slate-950/80 border border-sky-400/35 overflow-hidden">
                    <div className="px-3 py-1.5 bg-white/[0.06] border-b border-white/10 flex items-center justify-between font-terminal text-[11px]">
                      <span className="text-sky-300 font-medium">
                        📄 /{selectedCloudFile.fileName}
                      </span>
                      <button
                        type="button"
                        onClick={() => setSelectedCloudFile(null)}
                        className="text-slate-400 hover:text-white"
                      >
                        关闭预览
                      </button>
                    </div>
                    <pre className="p-3 max-h-48 overflow-y-auto font-terminal text-[11px] text-slate-100 whitespace-pre-wrap leading-relaxed">
                      {selectedCloudFile.content}
                    </pre>
                  </div>
                )}

                {/* Full Directory Listing */}
                <div className="grid grid-cols-3 gap-1.5 max-h-40 overflow-y-auto pr-1 pt-1">
                  {(cloudSnapshot?.files || []).map((item, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => {
                        if (item.type === 'file') {
                          handleReadCloudFile(item.name)
                        } else {
                          handleOpenCloudConsole('library')
                        }
                      }}
                      className="px-2.5 py-1.5 rounded-lg bg-white/[0.03] hover:bg-white/[0.08] border border-white/10 flex items-center justify-between text-left transition-all"
                    >
                      <span className="flex items-center gap-1.5 truncate font-terminal text-[11px] text-slate-200">
                        {item.type === 'folder' ? (
                          <Folder className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
                        ) : (
                          <FileText className="w-3.5 h-3.5 text-sky-400 flex-shrink-0" />
                        )}
                        <span className="truncate">{item.name}</span>
                      </span>
                      {item.size && (
                        <span className="font-terminal text-[9.5px] text-slate-400 flex-shrink-0 ml-1">
                          {item.size}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Tab 4: Native Cloud Console */}
            {cloudTab === 'console' && (
              <div className="space-y-2.5">
                <div className="text-[11.5px] text-slate-300 leading-relaxed">
                  直接呼出共享登录会话的 <code className="text-sky-300 font-terminal">muse.ai</code> 原生工作台窗口（旁聊线程、空间与云端资源编辑）。关闭窗口时会自动退回后台保活，不会中断桌宠同步。
                </div>
                <div className="grid grid-cols-2 gap-2 font-terminal">
                  {[
                    {
                      target: 'main' as MuseCloudConsoleTarget,
                      title: '打开完整聊天与旁聊工作台 (/console)',
                      desc: '使用原生旁聊线程、语音通话与身份审批面板',
                    },
                    {
                      target: 'library' as MuseCloudConsoleTarget,
                      title: '打开云端资源库与空间 (/library)',
                      desc: '可视化编辑 MEMORY.md、SOUL.md、图片视频与空间',
                    },
                    {
                      target: 'goals' as MuseCloudConsoleTarget,
                      title: '打开云端目标与点子中心 (/goals)',
                      desc: '创建或管理长期追踪目标与自动化习惯',
                    },
                    {
                      target: 'ideas' as MuseCloudConsoleTarget,
                      title: '打开点子中心 (/ideas)',
                      desc: '浏览并管理个性化推荐点子卡片',
                    },
                  ].map((card) => (
                    <button
                      key={card.target}
                      type="button"
                      onClick={() => handleOpenCloudConsole(card.target)}
                      className="p-3 rounded-xl bg-white/[0.04] hover:bg-sky-500/15 border border-white/10 hover:border-sky-400/50 text-left transition-all space-y-1"
                    >
                      <div className="text-sky-200 font-medium text-xs">{card.title}</div>
                      <div className="text-slate-400 text-[10.5px] font-sans">{card.desc}</div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Muse Local Agent Hub Panel (/hub · Integrated apps, tools & tasks) */}
        {showHubPanel && (
          <div className="no-drag bg-[#07090f]/95 backdrop-blur-2xl border-b border-white/15 px-4 py-3.5 space-y-3 text-xs animate-in slide-in-from-top-2 duration-200 max-h-[430px] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-white/10 pb-2">
              <div className="flex items-center gap-2 text-white font-terminal text-xs">
                <Plug className="w-3.5 h-3.5 text-fuchsia-400" />
                <span>local agent hub · 已接入的本地软件与能力</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void refreshHubState()}
                  disabled={isLoadingHub}
                  className="liquid-glass-pill px-2 py-0.5 rounded-md font-terminal text-[10.5px] text-sky-200 flex items-center gap-1 disabled:opacity-50"
                >
                  <RefreshCw className={`w-3 h-3 ${isLoadingHub ? 'animate-spin' : ''}`} />
                  <span>刷新</span>
                </button>
                <button
                  onClick={() => setShowHubPanel(false)}
                  className="text-slate-400 hover:text-white"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            <div className="text-[11px] text-slate-400 leading-relaxed">
              本地 API：<code className="text-sky-300 font-terminal">http://127.0.0.1:{hubState?.port ?? 19840}</code>
              <span className="mx-1.5">·</span>
              任何软件接入后即可被 Luna 调度。手机问「看看我电脑」会自动调用系统屏幕视觉。
            </div>

            {(!hubState?.apps || hubState.apps.length === 0) && (
              <div className="text-[11px] text-slate-400">
                暂无已接入的软件。内置「系统屏幕视觉」应始终在线；第三方应用接入后可在此查看、调用或移除。
              </div>
            )}

            <div className="space-y-2">
              {(hubState?.apps || []).map((app) => (
                <div
                  key={app.appId}
                  className="p-2.5 rounded-xl bg-white/[0.04] border border-white/10 space-y-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-slate-100 font-medium text-[11.5px] flex items-center gap-1.5">
                        {app.builtin ? (
                          <CpuIcon className="w-3 h-3 text-emerald-300 flex-shrink-0" />
                        ) : (
                          <Plug className="w-3 h-3 text-fuchsia-300 flex-shrink-0" />
                        )}
                        <span className="truncate">{app.name}</span>
                        {app.builtin && (
                          <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 border border-emerald-400/35 text-emerald-300 text-[9.5px] flex-shrink-0">
                            内置
                          </span>
                        )}
                      </div>
                      <div className="font-terminal text-[10px] text-slate-500 truncate">{app.appId}</div>
                      <div className="font-terminal text-[9.5px] text-slate-500 mt-0.5">
                        {app.online
                          ? `心跳 ${formatHubRelativeTime(app.lastHeartbeat)}`
                          : `离线 · 上次心跳 ${formatHubRelativeTime(app.lastHeartbeat)}`}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <span
                        className={`px-2 py-0.5 rounded font-terminal text-[10px] ${
                          app.online
                            ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                            : 'bg-slate-500/20 text-slate-400 border border-slate-500/30'
                        }`}
                      >
                        {app.online ? '在线' : '离线'}
                      </span>
                      {!app.builtin && (
                        <button
                          type="button"
                          title="从 Hub 移除该应用"
                          onClick={async () => {
                            const res = await window.chatApi?.removeHubApp(app.appId)
                            if (!res?.ok) {
                              setMessages((prev) => [
                                ...prev,
                                {
                                  id: String(Date.now()),
                                  role: 'assistant',
                                  content: `⚠️ 移除 ${app.appId} 失败：${res?.error || '未知错误'}`,
                                  timestamp: Date.now(),
                                },
                              ])
                            }
                            void refreshHubState()
                          }}
                          className="px-1.5 py-0.5 rounded font-terminal text-[9px] border border-rose-400/35 text-rose-300 hover:bg-rose-500/15"
                        >
                          移除
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="text-[10.5px] text-slate-400">{app.description}</div>
                  <div className="space-y-1">
                    {app.tools.map((tool) => (
                      <div
                        key={tool.toolId}
                        className="flex items-center justify-between gap-2 px-2 py-1 rounded-lg bg-black/30 border border-white/[0.07]"
                      >
                        <div className="min-w-0">
                          <div className="font-terminal text-[10.5px] text-slate-200 truncate">
                            {tool.name}
                            <span className="text-slate-500"> · {tool.toolId}</span>
                          </div>
                          <div className="text-[9.5px] text-slate-500 truncate">{tool.description}</div>
                        </div>
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          <span
                            className={`px-1.5 py-0.5 rounded font-terminal text-[9px] ${
                              tool.riskLevel === 'read-only'
                                ? 'bg-sky-500/20 text-sky-300'
                                : tool.riskLevel === 'write-safe'
                                  ? 'bg-amber-500/20 text-amber-300'
                                  : 'bg-rose-500/20 text-rose-300'
                            }`}
                          >
                            {tool.riskLevel}
                          </span>
                          {tool.riskLevel !== 'read-only' && (
                            <button
                              type="button"
                              onClick={async () => {
                                await window.chatApi?.setHubToolTrusted(app.appId, tool.toolId, !tool.trusted)
                                void refreshHubState()
                              }}
                              className={`px-1.5 py-0.5 rounded font-terminal text-[9px] border transition-all ${
                                tool.trusted
                                  ? 'bg-emerald-500/20 border-emerald-400/40 text-emerald-300'
                                  : 'bg-white/5 border-white/15 text-slate-400 hover:text-white'
                              }`}
                            >
                              {tool.trusted ? '已信任' : '需批准'}
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={runningHubTool !== null || !app.online}
                            onClick={async () => {
                              const key = `${app.appId}/${tool.toolId}`
                              setRunningHubTool(key)
                              try {
                                const res = await window.chatApi?.runHubTool(app.appId, tool.toolId, {})
                                if (!res?.ok) {
                                  setMessages((prev) => [
                                    ...prev,
                                    {
                                      id: String(Date.now()),
                                      role: 'assistant',
                                      content: `⚠️ 调用 ${key} 失败：${res?.error || '未知错误'}`,
                                      timestamp: Date.now(),
                                    },
                                  ])
                                } else {
                                  void refreshHubState()
                                }
                              } finally {
                                setRunningHubTool(null)
                              }
                            }}
                            className="liquid-glass-pill px-1.5 py-0.5 rounded font-terminal text-[9px] text-sky-200 disabled:opacity-40"
                          >
                            {runningHubTool === `${app.appId}/${tool.toolId}` ? '...' : '调用'}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {(hubState?.tasks || []).filter((t) => !['completed', 'failed', 'cancelled'].includes(t.status)).length > 0 && (
              <div className="pt-2 border-t border-white/10 space-y-1.5">
                <div className="font-terminal text-[10.5px] text-slate-300">进行中的任务</div>
                {(hubState?.tasks || [])
                  .filter((t) => !['completed', 'failed', 'cancelled'].includes(t.status))
                  .slice(0, 6)
                  .map((task) => (
                    <div
                      key={task.taskId}
                      className="px-2.5 py-1.5 rounded-lg bg-white/[0.03] border border-white/10 flex items-center justify-between gap-2"
                    >
                      <div className="min-w-0 font-terminal text-[10.5px] text-slate-200 truncate">
                        {task.appId} / {task.toolId}
                        <span className="text-slate-500">
                          {' '}· {formatHubTaskStatus(task.status)}
                          {' '}· {formatHubTaskOrigin(task.origin)}
                        </span>
                        {task.progress?.message && (
                          <span className="text-slate-400"> · {task.progress.message}</span>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={async () => {
                          await window.chatApi?.cancelHubTask(task.taskId)
                          void refreshHubState()
                        }}
                        className="text-rose-300 hover:text-rose-200 font-terminal text-[10px] flex-shrink-0"
                      >
                        取消
                      </button>
                    </div>
                  ))}
              </div>
            )}
          </div>
        )}

        {/* Settings Drawer (/settings · Appearance, Network & Secretary Workflows) */}
        {showSettings && (
          <div className="no-drag bg-[#07090f]/95 backdrop-blur-2xl border-b border-white/15 px-4 py-3.5 space-y-3.5 text-xs animate-in slide-in-from-top-2 duration-200 max-h-[380px] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-white/10 pb-2">
              <div className="flex items-center gap-2 text-white font-terminal text-xs">
                <Globe className="w-3.5 h-3.5 text-sky-400" />
                <span>terminal settings · 外观 · 小秘书日程与工作流配置</span>
              </div>
              <button
                onClick={() => setShowSettings(false)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Appearance / Opacity Configuration */}
            <div className="space-y-2 pb-2 border-b border-white/10">
              <div className="flex items-center justify-between font-terminal">
                <span className="text-slate-200 font-medium">窗口材质与不透明度</span>
                <span className="text-sky-300">{appearance.opacity}%</span>
              </div>
              <div className="grid grid-cols-3 gap-2 font-terminal">
                {[
                  { id: 'obsidian', label: '纯黑不透明 (100%)', opacity: 100 },
                  { id: 'carbon', label: '炭黑微透 (92%)', opacity: 92 },
                  { id: 'crystal', label: '液态透光 (72%)', opacity: 72 },
                ].map((item) => (
                  <button
                    key={item.id}
                    onClick={() =>
                      updateAppearance({
                        preset: item.id as 'obsidian' | 'carbon' | 'crystal',
                        opacity: item.opacity,
                      })
                    }
                    className={`py-1.5 px-2 rounded-lg border text-center transition-all ${
                      appearance.preset === item.id
                        ? 'bg-sky-500/25 border-sky-400/60 text-sky-100 font-medium shadow-inner'
                        : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-3 pt-1 font-terminal text-[11px] text-slate-400">
                <span>透明 45%</span>
                <input
                  type="range"
                  min={45}
                  max={100}
                  value={appearance.opacity}
                  onChange={(e) => {
                    const val = Number(e.target.value)
                    const preset = val === 100 ? 'obsidian' : val >= 88 ? 'carbon' : 'crystal'
                    updateAppearance({ preset, opacity: val })
                  }}
                  className="flex-1 accent-sky-400 cursor-pointer h-1.5 bg-white/15 rounded-lg"
                />
                <span>纯黑 100%</span>
              </div>
              <div className="flex items-center justify-between pt-1.5 font-terminal text-[11px] text-slate-400">
                <span>当前终端尺寸: {winBounds.width} × {winBounds.height} px (鼠标拖四边/右下角缩放)</span>
                <button
                  type="button"
                  onClick={() => window.chatApi?.resetBounds()}
                  className="text-sky-300 hover:text-sky-200 underline"
                >
                  重置默认尺寸 (640×560)
                </button>
              </div>
            </div>

            <div className="space-y-2">
              <div className="grid grid-cols-3 gap-2 font-terminal">
                {[
                  { id: 'system', label: 'system (默认)' },
                  { id: 'custom', label: 'custom 代理' },
                  { id: 'direct', label: 'direct 直连' },
                ].map((item) => (
                  <button
                    key={item.id}
                    onClick={() => handleSaveProxy({ ...proxyConfig, mode: item.id as any })}
                    className={`py-1.5 px-2 rounded-lg border text-center transition-all ${
                      proxyConfig.mode === item.id
                        ? 'bg-sky-500/25 border-sky-400/60 text-sky-100 font-medium shadow-inner'
                        : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              {proxyConfig.mode === 'custom' && (
                <div className="pt-1 flex gap-2">
                  <input
                    type="text"
                    value={proxyConfig.customRules || ''}
                    onChange={(e) => setProxyConfig({ ...proxyConfig, customRules: e.target.value })}
                    placeholder="http://127.0.0.1:7890 或 socks5://127.0.0.1:1080"
                    className="flex-1 bg-black/30 border border-white/15 rounded-lg px-2.5 py-1 text-slate-100 placeholder:text-slate-500 font-terminal text-xs focus:outline-none focus:border-sky-400"
                  />
                  <button
                    onClick={() => handleSaveProxy(proxyConfig)}
                    className="liquid-glass-pill px-3 py-1 rounded-lg text-xs text-sky-200"
                  >
                    保存
                  </button>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between pt-1 border-t border-white/10">
              <div className="flex items-center gap-2">
                <button
                  onClick={handleTestProxy}
                  disabled={isTestingNet}
                  className="liquid-glass-pill flex items-center gap-1.5 px-3 py-1 rounded-lg text-slate-100 transition-colors disabled:opacity-50 font-terminal"
                >
                  {isTestingNet ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-400" />
                  ) : (
                    <Wifi className="w-3.5 h-3.5 text-sky-400" />
                  )}
                  <span>ping muse.ai</span>
                </button>

                {testResult && (
                  <span
                    className={`px-2 py-0.5 rounded font-terminal text-[11px] ${
                      testResult.success
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                        : 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                    }`}
                  >
                    {testResult.success
                      ? `✓ ${testResult.latencyMs}ms`
                      : `✗ ${testResult.message}`}
                  </span>
                )}
              </div>
            </div>

            {/* Manual Cookie fallback */}
            <div className="pt-2 border-t border-white/10 space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-slate-300 font-medium flex items-center gap-1.5">
                  <Key className="w-3.5 h-3.5 text-amber-400" />
                  <span>手动导入 hatch_sess Cookie</span>
                </label>
                {cookieSavedToast && (
                  <span className="text-emerald-400 font-terminal text-[11px]">✓ saved</span>
                )}
              </div>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={manualCookie}
                  onChange={(e) => setManualCookie(e.target.value)}
                  placeholder="粘贴 Cookie 字符串 (如 hatch_sess=...)"
                  className="flex-1 bg-black/30 border border-white/15 rounded-lg px-2.5 py-1 text-slate-100 placeholder:text-slate-500 font-terminal text-xs focus:outline-none focus:border-amber-400"
                />
                <button
                  onClick={handleSaveManualCookie}
                  className="liquid-glass-pill px-3 py-1 rounded-lg text-xs text-amber-200"
                >
                  导入
                </button>
              </div>
            </div>

            {/* 4. Installed Self-Modifying UI Plugins & Widgets Manager */}
            {secretaryState && (
            <div className="space-y-2 pt-2 border-t border-white/10">
              <div className="flex items-center justify-between text-slate-200 font-medium">
                <span className="flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-fuchsia-400" />
                  <span>已安装的界面主题与小功能插件 ({(secretaryState.plugins || []).length})</span>
                </span>
                {(secretaryState.plugins || []).length > 0 && (
                  <button
                    type="button"
                    onClick={async () => {
                      const st = await window.chatApi?.resetAllPlugins()
                      if (st) setSecretaryState(st)
                    }}
                    className="text-[10.5px] text-rose-300 hover:text-rose-200 underline"
                  >
                    一键重置恢复默认 (/reset-ui)
                  </button>
                )}
              </div>
              {(secretaryState.plugins || []).length === 0 ? (
                <div className="text-[11px] text-slate-400">
                  暂无自定义插件。直接告诉 Luna 你想怎么改界面或加什么小功能即可实时热生成。
                </div>
              ) : (
                <div className="space-y-1.5">
                  {(secretaryState.plugins || []).map((plg) => (
                    <div
                      key={plg.id}
                      className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-white/[0.04] border border-white/10 text-[11px]"
                    >
                      <div className="min-w-0 flex-1 pr-2">
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium text-slate-100 truncate">{plg.name}</span>
                          <span className="px-1.5 py-0.2 rounded bg-fuchsia-500/20 border border-fuchsia-400/35 text-[9.5px] text-fuchsia-200">
                            {plg.category}
                          </span>
                        </div>
                        <div className="text-[10px] text-slate-400 truncate">
                          {plg.description}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <button
                          type="button"
                          onClick={async () => {
                            const st = await window.chatApi?.togglePlugin(plg.id)
                            if (st) setSecretaryState(st)
                          }}
                          className={`px-2 py-0.5 rounded text-[10px] border transition-all ${
                            plg.enabled
                              ? 'bg-emerald-500/25 border-emerald-400/50 text-emerald-200'
                              : 'bg-white/5 border-white/15 text-slate-400'
                          }`}
                        >
                          {plg.enabled ? '已启用' : '已停用'}
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            const st = await window.chatApi?.removePlugin(plg.id)
                            if (st) setSecretaryState(st)
                          }}
                          className="text-slate-400 hover:text-rose-400 p-0.5"
                          title="卸载此插件"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            )}
          </div>
        )}

        {/* Auth Notice if offline */}
        {!authProfile.isLoggedIn && (
          <div className="no-drag bg-sky-500/10 px-4 py-2 border-b border-white/10 flex items-center justify-between text-xs text-sky-100">
            <div className="flex items-center gap-2 font-terminal">
              <Sparkles className="w-3.5 h-3.5 text-sky-400 flex-shrink-0" />
              <span>session unauthenticated · 登录 Meta Muse 以同步实时智能体</span>
            </div>
            <button
              onClick={handleLogin}
              className="underline hover:text-white flex items-center gap-1 font-terminal ml-2"
            >
              /login <ExternalLink className="w-3 h-3" />
            </button>
          </div>
        )}

        {/* Terminal Stream Blocks Area */}
        <div className="no-drag flex-1 overflow-y-auto px-4 py-3.5 space-y-3 select-text">
          {messages.map((msg) => {
            if (msg.role === 'user') {
              return (
                <div
                  key={msg.id}
                  className="liquid-glass-block px-3.5 py-2.5 flex items-start gap-2.5 border-l-2 border-l-sky-400/80"
                >
                  <span className="font-terminal text-sky-400 font-bold text-xs mt-0.5 select-none">
                    ❯
                  </span>
                  <div className="flex-1 min-w-0 space-y-2">
                    {msg.content.includes('[MUSE_PC_STATUS]') ? (
                      <div className="flex items-center gap-2 font-terminal text-[11.5px] text-emerald-200">
                        <span className="px-2 py-0.5 rounded-md bg-emerald-500/20 border border-emerald-400/40 flex items-center gap-1">
                          <Cpu className="w-3 h-3 text-emerald-300" />
                          <span>PC 状态数据已上报</span>
                        </span>
                        <span className="text-slate-400 truncate">
                          {msg.content.split('\n').find(l => l.startsWith('Capture started:')) || ''}
                        </span>
                      </div>
                    ) : (
                      <div className="font-terminal text-[13px] text-sky-100 whitespace-pre-wrap break-words">
                        {msg.content}
                      </div>
                    )}
                    {msg.attachments && msg.attachments.length > 0 && (
                      <div className="flex flex-wrap gap-2 pt-1">
                        {msg.attachments.map((att, aIdx) =>
                          att.type === 'image' ? (
                            <button
                              key={aIdx}
                              type="button"
                              onClick={() => setPreviewMedia(att)}
                              className="group relative rounded-xl overflow-hidden border border-white/15 bg-black/40 hover:border-sky-400/60 transition-all shadow-md"
                            >
                              <img
                                src={att.url}
                                alt={att.title || 'attachment'}
                                className="max-h-48 max-w-[260px] object-contain block"
                              />
                            </button>
                          ) : (
                            <div
                              key={aIdx}
                              onClick={() => setPreviewMedia(att)}
                              className="cursor-pointer rounded-xl overflow-hidden border border-white/15 bg-black/40 hover:border-sky-400/60 transition-all shadow-md"
                            >
                              <video
                                src={att.url}
                                autoPlay
                                loop
                                muted
                                playsInline
                                className="max-h-52 max-w-[260px] object-contain block"
                              />
                            </div>
                          )
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )
            }

            if (msg.role === 'system') {
              return (
                <div
                  key={msg.id}
                  className="rounded-xl px-3.5 py-2 bg-rose-950/45 border border-rose-400/35 font-terminal text-xs text-rose-200"
                >
                  ! {msg.content}
                </div>
              )
            }

            return (
              <div key={msg.id} className="liquid-glass-block px-3.5 py-3 flex items-start gap-3">
                {authProfile.avatarUrl ? (
                  <button
                    type="button"
                    onClick={() =>
                      setPreviewMedia({
                        type: 'image',
                        url: authProfile.avatarUrl!,
                        title: `${agentDisplayName} · 完整全身立绘 (1600×1600)`,
                      })
                    }
                    title="点击查看完整全身立绘"
                    className="flex-shrink-0 mt-0.5 rounded-full focus:outline-none hover:ring-2 hover:ring-sky-400/60 transition-all"
                  >
                    <img
                      src={authProfile.avatarUrl}
                      alt={agentDisplayName}
                      className="w-6 h-6 rounded-full object-cover object-[50%_10%] border border-white/25 shadow-md"
                      draggable={false}
                    />
                  </button>
                ) : (
                  <div className="w-6 h-6 rounded-full bg-sky-500/20 border border-sky-400/30 flex items-center justify-center text-sky-300 flex-shrink-0 mt-0.5">
                    <Bot className="w-3.5 h-3.5" />
                  </div>
                )}

                <div className="flex-1 min-w-0 space-y-2">
                  <div className="flex items-center gap-2 mb-1 font-terminal text-[11px] text-slate-300/75">
                    <span className="text-sky-300 font-medium">{agentDisplayName}</span>
                    <span>·</span>
                    <span>stdout</span>
                  </div>
                  {msg.content ? (
                    <MarkdownContent
                      content={msg.content}
                      isStreaming={msg.status === 'streaming'}
                      onRunCodeBlock={handleRunCodeBlock}
                    />
                  ) : !msg.browser && (!msg.attachments || msg.attachments.length === 0) ? (
                    <div className="flex items-center gap-2 font-terminal text-xs text-sky-300/80 py-0.5">
                      <span>thinking</span>
                      <span className="animate-terminal-cursor" />
                    </div>
                  ) : null}

                  {msg.browser && (
                    <div>
                      <button
                        type="button"
                        disabled={openingBrowser !== null}
                        title="打开此消息的原生浏览器预览；如需控制，请使用原生页面控件"
                        className="liquid-glass-pill px-3 py-1.5 rounded-lg text-xs text-sky-200 disabled:opacity-50 flex items-center gap-1.5"
                        onClick={async () => {
                          setOpeningBrowser(msg.id)
                          setBrowserErrors(previous => ({ ...previous, [msg.id]: '' }))
                          try {
                            const result = await window.chatApi?.openCloudBrowser(msg.browser!)
                            if (!result?.ok) setBrowserErrors(previous => ({
                              ...previous, [msg.id]: result?.error || '无法连接浏览器预览。',
                            }))
                          } catch {
                            setBrowserErrors(previous => ({ ...previous, [msg.id]: '打开浏览器失败，请重试。' }))
                          } finally {
                            setOpeningBrowser(null)
                          }
                        }}
                      >
                        <Globe className="w-3.5 h-3.5" />
                        {openingBrowser === msg.id ? '正在打开…' : '打开浏览器'}
                      </button>
                      {browserErrors[msg.id] && <p role="alert" className="mt-1 text-xs text-red-300">{browserErrors[msg.id]}</p>}
                    </div>
                  )}

                  {/* Live Self-Modifying UI Plugin Control Card */}
                  {msg.appliedPlugin && (
                    <div className="mt-2.5 rounded-xl border border-fuchsia-400/40 bg-slate-950/85 overflow-hidden shadow-lg">
                      <div className="flex items-center justify-between px-3 py-2 bg-fuchsia-500/15 border-b border-fuchsia-400/25">
                        <div className="flex items-center gap-2 font-terminal text-xs text-fuchsia-200">
                          <Sparkles className="w-3.5 h-3.5 text-fuchsia-400 flex-shrink-0" />
                          <span className="font-semibold">{msg.appliedPlugin.name}</span>
                        </div>
                        {(() => {
                          const livePlg = (secretaryState?.plugins || []).find(
                            (p) => p.id === msg.appliedPlugin!.id
                          )
                          const isEnabled = livePlg ? livePlg.enabled : false
                          return (
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-terminal ${
                                isEnabled
                                  ? 'bg-emerald-500/25 text-emerald-200 border border-emerald-400/40'
                                  : 'bg-slate-700/60 text-slate-300'
                              }`}
                            >
                              {isEnabled ? '⚡ 已热加载生效' : '已停用'}
                            </span>
                          )
                        })()}
                      </div>
                      <div className="p-3 space-y-2.5 font-terminal text-xs">
                        <div className="text-[11.5px] text-slate-300/90">
                          {msg.appliedPlugin.description}
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={async () => {
                              const st = await window.chatApi?.togglePlugin(msg.appliedPlugin!.id)
                              if (st) setSecretaryState(st)
                            }}
                            className="px-3 py-1 rounded-lg bg-fuchsia-500/25 hover:bg-fuchsia-500/40 border border-fuchsia-400/50 text-fuchsia-100 text-[11px] transition-all"
                          >
                            {(() => {
                              const livePlg = (secretaryState?.plugins || []).find(
                                (p) => p.id === msg.appliedPlugin!.id
                              )
                              return livePlg?.enabled ? '停用此修改' : '重新启用'
                            })()}
                          </button>
                          <button
                            type="button"
                            onClick={async () => {
                              const st = await window.chatApi?.removePlugin(msg.appliedPlugin!.id)
                              if (st) setSecretaryState(st)
                            }}
                            className="px-3 py-1 rounded-lg bg-rose-500/20 hover:bg-rose-500/35 border border-rose-400/40 text-rose-200 text-[11px] transition-all"
                          >
                            卸载并回滚
                          </button>
                          <button
                            type="button"
                            onClick={() => setShowSettings(true)}
                            className="px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 border border-white/15 text-slate-300 text-[11px] transition-all"
                          >
                            插件管理 ({(secretaryState?.plugins || []).length})
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Terminal Authorization Card — PowerShell / Hub tool gates */}
                  {msg.pendingAction && (
                    <div
                      className={`mt-2.5 rounded-xl border bg-slate-950/85 overflow-hidden shadow-lg ${
                        msg.pendingAction.type === 'hub_tool'
                          ? 'border-fuchsia-400/35'
                          : 'border-amber-400/35'
                      }`}
                    >
                      <div
                        className={`flex items-center justify-between px-3 py-2 border-b ${
                          msg.pendingAction.type === 'hub_tool'
                            ? 'bg-fuchsia-500/15 border-fuchsia-400/25'
                            : 'bg-amber-500/15 border-amber-400/25'
                        }`}
                      >
                        <div
                          className={`flex items-center gap-2 font-terminal text-xs ${
                            msg.pendingAction.type === 'hub_tool' ? 'text-fuchsia-200' : 'text-amber-200'
                          }`}
                        >
                          {msg.pendingAction.type === 'hub_tool' ? (
                            <Plug className="w-3.5 h-3.5 text-fuchsia-400 flex-shrink-0" />
                          ) : (
                            <ShieldAlert className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
                          )}
                          <span className="font-semibold">{msg.pendingAction.title}</span>
                          {msg.pendingAction.type === 'hub_tool' && (
                            <span className="px-1.5 py-0.5 rounded bg-fuchsia-500/20 border border-fuchsia-400/35 text-fuchsia-200 text-[9.5px]">
                              Local Agent Hub
                            </span>
                          )}
                        </div>
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-terminal ${
                            msg.pendingAction.status === 'pending'
                              ? msg.pendingAction.type === 'hub_tool'
                                ? 'bg-fuchsia-500/25 text-fuchsia-200 border border-fuchsia-400/40'
                                : 'bg-amber-500/25 text-amber-200 border border-amber-400/40'
                              : msg.pendingAction.status === 'executed' ||
                                  (msg.pendingAction.type === 'hub_tool' &&
                                    msg.pendingAction.status === 'approved')
                              ? 'bg-emerald-500/25 text-emerald-200 border border-emerald-400/40'
                              : msg.pendingAction.status === 'denied'
                              ? 'bg-slate-700/60 text-slate-300'
                              : 'bg-rose-500/25 text-rose-200 border border-rose-400/40'
                          }`}
                        >
                          {msg.pendingAction.status === 'pending'
                            ? '待授权确认'
                            : msg.pendingAction.type === 'hub_tool' &&
                                msg.pendingAction.status === 'approved'
                            ? '已批准调度'
                            : msg.pendingAction.status === 'approved'
                            ? '正在执行...'
                            : msg.pendingAction.status === 'executed'
                            ? '已批准执行'
                            : msg.pendingAction.status === 'denied'
                            ? '已拒绝'
                            : '执行异常'}
                        </span>
                      </div>

                      <div className="p-3 space-y-2">
                        <div className="text-[11px] text-slate-300/80 font-terminal">
                          {msg.pendingAction.description}
                        </div>
                        {msg.pendingAction.type === 'hub_tool' &&
                          (msg.pendingAction.hubAppId || msg.pendingAction.hubToolId) && (
                            <div className="font-terminal text-[10px] text-fuchsia-200/80">
                              {msg.pendingAction.hubAppId}
                              {msg.pendingAction.hubToolId
                                ? ` / ${msg.pendingAction.hubToolId}`
                                : ''}
                            </div>
                          )}
                        <pre
                          className={`p-2.5 rounded-lg bg-black/70 border border-white/10 font-terminal text-xs overflow-x-auto whitespace-pre-wrap ${
                            msg.pendingAction.type === 'hub_tool'
                              ? 'text-fuchsia-100'
                              : 'text-amber-100'
                          }`}
                        >
                          <code>
                            {msg.pendingAction.type === 'hub_tool'
                              ? `参数:\n${msg.pendingAction.command}`
                              : msg.pendingAction.command}
                          </code>
                        </pre>

                        {msg.pendingAction.status === 'pending' && (
                          <div className="flex items-center gap-2.5 pt-1">
                            <button
                              type="button"
                              onClick={() => handleApproveAction(msg.pendingAction!.id)}
                              className="px-3 py-1.5 rounded-lg bg-emerald-500/25 hover:bg-emerald-500/40 border border-emerald-400/50 text-emerald-100 font-terminal text-xs flex items-center gap-1.5 transition-all shadow-sm"
                            >
                              <Check className="w-3.5 h-3.5 text-emerald-300" />
                              <span>
                                {msg.pendingAction.type === 'hub_tool'
                                  ? '批准调度 (Allow)'
                                  : '批准执行 (Allow)'}
                              </span>
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDenyAction(msg.pendingAction!.id)}
                              className="px-3 py-1.5 rounded-lg bg-rose-500/20 hover:bg-rose-500/35 border border-rose-400/40 text-rose-200 font-terminal text-xs flex items-center gap-1.5 transition-all"
                            >
                              <X className="w-3.5 h-3.5 text-rose-300" />
                              <span>拒绝 (Deny)</span>
                            </button>
                          </div>
                        )}

                        {msg.pendingAction.output && (
                          <div className="pt-1.5 space-y-1.5">
                            <div className="flex items-center justify-between text-[10.5px] font-terminal text-slate-400">
                              <span>
                                {msg.pendingAction.type === 'hub_tool'
                                  ? 'Hub 调度结果:'
                                  : '终端执行结果 (stdout/stderr):'}
                              </span>
                              {msg.pendingAction.status === 'executed' &&
                                msg.pendingAction.type !== 'hub_tool' && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleSend(
                                      `我刚才批准执行了命令 \`${msg.pendingAction!.command}\`，输出如下，请帮我分析结果：\n\`\`\`text\n${msg.pendingAction!.output?.slice(0, 1200)}\n\`\`\``
                                    )
                                  }
                                  className="text-sky-300 hover:text-sky-200 underline"
                                >
                                  发送结果给 {agentDisplayName} 分析 →
                                </button>
                              )}
                            </div>
                            <pre className="p-2.5 rounded-lg bg-slate-900/90 border border-emerald-400/25 font-terminal text-[11.5px] text-emerald-200 max-h-44 overflow-y-auto whitespace-pre-wrap">
                              {msg.pendingAction.output}
                            </pre>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {msg.attachments && msg.attachments.length > 0 && (
                    <div className="flex flex-wrap gap-2.5 pt-1">
                      {msg.attachments.map((att, aIdx) =>
                        att.type === 'image' ? (
                          <button
                            key={aIdx}
                            type="button"
                            onClick={() => setPreviewMedia(att)}
                            title="点击放大查看图片"
                            className="group relative rounded-xl overflow-hidden border border-white/15 bg-black/50 hover:border-sky-400/60 transition-all shadow-lg"
                          >
                            <img
                              src={att.url}
                              alt={att.title || 'Muse Image'}
                              className="max-h-56 max-w-[300px] object-contain block group-hover:scale-[1.02] transition-transform duration-200"
                            />
                            <div className="absolute bottom-1.5 right-1.5 px-2 py-0.5 rounded-md bg-black/70 backdrop-blur-md border border-white/15 font-terminal text-[10px] text-sky-200 opacity-0 group-hover:opacity-100 transition-opacity">
                              点击放大
                            </div>
                          </button>
                        ) : (
                          <div
                            key={aIdx}
                            onClick={() => setPreviewMedia(att)}
                            title="点击放大查看视频"
                            className="group relative cursor-pointer rounded-xl overflow-hidden border border-white/15 bg-black/50 hover:border-sky-400/60 transition-all shadow-lg"
                          >
                            <video
                              src={att.url}
                              autoPlay
                              loop
                              muted
                              playsInline
                              className="max-h-60 max-w-[260px] object-contain block"
                            />
                            <div className="absolute bottom-1.5 right-1.5 px-2 py-0.5 rounded-md bg-black/70 backdrop-blur-md border border-white/15 font-terminal text-[10px] text-sky-200 opacity-85 group-hover:opacity-100 transition-opacity">
                              {att.title || '动作预览 · 点击放大'}
                            </div>
                          </div>
                        )
                      )}
                    </div>
                  )}
                </div>
              </div>
            )
          })}

          {/* Quick command chips when only welcome message exists */}
          {messages.length <= 1 && (
            <div className="pt-1 flex flex-wrap gap-2">
              {[
                '📧 打开 Gmail 筛选未读邮件并总结',
                '📸 /screen 看看我现在的桌面屏幕',
                '🖥️ /sys 查看当前电脑运行状态',
                '/help',
              ].map((prompt, idx) => (
                <button
                  key={idx}
                  onClick={() => handleSend(prompt)}
                  className="liquid-glass-pill px-3 py-1.5 rounded-xl font-terminal text-xs text-slate-200 hover:text-white transition-all text-left flex items-center gap-1.5"
                >
                  <span className="text-sky-400">❯</span>
                  <span>{prompt}</span>
                </button>
              ))}
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* macOS Spotlight / Terminal Command Prompt Bar */}
        <div className="no-drag liquid-glass-prompt px-4 py-2.5">
          <div className="flex items-center gap-2.5">
            <span className="font-terminal text-sm font-bold text-sky-400 drop-shadow-[0_0_10px_rgba(56,189,248,0.65)] flex-shrink-0">
              {agentSlug} ❯
            </span>

            <textarea
              ref={textareaRef}
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="输入问题或吩咐小秘书（如：打开 Gmail 筛选未读邮件 / /screen / /sys / /help）..."
              className="flex-1 bg-transparent text-[14px] text-white placeholder-slate-300/50 font-terminal resize-none outline-none max-h-28 leading-relaxed"
            />

            {/* Quick PC Secretary action triggers */}
            {!isStreaming && (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => handleSend('/gmail 未读')}
                  title="电脑小秘书：打开 Gmail 筛选未读邮件并总结 (/gmail)"
                  className="liquid-glass-pill p-1.5 rounded-lg text-slate-300 hover:text-sky-300 transition-colors"
                >
                  <Mail className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => handleSend('/screen 帮我看看现在的屏幕内容')}
                  title="电脑小秘书：截取当前桌面发给 Luna 看图分析 (/screen)"
                  className="liquid-glass-pill p-1.5 rounded-lg text-slate-300 hover:text-sky-300 transition-colors"
                >
                  <Camera className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => handleSend('/sys')}
                  title="电脑小秘书：查看当前电脑硬件与高负载进程状态 (/sys)"
                  className="liquid-glass-pill p-1.5 rounded-lg text-slate-300 hover:text-sky-300 transition-colors"
                >
                  <Cpu className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {isStreaming ? (
              <button
                onClick={handleStop}
                title="终止输出 (Ctrl+C)"
                className="liquid-glass-pill px-2.5 py-1 rounded-lg bg-rose-500/30 border-rose-400/50 text-rose-100 font-terminal text-xs flex items-center gap-1"
              >
                <Square className="w-3 h-3 fill-rose-200" />
                <span>stop</span>
              </button>
            ) : (
              <button
                onClick={() => handleSend()}
                disabled={!input.trim()}
                title="执行指令 (Enter)"
                className={`liquid-glass-pill px-2.5 py-1 rounded-lg font-terminal text-xs flex items-center gap-1 transition-all ${
                  input.trim()
                    ? 'text-sky-200 border-sky-400/50 shadow-[0_0_15px_rgba(56,189,248,0.25)]'
                    : 'opacity-40 cursor-not-allowed text-slate-400'
                }`}
              >
                <CornerDownLeft className="w-3 h-3" />
                <span>run</span>
              </button>
            )}
          </div>

          {/* Bottom Status Bar */}
          <div className="flex items-center justify-between mt-2 pt-1.5 border-t border-white/10 font-terminal text-[10.5px] text-slate-300/65 pr-3">
            <div className="flex items-center gap-3">
              <span>⌥ Space 唤起/隐藏</span>
              <span>Esc 收起</span>
              <span>↑/↓ 历史命令</span>
              <span>鼠标拖边缘缩放</span>
            </div>
            <span>
              {winBounds.width}×{winBounds.height} · liquid-glass tty
            </span>
          </div>
        </div>

        {/* Fullscreen Lightbox Modal for Image / Video Preview */}
        {previewMedia && (
          <div
            onClick={() => setPreviewMedia(null)}
            className="no-drag fixed inset-2 z-50 rounded-[22px] bg-black/90 backdrop-blur-xl flex flex-col items-center justify-center p-4 animate-in fade-in duration-150"
          >
            <div className="w-full flex items-center justify-between px-2 pb-2 font-terminal text-xs text-slate-300">
              <span>{previewMedia.title || 'Muse Media Preview'}</span>
              <button
                onClick={() => setPreviewMedia(null)}
                className="liquid-glass-pill px-2.5 py-1 rounded-lg text-slate-200 hover:text-white flex items-center gap-1"
              >
                <X className="w-3.5 h-3.5" />
                <span>关闭 (Esc)</span>
              </button>
            </div>
            <div
              onClick={(e) => e.stopPropagation()}
              className="flex-1 flex items-center justify-center overflow-hidden max-h-[460px] w-full"
            >
              {previewMedia.type === 'image' ? (
                <img
                  src={previewMedia.url}
                  alt={previewMedia.title || 'preview'}
                  className="max-h-full max-w-full object-contain rounded-xl border border-white/15 shadow-2xl"
                />
              ) : (
                <video
                  src={previewMedia.url}
                  controls
                  autoPlay
                  loop
                  playsInline
                  className="max-h-full max-w-full object-contain rounded-xl border border-white/15 shadow-2xl"
                />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
