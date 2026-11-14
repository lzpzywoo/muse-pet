;(async () => {
  const t = (await (await fetch('http://127.0.0.1:9222/json/list')).json()).find(x => x.url === 'https://muse.ai/')
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0
  const pending = new Map()
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    const p = pending.get(m.id)
    if (p) { pending.delete(m.id); m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result) }
  }
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const next = ++id
    pending.set(next, { resolve, reject })
    ws.send(JSON.stringify({ id: next, method, params }))
  })
  const evalJS = async expression => {
    const r = await call('Runtime.evaluate', { expression, returnByValue: true })
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails))
    return r.result.value
  }
  const r = await evalJS(`(() => {
    const col = document.querySelector('[data-hatch-chat-column="true"][role="log"], [data-hatch-chat-column="true"][data-initial-history-motion], [role="log"][data-initial-history-motion]')
    const ta = document.querySelector('textarea')
    let bottom = true
    const scrollers = []
    for (let el = col; el; el = el.parentElement) {
      if (el.scrollHeight > el.clientHeight + 20 && getComputedStyle(el).overflowY !== 'visible') {
        const dist = el.scrollHeight - el.scrollTop - el.clientHeight
        scrollers.push({ tag: el.tagName, dist, overflowY: getComputedStyle(el).overflowY })
        if (dist > 40) bottom = false
      }
    }
    const connectionEls = Array.from(document.querySelectorAll(
      '[data-hatch-connection-status-announcer], [data-hatch-composer-support-access-status], [data-hatch-composer-lock-status], [role="status"], [role="alert"], [aria-live]'
    )).filter(el => !el.closest('[data-message-item="true"]') && el.getAttribute('role') !== 'log')
    const connectionSignals = connectionEls.map(el => el.innerText || '').join('\n')
    const offlineRe = /reconnecting|disconnected|offline|connection lost|重新连接|连接断开|网络异常/i
    const matching = connectionEls.map(el => ({
      attrs: Object.fromEntries([...el.attributes].map(a => [a.name, a.value]).filter(([n]) => /^(role|aria-|data-|class)/.test(n))),
      text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200),
      match: offlineRe.test(el.innerText || '')
    })).filter(x => x.match || x.text)
    return {
      origin: location.origin,
      path: location.pathname,
      search: location.search,
      online: navigator.onLine,
      readyState: document.readyState,
      ta: !!ta,
      col: !!col,
      motion: col && col.getAttribute('data-initial-history-motion'),
      bottom,
      scrollers,
      busy: !!document.querySelector('[aria-busy="true"], [role="progressbar"]'),
      connectionMatch: offlineRe.test(connectionSignals),
      matching
    }
  })()`)
  console.log(JSON.stringify(r, null, 2))
  ws.close()
})().catch(e => { console.error(e); process.exitCode = 1 })
