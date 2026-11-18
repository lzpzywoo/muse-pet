const { test } = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const { buildSync } = require('esbuild')

const code = buildSync({ entryPoints: ['src/main/muse-client.ts'], bundle: true,
  platform: 'node', format: 'cjs', write: false, external: ['electron'] }).outputFiles[0].text
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
function harness() {
  let now = 100000, id = 0
  const timers = new Map()
  const context = vm.createContext({ module: { exports: {} }, exports: {},
    require: name => name === 'electron' ? { app: {} } : require(name), console, Buffer, URL,
    Date: class extends Date { static now() { return now } },
    setTimeout: (fn, delay) => { timers.set(++id, { fn, at: now + delay }); return id },
    clearTimeout: key => timers.delete(key),
  })
  vm.runInContext(code, context)
  const client = new context.module.exports.MuseClient({ getCookies: () => 'hatch_sess=test',
    getProfile: () => ({ isLoggedIn: true }) })
  const calls = { light: 0, rich: 0, browser: 0 }
  client.pollPcObservation = async () => { calls.light++ }
  client.pollCloudBrowserStatus = async () => { calls.browser++ }
  client.fetchCloudMessagesOnce = async () => { calls.rich++; return [] }
  return { client, calls, timers, async advance(ms) {
    const end = now + ms
    while (true) {
      const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush()
    }
    now = end; await flush()
  } }
}

test('idle 4500ms; active light 500ms, rich 1500ms, browser 4500ms; boost expires', async () => {
  const h = harness(), { client: c, calls } = h
  c.startCloudMessageWatcher(); c.startCloudMessageWatcher()
  await h.advance(4499); assert.equal(calls.light, 0)
  await h.advance(1); assert.deepEqual(calls, { light: 1, rich: 1, browser: 1 })
  c.boostObservationSpeed(4500)
  await h.advance(4000); assert.deepEqual(calls, { light: 9, rich: 3, browser: 1 })
  await h.advance(500); assert.deepEqual(calls, { light: 10, rich: 3, browser: 2 })
  await h.advance(4499); assert.equal(calls.light, 10)
  await h.advance(1); assert.deepEqual(calls, { light: 11, rich: 4, browser: 3 })
})

test('active timer never overlaps rich hydration; concurrent calls share one promise', async () => {
  const h = harness(), gate = deferred(); let running = 0, peak = 0, count = 0
  h.client.fetchCloudMessagesOnce = async () => { count++; peak = Math.max(peak, ++running); await gate.promise; running--; return [] }
  h.client.startCloudMessageWatcher(); h.client.boostObservationSpeed()
  await h.advance(1500)
  const first = h.client.fetchCloudMessages(false), second = h.client.fetchCloudMessages(true)
  assert.equal(first, second)
  await h.advance(6000); assert.equal(count, 1); assert.equal(peak, 1)
  gate.resolve(); await first; await flush()
  await h.advance(1500); assert.equal(count, 2)
})

test('a notifying caller joining an actual rich extraction receives its changed snapshot once', async () => {
  const h = harness(), gate = deferred(); let reads = 0, notifications = 0
  delete h.client.fetchCloudMessagesOnce
  h.client.ensureMuseWindow = async () => ({ webContents: { executeJavaScript: async () => {
    reads++; await gate.promise
    return { items: [{ id: 'stable-user', role: 'user', content: 'hello', attachments: [] }], avatarSignature: null }
  } } })
  h.client.onCloudMessagesUpdated(() => notifications++)
  const first = h.client.fetchCloudMessages(false)
  await flush()
  const second = h.client.fetchCloudMessages(true)
  assert.equal(first, second); gate.resolve(); await first; await flush()
  assert.equal(reads, 1); assert.equal(notifications, 1)
  await h.client.fetchCloudMessages(true); assert.equal(notifications, 1)
})

