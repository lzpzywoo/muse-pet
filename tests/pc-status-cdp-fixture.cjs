// Optional runtime check: isolated blank target only; no real cloud page, credentials or sends.
const fs = require('node:fs')
const assert = require('node:assert/strict')
async function main() {
  const { spawn } = require('node:child_process')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), ['--remote-debugging-port=9337', require('node:path').resolve('tests/pc-status-electron-fixture.cjs')], { env, stdio: 'ignore' })
  process.on('exit', () => child.kill())
  let target
  for (let i = 0; i < 60; i++) {
    try { target = (await (await fetch('http://127.0.0.1:9337/json/list')).json()).find(t => t.url === 'about:blank'); if (target) break } catch {}
    await new Promise(r => setTimeout(r, 200))
  }
  if (!target) { child.kill(); throw Error('Isolated Electron fixture did not start') }
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let id = 0
  const pending = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result) } }
  function call(method, params = {}, sessionId) { return new Promise((resolve, reject) => { const next = ++id; pending.set(next, { resolve, reject }); ws.send(JSON.stringify({ id: next, method, params, sessionId })) }) }
  try {
    const sessionId = undefined
    const evalJS = async expression => {
      const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
      if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails))
      return r.result.value
    }
    // Model live muse.ai: empty hatch-column shells precede the role=log history that carries motion + messages.
    await evalJS(`document.body.innerHTML = '<div data-hatch-chat-column="true" data-hatch-chat-nav-agent-profile-placement="below-header"></div><div data-hatch-chat-column="true" role="log" aria-live="polite" data-initial-history-motion="complete"><div data-message-item="true" data-message-id="fixture-user" data-message-role="user">/pc status</div><div data-message-item="true" data-message-id="fixture-assistant" data-message-role="assistant">device went offline yesterday</div><div data-message-item="true" data-message-role="user">/pc status</div></div><div data-hatch-chat-column="true"></div><textarea></textarea><span class="sr-only" role="status" aria-live="polite" aria-atomic="true" data-hatch-connection-status-announcer="true"></span>'`)
    const source = fs.readFileSync('src/main/muse-client.ts', 'utf8')
    const start = source.indexOf('const observation = await win.webContents.executeJavaScript(`')
    const scriptStart = source.indexOf('`', start) + 1
    const script = source.slice(scriptStart, source.indexOf('`)', scriptStart))
    // Explicit synthetic location and online state; the DOM and extraction code are real Chromium.
    const observation = () => evalJS(`(function(location, navigator, crypto) { return ${script} })({ origin: 'https://muse.ai', pathname: '/', search: '' }, { onLine: true }, { randomUUID: () => 'isolated-fixture-epoch' })`)
    const ready = await observation()
    assert.equal(ready.ready, true); assert.equal(ready.messages.length, 3)
    assert.equal(ready.messages[0].content, '/pc status'); assert.equal(ready.messages[1].role, 'assistant'); assert.equal(ready.messages[2].id, '')
    // Ordinary chat words like "offline" inside messages must not mark the bridge unready.
    assert.match(ready.messages[1].content, /offline/i)
    assert.equal(ready.ready, true)
    await evalJS(`document.querySelector('[data-hatch-chat-column][role="log"]').setAttribute('data-initial-history-motion', 'loading')`)
    assert.equal((await observation()).ready, false)
    await evalJS(`document.querySelector('[data-hatch-chat-column][role="log"]').setAttribute('data-initial-history-motion', 'complete')`)
    assert.equal((await observation()).ready, true)
    // Actual connection failure is announced outside message content.
    await evalJS(`document.querySelector('[data-hatch-connection-status-announcer]').textContent = 'Reconnecting'`)
    assert.equal((await observation()).ready, false)
    console.log('PASS: isolated Chromium DOM fixture: prefers role=log history, ignores offline text in messages, gates on loading + connection announcer; no live cloud messages sent.')
  } finally { ws.close(); child.kill() }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
