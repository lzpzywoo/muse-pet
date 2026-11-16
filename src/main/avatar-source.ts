/** Self-contained DOM reader: embedded in both polling and extraction via toString().
 * Only current hooks on the main stage are considered; never follow alternates.
 */
export function readAvatarSource(doc: Document) {
  const mediaUrl = (value: unknown): string =>
    typeof value === 'string' && /^(blob:|https:\/\/)/i.test(value) ? value : ''
  const video = Array.from(doc.querySelectorAll<HTMLVideoElement>('video[data-hatch-avatar-layer]'))
    .find(el => !el.closest('[data-message-item="true"]'))
  if (!video) return null

  const liveUrl = mediaUrl(video.currentSrc) || mediaUrl(video.src) ||
    mediaUrl(video.querySelector('source')?.src)
  const key = Object.keys(video).find(k => k.startsWith('__reactFiber'))
  // React internals are deliberately bounded and cycle checked: this is untrusted page state.
  let fiber: any = key ? (video as any)[key] : null
  let staticUrl = ''
  let videoMap: { default: string; working: string; resume: string } | null = null
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
        // A declared, unsupported state is incomplete, not permission to reuse another outfit.
        if ((value.working && !mediaUrl(value.working)) || (value.resume && !mediaUrl(value.resume))) return null
        videoMap = {
          default: defaultUrl,
          working: mediaUrl(value.working) || defaultUrl,
          resume: mediaUrl(value.resume) || defaultUrl,
        }
      }
    }
    // The nearest usable state owns the entire bundle. Ancestors can be historical previews.
    if (videoMap) break
  }
  const defaultUrl = videoMap?.default || liveUrl
  if (!defaultUrl) return null
  const workingUrl = videoMap?.working || defaultUrl
  const resumeUrl = videoMap?.resume || defaultUrl
  const surfaceName = doc.querySelector<HTMLElement>('[data-testid="hatch-status-panel-sliding-surface"]')
    ?.innerText?.split('\n')[0]?.trim() || ''
  const rawTitle = (doc.title || '').replace(/^Chat\s*[—-]\s*/i, '').trim()
  const agentName = surfaceName || (rawTitle && !rawTitle.toLowerCase().includes('muse') ? rawTitle : '') || 'Muse'
  return {
    agentName, staticUrl, defaultUrl, workingUrl, resumeUrl,
    avatarSignature: JSON.stringify([agentName, staticUrl, defaultUrl, workingUrl, resumeUrl]),
  }
}