function allowReport(c) {
  c.pcAvailable = () => true
  c.museWindow = { webContents: { getURL: () => 'https://muse.ai/' } }
  // Use the same account hash implementation as the client.
  return require('node:crypto').createHash('sha256').update('hatch_sess=test').digest('hex')
}
test('completed Hub report immediately requests light and exactly one rich refresh', async () => {
  const h = harness(), c = h.client, account = allowReport(c), gate = deferred()
  c.sendViaMuseWindow = async () => { await gate.promise }
  const sent = c.sendHubReport('report', 'https://muse.ai/', account)
  await flush(); assert.equal(h.calls.light, 0); assert.equal(h.calls.rich, 0)
  gate.resolve(); await sent; await flush()
  assert.equal(c.isChatTurnActive(), false)
  assert.deepEqual(h.calls, { light: 1, rich: 1, browser: 0 })
})

test('uncertain or aborted Hub reports never trigger completion refresh or companion fallback', async () => {
  for (const abort of [false, true]) {
    const h = harness(), c = h.client, account = allowReport(c)
    c.runCompanionReply = () => { throw Error('must not fallback') }
    c.sendViaMuseWindow = async () => { if (abort) c.aborted = true; else throw Error('uncertain') }
    await assert.rejects(c.sendHubReport('report', 'https://muse.ai/', account), error => error.code !== 'pc_not_submitted')
    await flush(); assert.equal(c.isChatTurnActive(), false)
    assert.equal(h.calls.light, 0); assert.equal(h.calls.rich, 0)
  }
})

test('desktop composer releases before rich refresh completes; background rejection is caught', async () => {
  const h = harness(), c = h.client, gate = deferred()
  c.sendViaMuseWindow = async () => {}
  c.fetchCloudMessagesOnce = async () => { await gate.promise; throw Error('setup unavailable') }
  await c.sendChatMessage('hello', () => {}, () => {}, () => {})
  assert.equal(c.isChatTurnActive(), false); assert.equal(h.calls.light, 1)
  assert.ok(c.cloudMessagesPromise)
  gate.resolve(); await flush(); assert.equal(c.cloudMessagesPromise, null)
})

test('refresh requested inside a running observation executes immediately after it settles', async () => {
  const h = harness(), c = h.client, gate = deferred(); let seen = 0
  delete c.pollPcObservation
  c.sessionStore.getCookies = () => ''
  c.onPcObservation(async () => { seen++; if (seen === 1) await gate.promise })
  const observing = c.refreshToolObservation(); await flush()
  await c.refreshToolObservation(); assert.equal(seen, 1)
  gate.resolve(); await observing; await flush(); assert.equal(seen, 2)
})

test('DOM-ready assistant output cannot dispatch until the local sender releases the composer', async () => {
  const h = harness(), c = h.client, observations = []
  delete c.pollPcObservation
  c.museWindow = { isDestroyed: () => false, isVisible: () => false, webContents: {
    isLoading: () => false,
    executeJavaScript: async () => ({ conversation: 'https://muse.ai/', epoch: 'page', ready: true, messages: [{ id: 'user', role: 'user', content: 'query' }, { id: 'tool', role: 'assistant', content: '{"action":"local_tool"}' }] }),
  } }
  c.onPcObservation(async observation => { observations.push(observation) })
  c.isSendingChat = true
  await c.refreshToolObservation()
  assert.equal(observations.at(-1).ready, false)
  c.isSendingChat = false
  await c.refreshToolObservation()
  assert.equal(observations.at(-1).ready, true)
  assert.equal(observations.at(-1).messages[1].id, 'tool')
})

test('boost duration is bounded to 20 seconds', async () => {
  const h = harness(); h.client.startCloudMessageWatcher(); h.client.boostObservationSpeed(999999)
  await h.advance(20000); assert.equal(h.calls.light, 40)
  await h.advance(4499); assert.equal(h.calls.light, 40)
  await h.advance(1); assert.equal(h.calls.light, 41)
})
