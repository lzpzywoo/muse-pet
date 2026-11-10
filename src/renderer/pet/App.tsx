import React, { useEffect, useRef, useState } from 'react'
import type { AvatarAssets, AvatarState, PetBubblePayload } from '../../types'
import { Sparkles, MessageCircle, AlertCircle, RefreshCw, X, Bell } from 'lucide-react'

const CUTOUT_SIZE = 360

/**
 * Remove the solid white studio background connected to the frame borders
 * while preserving interior whites (eyes, teeth, highlights) and de-spilling
 * white halo on the character's anti-aliased edge pixels.
 */
function removeConnectedWhiteBackground(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  visited: Uint8Array,
  queue: Int32Array
) {
  const frame = ctx.getImageData(0, 0, width, height)
  const data = frame.data
  const total = width * height
  visited.fill(0)

  let head = 0
  let tail = 0

  const isBgCandidate = (idx: number): boolean => {
    const p = idx << 2
    const r = data[p]
    const g = data[p + 1]
    const b = data[p + 2]
    const min = r < g ? (r < b ? r : b) : g < b ? g : b
    const max = r > g ? (r > b ? r : b) : g > b ? g : b
    // Pure or near-white neutral background
    return min >= 234 && max - min <= 18
  }

  // Seed flood-fill from all 4 borders
  for (let x = 0; x < width; x++) {
    if (isBgCandidate(x)) {
      visited[x] = 1
      queue[tail++] = x
    }
    const bottomIdx = (height - 1) * width + x
    if (!visited[bottomIdx] && isBgCandidate(bottomIdx)) {
      visited[bottomIdx] = 1
      queue[tail++] = bottomIdx
    }
  }
  for (let y = 1; y < height - 1; y++) {
    const leftIdx = y * width
    if (!visited[leftIdx] && isBgCandidate(leftIdx)) {
      visited[leftIdx] = 1
      queue[tail++] = leftIdx
    }
    const rightIdx = y * width + (width - 1)
    if (!visited[rightIdx] && isBgCandidate(rightIdx)) {
      visited[rightIdx] = 1
      queue[tail++] = rightIdx
    }
  }

  // Flood-fill 4-connected background
  while (head < tail) {
    const cur = queue[head++]
    const x = cur % width
    const y = (cur / width) | 0

    if (x > 0) {
      const n = cur - 1
      if (!visited[n] && isBgCandidate(n)) {
        visited[n] = 1
        queue[tail++] = n
      }
    }
    if (x < width - 1) {
      const n = cur + 1
      if (!visited[n] && isBgCandidate(n)) {
        visited[n] = 1
        queue[tail++] = n
      }
    }
    if (y > 0) {
      const n = cur - width
      if (!visited[n] && isBgCandidate(n)) {
        visited[n] = 1
        queue[tail++] = n
      }
    }
    if (y < height - 1) {
      const n = cur + width
      if (!visited[n] && isBgCandidate(n)) {
        visited[n] = 1
        queue[tail++] = n
      }
    }
  }

  // Pass 2: clear background and feather/de-spill 1-2px boundary around the character
  for (let idx = 0; idx < total; idx++) {
    const p = idx << 2
    if (visited[idx] === 1) {
      data[p + 3] = 0
      continue
    }

    const x = idx % width
    const y = (idx / width) | 0

    // Count how many 8-neighbors are background
    let bgNeighbors = 0
    if (x > 0 && visited[idx - 1] === 1) bgNeighbors++
    if (x < width - 1 && visited[idx + 1] === 1) bgNeighbors++
    if (y > 0 && visited[idx - width] === 1) bgNeighbors++
    if (y < height - 1 && visited[idx + width] === 1) bgNeighbors++
    if (x > 0 && y > 0 && visited[idx - width - 1] === 1) bgNeighbors++
    if (x < width - 1 && y > 0 && visited[idx - width + 1] === 1) bgNeighbors++
    if (x > 0 && y < height - 1 && visited[idx + width - 1] === 1) bgNeighbors++
    if (x < width - 1 && y < height - 1 && visited[idx + width + 1] === 1) bgNeighbors++

    if (bgNeighbors > 0) {
      const r = data[p]
      const g = data[p + 1]
      const b = data[p + 2]
      const lum = (r * 77 + g * 150 + b * 29) >> 8

      // Estimate foreground alpha on anti-aliased white-blended boundary
      if (lum > 195) {
        const rawAlpha = Math.max(0, Math.min(1, (246 - lum) / 55))
        const neighborFactor = Math.max(0.25, 1 - bgNeighbors * 0.1)
        const alpha = rawAlpha * neighborFactor
        data[p + 3] = (alpha * 255) | 0

        // Unmix white spill: C_fg = (C_obs - (1 - alpha) * 255) / alpha
        if (alpha > 0.08) {
          const invWhite = (1 - alpha) * 255
          data[p] = Math.max(0, Math.min(255, ((r - invWhite) / alpha) | 0))
          data[p + 1] = Math.max(0, Math.min(255, ((g - invWhite) / alpha) | 0))
          data[p + 2] = Math.max(0, Math.min(255, ((b - invWhite) / alpha) | 0))
        }
      } else {
        // Darker boundary pixel: slight soft edge only
        data[p + 3] = bgNeighbors >= 4 ? 200 : 238
      }
    }
  }

  ctx.putImageData(frame, 0, 0)
}

