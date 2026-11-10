import React, { useState, useEffect, useRef } from 'react'
import type { ChatMessage, UserProfile, ProxyConfig, NetworkTestResult } from '../../types'
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
  Terminal
} from 'lucide-react'

// Lightweight Markdown & Code Block Formatter in Liquid Glass Terminal style
function MarkdownContent({ content, isStreaming }: { content: string; isStreaming?: boolean }) {
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null)

  const handleCopy = (text: string, index: number) => {
    navigator.clipboard.writeText(text)
    setCopiedIndex(index)
    setTimeout(() => setCopiedIndex(null), 2000)
  }

  const parts = content.split(/(```[\s\S]*?```)/g)

  return (
    <div className="space-y-2.5 text-[13.5px] leading-relaxed text-slate-100/95">
      {parts.map((part, index) => {
        if (part.startsWith('```') && part.endsWith('```')) {
          const firstLineEnd = part.indexOf('\n')
          const language = firstLineEnd !== -1 ? part.slice(3, firstLineEnd).trim() : ''
          const code = firstLineEnd !== -1 ? part.slice(firstLineEnd + 1, -3) : part.slice(3, -3)

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
  const [input, setInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [authProfile, setAuthProfile] = useState<UserProfile>({ isLoggedIn: false })
  const [showSettings, setShowSettings] = useState(false)
  const [isCompact, setIsCompact] = useState(false)
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

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const agentSlug = (authProfile.agentName || 'luna').toLowerCase().replace(/\s+/g, '-')
  const agentDisplayName = authProfile.agentName || 'Luna'

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

    return () => {
      unsubChunk?.()
      unsubEnd?.()
      unsubError?.()
      unsubAuth?.()
      unsubSynced?.()
    }
  }, [])

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
    if (cmd === '/proxy' || cmd === '/settings' || cmd === '/net' || cmd === '/theme') {
      setShowSettings((s) => !s)
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
            '支持的终端快捷命令：\n```shell\n/sync     # 从 muse.ai 云端会话同步最新对话历史\n/clear    # 清空当前终端历史 (或直接输入 clear)\n/theme    # 打开外观透明度与网络配置面板 (同 /settings)\n/solid    # 切换为 100% 纯黑不透明终端\n/glass    # 切换为半透明液态玻璃终端\n/login    # 登录或刷新 Meta Muse 会话\n/exit     # 收起终端窗口 (同 Esc / Alt+Space)\n↑ / ↓     # 翻阅历史输入指令\n```',
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

  return (
    <div className="w-screen h-screen p-2 flex flex-col select-none overflow-hidden">
      <div
        style={{ '--terminal-alpha': appearance.opacity / 100 } as React.CSSProperties}
        className={`liquid-glass-shell w-full ${
          isCompact ? 'h-[430px]' : 'h-full'
        } flex flex-col text-slate-100 overflow-hidden transition-all duration-300`}
      >
        {/* macOS Terminal Titlebar (Draggable) */}
        <div className="draggable liquid-glass-header flex items-center justify-between px-4 py-2.5 select-none">
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
              onClick={() => setIsCompact((v) => !v)}
              title="切换紧凑/标准终端尺寸"
              className="w-3 h-3 rounded-full bg-[#27c93f] border border-black/15 shadow-inner flex items-center justify-center text-[9px] font-bold text-black/75 hover:brightness-110 transition-all"
            >
              <span className="opacity-0 group-hover:opacity-100 leading-none">+</span>
            </button>
          </div>

          {/* Center: Terminal Path & Live Session Status */}
          <div className="flex items-center gap-2 font-terminal text-xs text-slate-200/90">
            {authProfile.avatarUrl ? (
              <img
                src={authProfile.avatarUrl}
                alt={agentDisplayName}
                className="w-4 h-4 rounded-full object-cover border border-white/30 shadow-sm"
                draggable={false}
              />
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
              onClick={handleClear}
              title="清屏 (/clear)"
              className="liquid-glass-pill px-2 py-1 rounded-lg text-slate-200/85 hover:text-white transition-all"
            >
              /clear
            </button>
            <button
              onClick={() => setShowSettings((s) => !s)}
              title="外观透明度与网络配置 (/settings)"
              className={`liquid-glass-pill px-2 py-1 rounded-lg transition-all ${
                showSettings ? 'text-sky-300 border-sky-400/50' : 'text-slate-200/85 hover:text-white'
              }`}
            >
              /settings
            </button>
          </div>
        </div>

        {/* Settings Drawer (/settings · Appearance & Network) */}
        {showSettings && (
          <div className="no-drag bg-[#07090f]/95 backdrop-blur-2xl border-b border-white/15 px-4 py-3.5 space-y-3.5 text-xs animate-in slide-in-from-top-2 duration-200">
            <div className="flex items-center justify-between border-b border-white/10 pb-2">
              <div className="flex items-center gap-2 text-white font-terminal text-xs">
                <Globe className="w-3.5 h-3.5 text-sky-400" />
                <span>terminal appearance & network settings</span>
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
                    <div className="font-terminal text-[13px] text-sky-100 whitespace-pre-wrap break-words">
                      {msg.content}
                    </div>
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
                  <img
                    src={authProfile.avatarUrl}
                    alt={agentDisplayName}
                    className="w-6 h-6 rounded-full object-cover border border-white/25 flex-shrink-0 mt-0.5 shadow-md"
                    draggable={false}
                  />
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
                    />
                  ) : !msg.attachments || msg.attachments.length === 0 ? (
                    <div className="flex items-center gap-2 font-terminal text-xs text-sky-300/80 py-0.5">
                      <span>thinking</span>
                      <span className="animate-terminal-cursor" />
                    </div>
                  ) : null}

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
                '💡 给我一个创意灵感',
                '💻 写一段查询端口占用并清理的 PowerShell 脚本',
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
        <div className="no-drag liquid-glass-prompt px-4 py-3">
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
              placeholder="输入问题或 /clear · /proxy · /help，按 Enter 执行..."
              className="flex-1 bg-transparent text-[14px] text-white placeholder-slate-300/50 font-terminal resize-none outline-none max-h-28 leading-relaxed"
            />

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
          <div className="flex items-center justify-between mt-2 pt-1.5 border-t border-white/10 font-terminal text-[10.5px] text-slate-300/65">
            <div className="flex items-center gap-3">
              <span>⌥ Space 唤起/隐藏</span>
              <span>Esc 收起</span>
              <span>↑/↓ 历史命令</span>
            </div>
            <span>muse.ai · liquid-glass tty</span>
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
