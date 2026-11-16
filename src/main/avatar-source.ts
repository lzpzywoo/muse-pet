/** Self-contained DOM reader embedded in both polling and extraction. */
export function readAvatarSource(doc: Document) {
  const mediaUrl = (value: unknown): string =>
    typeof value === 'string' && /^(blob:|https:\/\/)/i.test(value) ? value : ''
  const layers = Array.from(doc.querySelectorAll<HTMLVideoElement | HTMLImageElement>(
    'video[data-hatch-avatar-layer], img[data-hatch-avatar-layer]'
  )).filter(el => !el.closest('[data-message-item="true"]') &&
    !['previous', 'outgoing'].includes(el.getAttribute?.('data-hatch-avatar-slot') || ''))
  const priority = (el: HTMLVideoElement | HTMLImageElement) =>
    (el.getAttribute?.('data-hatch-avatar-slot') === 'current' ? 8 : 0) +
    (el.getAttribute?.('data-hatch-avatar-layer') === 'ready' ? 4 : 0) +
    (el.tagName?.toUpperCase() === 'VIDEO' ? 1 : 0)
  layers.sort((a, b) => priority(b) - priority(a))
  const layer = layers[0]
  if (!layer) return null
  const imageOnly = layer.tagName?.toUpperCase() === 'IMG'
  const liveUrl = mediaUrl(layer.currentSrc) || mediaUrl(layer.src) || mediaUrl(layer.querySelector('source')?.src)
  let staticUrl = imageOnly ? liveUrl : ''
  let videoMap: { default: string; working: string; resume: string } | null = null
  if (!imageOnly) {
    const key = Object.keys(layer).find(k => k.startsWith('__reactFiber'))
    let fiber: any = key ? (layer as any)[key] : null
    const fibers = new Set<any>()
    for (let depth = 0; fiber && depth < 80 && !fibers.has(fiber); depth++, fiber = fiber.return) {
      fibers.add(fiber)
      let hook = fiber.memoizedState
      const hooks = new Set<any>()
      for (let count = 0; hook && count < 100 && !hooks.has(hook); count++, hook = hook.next) {
        hooks.add(hook)
        const state = hook.memoizedState
        const value = state?.current?.value !== undefined ? state.current.value : state
        if (!staticUrl && mediaUrl(value)) staticUrl = mediaUrl(value)
        if (!videoMap && value && typeof value === 'object' && mediaUrl(value.default)) {
          const defaultUrl = mediaUrl(value.default)
          if ((value.working && !mediaUrl(value.working)) || (value.resume && !mediaUrl(value.resume))) return null
          videoMap = {
            default: defaultUrl,
            working: mediaUrl(value.working) || defaultUrl,
            resume: mediaUrl(value.resume) || defaultUrl,
          }
        }
      }
      if (videoMap) break
    }
  }
  const defaultUrl = imageOnly ? '' : videoMap?.default || liveUrl
  if (!staticUrl && !defaultUrl) return null
  const workingUrl = defaultUrl ? videoMap?.working || defaultUrl : ''
  const resumeUrl = defaultUrl ? videoMap?.resume || defaultUrl : ''
  const surfaceName = doc.querySelector<HTMLElement>('[data-testid="hatch-status-panel-sliding-surface"]')
    ?.innerText?.split('\n')[0]?.trim() || ''
  const rawTitle = (doc.title || '').replace(/^Chat\s*[—-]\s*/i, '').trim()
  const agentName = surfaceName || (rawTitle && !rawTitle.toLowerCase().includes('muse') ? rawTitle : '') || 'Muse'
  return {
    agentName, staticUrl, defaultUrl, workingUrl, resumeUrl,
    avatarSignature: JSON.stringify([agentName, staticUrl, defaultUrl, workingUrl, resumeUrl]),
  }
}