export default function PetApp() {
  const [avatarState, setAvatarState] = useState<AvatarState>('idle')
  const [avatarAssets, setAvatarAssets] = useState<AvatarAssets | null>(null)
  const [bubble, setBubble] = useState<PetBubblePayload | null>(null)
  const [isBubbleHovered, setIsBubbleHovered] = useState(false)
  const [isHovered, setIsHovered] = useState(false)
  const [isBlinking, setIsBlinking] = useState(false)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const defaultVideoRef = useRef<HTMLVideoElement | null>(null)
  const workingVideoRef = useRef<HTMLVideoElement | null>(null)
  const resumeVideoRef = useRef<HTMLVideoElement | null>(null)
  const staticImgRef = useRef<HTMLImageElement | null>(null)
  const activeVariantRef = useRef<'default' | 'working' | 'resume'>('default')

  const activeVideoVariant: 'default' | 'working' | 'resume' =
    avatarState === 'thinking'
      ? 'working'
      : avatarState === 'talking'
      ? 'resume'
      : 'default'

  useEffect(() => {
    activeVariantRef.current = activeVideoVariant
  }, [activeVideoVariant])

  // Natural blinking effect for fallback orb
  useEffect(() => {
    let blinkTimeout: NodeJS.Timeout

    const scheduleNextBlink = () => {
      const nextDelay = 3000 + Math.random() * 4000
      blinkTimeout = setTimeout(() => {
        setIsBlinking(true)
        setTimeout(() => {
          setIsBlinking(false)
          scheduleNextBlink()
        }, 180)
      }, nextDelay)
    }

    scheduleNextBlink()
    return () => clearTimeout(blinkTimeout)
  }, [])

  useEffect(() => {
    window.petApi?.getAvatarState().then((state) => {
      if (state) setAvatarState(state)
    })
    window.petApi?.getAvatarAssets().then((assets) => {
      if (assets) setAvatarAssets(assets)
    })

    const unsubscribeState = window.petApi?.onSyncAvatarState((newState) => {
      setAvatarState(newState)
    })
    const unsubscribeAssets = window.petApi?.onAvatarAssetsUpdated((newAssets) => {
      if (newAssets) setAvatarAssets(newAssets)
    })
    const unsubscribeBubble = window.petApi?.onSpeechBubble((payload) => {
      setBubble(payload)
    })

    return () => {
      unsubscribeState?.()
      unsubscribeAssets?.()
      unsubscribeBubble?.()
    }
  }, [])

  // Auto-hide speech bubble 10s after reply finishes (unless hovered)
  useEffect(() => {
    if (!bubble) return
    if (bubble.status !== 'done' && bubble.status !== 'error') return
    if (isBubbleHovered) return

    const timer = setTimeout(() => {
      setBubble(null)
    }, 10000)

    return () => clearTimeout(timer)
  }, [bubble, isBubbleHovered])

  // Real-time background removal render loop onto transparent canvas
  useEffect(() => {
    if (!avatarAssets) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return

    const visited = new Uint8Array(CUTOUT_SIZE * CUTOUT_SIZE)
    const queue = new Int32Array(CUTOUT_SIZE * CUTOUT_SIZE)
    let rafId = 0
    let lastDrawTime = 0

    const renderFrame = (now: number) => {
      // Cap at ~30 FPS for low GPU/CPU usage
      if (now - lastDrawTime >= 30) {
        const variant = activeVariantRef.current
        const chosenVideo =
          variant === 'working'
            ? workingVideoRef.current || defaultVideoRef.current
            : variant === 'resume'
            ? resumeVideoRef.current || defaultVideoRef.current
            : defaultVideoRef.current

        let drawn = false
        if (chosenVideo && chosenVideo.readyState >= 2 && chosenVideo.videoWidth > 0) {
          ctx.clearRect(0, 0, CUTOUT_SIZE, CUTOUT_SIZE)
          ctx.drawImage(chosenVideo, 0, 0, CUTOUT_SIZE, CUTOUT_SIZE)
          drawn = true
        } else if (
          defaultVideoRef.current &&
          defaultVideoRef.current.readyState >= 2 &&
          defaultVideoRef.current.videoWidth > 0
        ) {
          ctx.clearRect(0, 0, CUTOUT_SIZE, CUTOUT_SIZE)
          ctx.drawImage(defaultVideoRef.current, 0, 0, CUTOUT_SIZE, CUTOUT_SIZE)
          drawn = true
        } else if (
          staticImgRef.current &&
          staticImgRef.current.complete &&
          staticImgRef.current.naturalWidth > 0
        ) {
          ctx.clearRect(0, 0, CUTOUT_SIZE, CUTOUT_SIZE)
          ctx.drawImage(staticImgRef.current, 0, 0, CUTOUT_SIZE, CUTOUT_SIZE)
          drawn = true
        }

        if (drawn) {
          removeConnectedWhiteBackground(ctx, CUTOUT_SIZE, CUTOUT_SIZE, visited, queue)
          lastDrawTime = now
        }
      }
      rafId = requestAnimationFrame(renderFrame)
    }

    rafId = requestAnimationFrame(renderFrame)
    return () => cancelAnimationFrame(rafId)
  }, [avatarAssets])

  const handleMouseEnter = () => {
    setIsHovered(true)
    window.petApi?.setIgnoreMouseEvents(false)
  }

  const handleMouseLeave = () => {
    setIsHovered(false)
  }

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    window.petApi?.toggleChat()
  }

  // Contour drop-shadow based on avatar state (glows around the character silhouette, no circle frame)
  const getCharacterDropShadow = () => {
    switch (avatarState) {
      case 'listening':
        return 'drop-shadow-[0_4px_14px_rgba(34,211,238,0.55)]'
      case 'thinking':
        return 'drop-shadow-[0_4px_16px_rgba(168,85,247,0.65)]'
      case 'talking':
        return 'drop-shadow-[0_4px_18px_rgba(59,130,246,0.7)]'
      case 'error':
        return 'drop-shadow-[0_4px_14px_rgba(244,63,94,0.6)]'
      default:
        return 'drop-shadow-[0_6px_12px_rgba(15,23,42,0.45)]'
    }
  }

  const hasMuseAvatar = Boolean(
    avatarAssets?.videos?.default || avatarAssets?.staticImageUrl
  )
  const defaultVideoUrl = avatarAssets?.videos?.default
  const workingVideoUrl = avatarAssets?.videos?.working || defaultVideoUrl
  const resumeVideoUrl = avatarAssets?.videos?.resume || defaultVideoUrl

  return (
    <div
      className="w-screen h-screen flex flex-col items-center justify-end pb-3 select-none relative overflow-hidden"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Hidden media sources for offscreen cutout processing */}
      {hasMuseAvatar && (
        <div className="hidden" aria-hidden="true">
          {avatarAssets?.staticImageUrl && (
            <img
              ref={staticImgRef}
              src={avatarAssets.staticImageUrl}
              alt=""
              crossOrigin="anonymous"
            />
          )}
          {defaultVideoUrl && (
            <video
              ref={defaultVideoRef}
              key={`src-default-${defaultVideoUrl}`}
              src={defaultVideoUrl}
              autoPlay
              loop
              muted
              playsInline
              crossOrigin="anonymous"
            />
          )}
          {workingVideoUrl && (
            <video
              ref={workingVideoRef}
              key={`src-working-${workingVideoUrl}`}
              src={workingVideoUrl}
              autoPlay
              loop
              muted
              playsInline
              crossOrigin="anonymous"
            />
          )}
          {resumeVideoUrl && (
            <video
              ref={resumeVideoRef}
              key={`src-resume-${resumeVideoUrl}`}
              src={resumeVideoUrl}
              autoPlay
              loop
              muted
              playsInline
              crossOrigin="anonymous"
            />
          )}
        </div>
      )}

      {/* Speech Bubble (冒泡文案 & 新消息提醒) */}
      {bubble && (
        <div
          onMouseEnter={() => setIsBubbleHovered(true)}
          onMouseLeave={() => setIsBubbleHovered(false)}
          onClick={() => {
            window.petApi?.toggleChat()
            window.petApi?.dismissBubble()
          }}
          className="no-drag relative z-30 mb-1.5 w-[256px] max-w-[256px] cursor-pointer group/bubble animate-in fade-in slide-in-from-bottom-2 duration-200"
        >
          <div
            className={`relative rounded-2xl px-3.5 py-2.5 bg-[#080b12]/95 backdrop-blur-xl border shadow-[0_14px_32px_rgba(0,0,0,0.65),inset_0_1px_0_rgba(255,255,255,0.22)] transition-all ${
              bubble.status === 'error'
                ? 'border-rose-400/50 text-rose-100'
                : bubble.status === 'thinking'
                ? 'border-purple-400/45 text-purple-100'
                : 'border-sky-400/45 text-slate-100 hover:border-sky-300/75'
            }`}
          >
            {/* Header row inside bubble */}
            <div className="flex items-center justify-between gap-2 mb-1">
              <div className="flex items-center gap-1.5">
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    bubble.status === 'thinking'
                      ? 'bg-purple-400 animate-ping'
                      : bubble.status === 'streaming'
                      ? 'bg-sky-400 animate-pulse'
                      : bubble.status === 'error'
                      ? 'bg-rose-400'
                      : 'bg-emerald-400'
                  }`}
                />
                <span className="font-terminal text-[10px] font-semibold tracking-wide text-sky-300">
                  {avatarAssets?.agentName || 'Luna'}
                </span>
                {bubble.status === 'done' && (
                  <span className="inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded-full bg-sky-500/20 border border-sky-400/30 text-[9px] text-sky-200">
                    <Bell className="w-2.5 h-2.5 text-sky-300" />
                    新回复
                  </span>
                )}
              </div>

              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setBubble(null)
                  window.petApi?.dismissBubble()
                }}
                title="关闭气泡"
                className="text-slate-400 hover:text-white p-0.5 rounded transition-colors"
              >
                <X className="w-3 h-3" />
              </button>
            </div>

            {/* Bubble body text */}
            <div className="text-[12px] leading-[1.45] text-slate-100/95 break-words line-clamp-4 font-sans">
              {bubble.status === 'thinking' ? (
                <span className="inline-flex items-center gap-1.5 text-purple-200/90">
                  <span>正在思考回答</span>
                  <span className="inline-flex gap-0.5">
                    <span className="w-1 h-1 bg-purple-300 rounded-full animate-bounce"></span>
                    <span className="w-1 h-1 bg-purple-300 rounded-full animate-bounce [animation-delay:0.15s]"></span>
                    <span className="w-1 h-1 bg-purple-300 rounded-full animate-bounce [animation-delay:0.3s]"></span>
                  </span>
                </span>
              ) : (
                <>
                  {bubble.text.length > 110 ? `…${bubble.text.slice(-110)}` : bubble.text}
                  {bubble.status === 'streaming' && (
                    <span className="inline-block w-1.5 h-3 bg-sky-400 ml-1 align-middle animate-pulse" />
                  )}
                </>
              )}
            </div>

            {/* Tail pointer pointing down to Luna */}
            <div className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-3 h-3 rotate-45 bg-[#080b12]/95 border-r border-b border-sky-400/45" />
          </div>
        </div>
      )}

      {/* Pet Interactive Container */}
      <div
        onClick={handleClick}
        className={`draggable relative group cursor-grab active:cursor-grabbing transition-all duration-300 transform ${
          avatarState === 'idle' ? 'animate-breathe' : ''
        } ${avatarState === 'talking' ? 'animate-bounce-subtle' : ''}`}
      >
        {/* Unread badge on pet shoulder when there is a new reply */}
        {bubble && bubble.status === 'done' && (bubble.unreadCount ?? 0) > 0 && (
          <div className="absolute top-2 right-5 z-30 flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-rose-500 text-white font-terminal text-[10px] font-bold shadow-[0_0_12px_rgba(244,63,94,0.8)] border border-white/40 animate-bounce">
            {bubble.unreadCount}
          </div>
        )}
        {hasMuseAvatar ? (
          /* Pure transparent character cutout without any circular background plate */
          <div className="relative w-44 h-44 flex items-center justify-center">
            <canvas
              ref={canvasRef}
              width={CUTOUT_SIZE}
              height={CUTOUT_SIZE}
              className={`w-44 h-44 object-contain pointer-events-none transition-all duration-300 ${getCharacterDropShadow()}`}
            />

            {/* Floating minimal state indicator only when active (thinking / talking / error) */}
            {avatarState !== 'idle' && (
              <div className="absolute bottom-2 right-5 z-20 bg-slate-900/85 backdrop-blur-md p-1.5 rounded-full shadow-lg border border-white/20 text-white">
                {avatarState === 'thinking' ? (
                  <RefreshCw className="w-3.5 h-3.5 text-purple-300 animate-spin" />
                ) : avatarState === 'talking' ? (
                  <div className="flex gap-0.5 items-center justify-center w-3.5 h-3.5">
                    <span className="w-0.5 h-2 bg-cyan-300 rounded-full animate-bounce"></span>
                    <span className="w-0.5 h-3 bg-white rounded-full animate-bounce [animation-delay:0.15s]"></span>
                    <span className="w-0.5 h-2 bg-blue-300 rounded-full animate-bounce [animation-delay:0.3s]"></span>
                  </div>
                ) : avatarState === 'error' ? (
                  <AlertCircle className="w-3.5 h-3.5 text-rose-400" />
                ) : (
                  <Sparkles className="w-3.5 h-3.5 text-cyan-300" />
                )}
              </div>
            )}
          </div>
        ) : (
          /* Fallback: stylized orb when no Muse avatar is cached yet */
          <div className="relative w-36 h-36 rounded-full flex items-center justify-center bg-gradient-to-tr from-slate-900/90 via-indigo-950/80 to-blue-900/90 backdrop-blur-md border border-white/25 transition-all duration-300 shadow-[0_0_20px_rgba(59,130,246,0.25)]">
            <div className="relative w-28 h-28 flex items-center justify-center">
              <div className="absolute inset-0 rounded-full bg-gradient-to-br from-blue-500 via-indigo-600 to-violet-600 opacity-90 blur-sm"></div>
              <div className="relative z-10 w-24 h-24 rounded-full bg-gradient-to-tr from-slate-900 to-indigo-900 flex flex-col items-center justify-center shadow-inner border border-white/30 overflow-hidden">
                <div className="flex items-center gap-4 mb-2 z-10">
                  <div
                    className={`w-3.5 h-4.5 bg-white rounded-full flex items-center justify-center shadow-[0_0_8px_white] transition-transform duration-150 ${
                      isBlinking ? 'scale-y-[0.1]' : ''
                    }`}
                  >
                    {!isBlinking && <div className="w-1.5 h-2 bg-indigo-950 rounded-full"></div>}
                  </div>
                  <div
                    className={`w-3.5 h-4.5 bg-white rounded-full flex items-center justify-center shadow-[0_0_8px_white] transition-transform duration-150 ${
                      isBlinking ? 'scale-y-[0.1]' : ''
                    }`}
                  >
                    {!isBlinking && <div className="w-1.5 h-2 bg-indigo-950 rounded-full"></div>}
                  </div>
                </div>
                <div className="w-3 h-1 bg-white/70 rounded-full"></div>
              </div>
            </div>
          </div>
        )}

        {/* Hover / Tooltip tag */}
        <div
          className={`absolute bottom-0 left-1/2 -translate-x-1/2 whitespace-nowrap bg-slate-900/90 text-slate-200 text-xs px-2.5 py-1 rounded-full border border-white/10 shadow-lg pointer-events-none transition-all duration-200 ${
            isHovered ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-1'
          }`}
        >
          <div className="flex items-center gap-1.5">
            <MessageCircle className="w-3 h-3 text-blue-400" />
            <span>
              {avatarAssets?.agentName ? `与 ${avatarAssets.agentName} 对话` : '点击对话'} · Alt+Space
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
