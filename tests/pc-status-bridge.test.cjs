const { test } = require('node:test')
const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')
const Module = require('node:module')
const output = buildSync({ entryPoints: ['src/main/pc-status-bridge.ts'], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text
const mod = new Module('pc-fixture'); mod._compile(output, 'pc-fixture.cjs')
const { PcStatusBridge, pcAccount, PcReportNotSubmitted } = mod.exports
const tick = () => new Promise(r => setImmediate(r))
const msg = (id, content = '/pc status', role = 'user') => ({ id, content, role })
function fixture(saved) {
  const f = { account: 'account-a', available: true, now: 1000, captures: 0, sends: [], saved, fail: false }
  f.bridge = new PcStatusBridge({ load: () => f.saved, save: s => { f.saved = structuredClone(s) }, account: () => f.account,
    available: () => f.available, now: () => f.now, device: 'fixture-only',
    snapshot: async () => { f.captures++; if (f.fail) throw Error('private detail'); return 'CPU fixture' },
    send: async report => { assert.equal(f.saved.tasks.find(t => t.report === report).state, 'sending'); f.sends.push(report); throw Error('uncertain') } })
  f.observe = async (messages, ready = true) => { await f.bridge.observe({ account: f.account, conversation: 'https://muse.ai/', ready, messages }); await tick() }
  f.enable = () => f.bridge.command('/pc on')
  return f
}
test('baseline, exact USER commands, stable IDs, replay and virtualized history', async () => {
  const f = fixture(); f.enable(); await f.observe([msg('old')]); assert.equal(f.captures, 0)
  await f.observe([msg('old'), msg('assistant', '/pc status', 'assistant'), msg('quote', '> /pc status'), msg('', '/pc status'), msg('on', '/pc on')]); assert.equal(f.captures, 0)
  await f.observe([msg('old'), msg('assistant', '/pc status', 'assistant'), msg('quote', '> /pc status'), msg('on', '/pc on'), msg('new')]); assert.equal(f.captures, 1)
  await f.observe([msg('ancient'), msg('old')]); await f.observe([msg('old'), msg('new')]); assert.equal(f.captures, 1)
})
test('offline/reconnect, stalled observations and restart baseline discard backlog', async () => {
  const f = fixture(); f.enable(); await f.observe([msg('a')]); await f.observe([], false)
  await f.observe([msg('a'), msg('offline')]); assert.equal(f.captures, 0)
  f.now += 20000; await f.observe([msg('a'), msg('offline'), msg('stalled')]); assert.equal(f.captures, 0)
  const restarted = fixture(f.saved); await restarted.observe([msg('a'), msg('restart')]); assert.equal(restarted.captures, 0)
})
test('account changes disable and logout clears pending work', async () => {
  const f = fixture(); f.enable(); await f.observe([msg('a')]); f.available = false
  await f.observe([msg('a'), msg('queued')]); f.account = 'account-b'; await f.observe([msg('b')]);
  f.available = true; await f.observe([msg('b'), msg('c')]); assert.equal(f.captures, 0); assert.equal(f.bridge.ledger.enabled, false)
  f.bridge.bind(''); assert.equal(f.bridge.ledger.tasks.length, 0)
})
test('local status has one pipeline, never sends raw command; cloud on/off ignored', async () => {
  const f = fixture(); f.enable(); await f.observe([msg('a')]);
  assert.match(f.bridge.command('/pc status'), /queued/); await tick(); assert.equal(f.captures, 1)
  await f.observe([msg('a'), msg('report', f.sends[0]), msg('off', '/pc off')]); assert.equal(f.captures, 1)
  assert.equal(f.bridge.ledger.tasks[0].state, 'sent'); assert.equal(f.bridge.ledger.enabled, true)
  f.bridge.command('/pc off'); assert.equal(f.bridge.ledger.enabled, false)
})
test('uncertain sends persist result, reconcile exact user report only, never retry or resample', async () => {
  const f = fixture(); f.enable(); await f.observe([msg('a')]); await f.observe([msg('a'), msg('b')]);
  const report = f.sends[0]; assert.match(report, /task=/); assert.match(report, /Capture started:/)
  await f.observe([msg('a'), msg('b'), msg('spoof', report, 'assistant')]); assert.equal(f.bridge.ledger.tasks[0].state, 'sending')
  const r = fixture(f.saved); await r.observe([msg('a'), msg('b')]); assert.equal(r.sends.length, 0)
  await r.observe([msg('a'), msg('b'), msg('result', report)]); assert.equal(r.bridge.ledger.tasks[0].state, 'sent'); assert.equal(r.captures, 0)
})
test('snapshot errors become bounded data reports and queue is serial', async () => {
  const f = fixture(); f.fail = true; f.enable(); await f.observe([msg('a')]); f.available = false
  await f.observe([msg('a'), msg('b'), msg('c')]); assert.equal(f.captures, 0)
  f.available = true; await f.observe([msg('a'), msg('b'), msg('c')]); assert.equal(f.captures, 2); assert.equal(f.sends.length, 2)
  assert.match(f.sends[0], /collection failed/); assert.doesNotMatch(f.sends[0], /private detail/)
})
test('opaque account hash excludes unrelated cookies and rejects missing credentials', () => {
  assert.equal(pcAccount('foo=bar'), ''); assert.equal(pcAccount('hatch_sess=abc; foo=x'), pcAccount('foo=y; hatch_sess=abc'))
  assert.notEqual(pcAccount('hatch_sess=abc'), pcAccount('hatch_sess=def')); assert.equal(pcAccount('hatch_sess=abc').length, 64)
})
test('page reload or brief offline epoch change resets the ordered baseline', async () => {
  const f = fixture(); f.enable()
  await f.bridge.observe({ account: f.account, conversation: 'https://muse.ai/', epoch: 'one', ready: true, messages: [msg('a')] })
  await f.bridge.observe({ account: f.account, conversation: 'https://muse.ai/', epoch: 'two', ready: true, messages: [msg('a'), msg('backlog')] })
  await tick(); assert.equal(f.captures, 0)
})
test('serial work cannot overlap; disabling during capture cancels transmission', async () => {
  let release; let captures = 0; let sends = 0; let saved
  const bridge = new PcStatusBridge({ load: () => null, save: s => { saved = structuredClone(s) }, account: () => 'a', available: () => true, device: 'fixture',
    snapshot: () => { captures++; return new Promise(r => { release = r }) }, send: async () => { sends++ } })
  bridge.command('/pc on')
  const observe = messages => bridge.observe({ account: 'a', conversation: 'root', ready: true, messages })
  await observe([msg('a')]); await observe([msg('a'), msg('b'), msg('c')]);
  await observe([msg('a'), msg('b'), msg('c'), msg('d')]); assert.equal(captures, 1)
  bridge.command('/pc off'); release('fixture'); await tick(); assert.equal(sends, 0)
  assert.ok(saved.tasks.every(t => t.state === 'cancelled'))
})
test('durable write failure prevents collection and transmission', async () => {
  let fail = false; let captures = 0; let sends = 0
  const b = new PcStatusBridge({ load: () => null, save: () => { if (fail) throw Error('disk full') }, account: () => 'a', available: () => true, device: 'fixture', snapshot: async () => { captures++; return 'x' }, send: async () => { sends++ } })
  b.command('/pc on'); await b.observe({ account: 'a', conversation: 'root', ready: true, messages: [msg('a')] })
  fail = true
  await assert.rejects(b.observe({ account: 'a', conversation: 'root', ready: true, messages: [msg('a'), msg('b')] }))
  await tick(); assert.equal(captures, 0); assert.equal(sends, 0)
})
test('lost contiguous overlap cancels busy queued and delayed capture before replacement baseline', async () => {
  let release; let captures = 0; let sends = 0; let saved
  const bridge = new PcStatusBridge({
    load: () => null, save: s => { saved = structuredClone(s) }, account: () => 'a', available: () => true, device: 'fixture',
    snapshot: () => { captures++; return new Promise(r => { release = r }) }, send: async () => { sends++ }
  })
  bridge.command('/pc on')
  const observe = messages => bridge.observe({ account: 'a', conversation: 'root', ready: true, messages })
  await observe([msg('a')])
  assert.match(bridge.command('/pc status'), /queued/)
  await tick(); assert.equal(captures, 1)
  // Discontinuity while capture is in flight must invalidate that work before the new baseline.
  await observe([msg('z'), msg('y')])
  release('fixture'); await tick()
  assert.equal(sends, 0)
  assert.ok(saved.tasks.every(t => t.state === 'cancelled'))

  const f = fixture(); f.enable(); await f.observe([msg('a')]); f.available = false
  await f.observe([msg('a'), msg('queued')]); assert.equal(f.captures, 0)
  assert.ok(f.bridge.ledger.tasks.some(t => t.state === 'queued'))
  await f.observe([msg('only')]); assert.equal(f.captures, 0)
  assert.ok(f.bridge.ledger.tasks.every(t => t.state !== 'queued'))
  assert.ok(f.bridge.ledger.tasks.some(t => t.state === 'cancelled'))
})
test('first empty ready snapshot without prior baseline does not cancel later accepted work', async () => {
  const f = fixture(); f.enable()
  await f.bridge.observe({ account: f.account, conversation: 'https://muse.ai/', ready: true, messages: [] })
  await tick(); assert.equal(f.bridge.ledger.tasks.length, 0)
  await f.observe([msg('a')])
  assert.match(f.bridge.command('/pc status'), /queued/); await tick()
  assert.equal(f.captures, 1); assert.equal(f.sends.length, 1)
})
test('definitely-not-submitted busy restores same ready report; uncertain send never retries', async () => {
  let attempts = 0; let saved; let captures = 0; let report
  const bridge = new PcStatusBridge({
    load: () => null, save: s => { saved = structuredClone(s) }, account: () => 'a', available: () => true, device: 'fixture',
    snapshot: async () => { captures++; return 'CPU fixture' },
    send: async (r) => {
      attempts++
      assert.equal(saved.tasks.find(t => t.report === r).state, 'sending')
      report = r
      if (attempts === 1) throw new PcReportNotSubmitted('composer busy')
      throw new Error('uncertain')
    }
  })
  bridge.command('/pc on')
  await bridge.observe({ account: 'a', conversation: 'root', ready: true, messages: [msg('a')] })
  await bridge.observe({ account: 'a', conversation: 'root', ready: true, messages: [msg('a'), msg('b')] })
  await tick()
  assert.equal(captures, 1); assert.equal(attempts, 1)
  assert.equal(saved.tasks[0].state, 'ready'); assert.equal(saved.tasks[0].report, report)
  // Next healthy observation retries the same capture without resampling.
  await bridge.observe({ account: 'a', conversation: 'root', ready: true, messages: [msg('a'), msg('b')] })
  await tick()
  assert.equal(captures, 1); assert.equal(attempts, 2)
  assert.equal(saved.tasks[0].state, 'sending')
  // Uncertain outcome must not blind-retry.
  await bridge.observe({ account: 'a', conversation: 'root', ready: true, messages: [msg('a'), msg('b')] })
  await tick()
  assert.equal(attempts, 2); assert.equal(captures, 1)
})
