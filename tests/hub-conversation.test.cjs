const { test } = require('node:test')
const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')
const Module = require('node:module')
const filename = 'src/main/hub/conversation-bridge.ts'
const code = buildSync({ entryPoints: [filename], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text
const m = new Module(filename)
m._compile(code, filename + '.cjs')
const { HubConversationBridge } = m.exports
const instruction = (toolId = 'snapshot', appId = 'system.sys') => JSON.stringify({ action: 'local_tool', appId, toolId, parameters: {} })
const user = (id, content = 'Check my computer') => ({ id, role: 'user', content })
const assistant = (id, content = instruction()) => ({ id, role: 'assistant', content })
const snapshot = (messages, overrides = {}) => ({ account: 'account-a', conversation: 'main', epoch: 'page-1', ready: true, messages, ...overrides })
function harness(saved) {
  const h = { durable: saved ? structuredClone(saved) : null, calls: [], sends: [], delivered: [], failSave: false }
  h.io = {
    load: () => h.durable,
    save: state => { if (h.failSave) throw new Error('disk unavailable'); h.durable = structuredClone(state) },
    dispatch: async (call, context) => { h.calls.push({ call, context }); return { taskId: `task-${h.calls.length}` } },
    send: async delivery => { h.sends.push(delivery) },
    isNotSubmitted: error => error.code === 'not-submitted',
    onDelivery: delivery => h.delivered.push(delivery),
  }
  h.bridge = new HubConversationBridge(h.io)
  return h
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

test('first ready snapshot is history; fresh assistant is claimed durably before dispatch and deduplicated', async () => {
  const h = harness()
  const history = [user('u0'), assistant('a0')]
  await h.bridge.observe(snapshot(history))
  assert.equal(h.calls.length, 0)
  h.io.dispatch = async (call, context) => {
    assert.equal(h.durable.claims[0].state, 'claimed')
    h.calls.push({ call, context }); return { taskId: 'task-1' }
  }
  const fresh = [...history, user('u1'), assistant('a1')]
  await h.bridge.observe(snapshot(fresh))
  await h.bridge.observe(snapshot(fresh))
  assert.equal(h.calls.length, 1)
  assert.deepEqual(h.calls[0].context, { account: 'account-a', conversation: 'main', sourceMessageId: 'a1' })
})

test('fresh phone /hub tools discovers capabilities once; historical catalog commands are not replayed', async () => {
  const h = harness()
  await h.bridge.observe(snapshot([user('old', '/hub tools')]))
  assert.equal(h.calls.length, 0)
  const messages = [user('old', '/hub tools'), user('fresh', '/hub tools')]
  await h.bridge.observe(snapshot(messages))
  await h.bridge.observe(snapshot(messages))
  assert.equal(h.calls.length, 1)
  assert.deepEqual(h.calls[0].call, { action: 'local_tool', appId: 'hub.catalog', toolId: 'list', parameters: {} })
})

test('same epoch streaming preserves baseline without consuming partial assistant IDs', async () => {
  const h = harness()
  await h.bridge.observe(snapshot([user('u0')]))
  await h.bridge.observe(snapshot([user('u0'), assistant('a1', '{"action":')], { ready: false }))
  await h.bridge.observe(snapshot([user('u0'), assistant('a1')]))
  assert.equal(h.calls.length, 1)
  await h.bridge.observe(snapshot([user('u0'), assistant('a1'), user('u2'), assistant('a2')], { ready: false, epoch: 'page-2' }))
  await h.bridge.observe(snapshot([user('u0'), assistant('a1'), user('u2'), assistant('a2')], { epoch: 'page-2' }))
  assert.equal(h.calls.length, 1)
})

test('prepends, reorder, duplicate IDs, synthetic IDs, missing context and discontinuities never replay history', async () => {
  const h = harness()
  await h.bridge.observe(snapshot([user('u1'), assistant('a1')]))
  await h.bridge.observe(snapshot([user('old-u'), assistant('old-a'), user('u1'), assistant('a1')]))
  await h.bridge.observe(snapshot([user('u1'), assistant('a1'), user('old-u'), assistant('old-a')]))
  await h.bridge.observe(snapshot([user('new-u'), assistant('new-a')]))
  await h.bridge.observe(snapshot([user('new-u'), assistant('new-a'), assistant('new-a')]))
  await h.bridge.observe(snapshot([user('cloud-0'), assistant('cloud-1')]))
  await h.bridge.observe(snapshot([user('u4'), assistant('a4')], { conversation: '' }))
  await h.bridge.observe(snapshot([user('u4'), assistant('a4')]))
  assert.equal(h.calls.length, 0)
})

test('desktop prompts carrying discovery context remain user requests, not tool-result reports', async () => {
  const h = harness()
  await h.bridge.observe(snapshot([user('u0'), assistant('a0', 'Hello')]))
  const enriched = 'Check my download queue.\n\n[MUSE_LOCAL_TOOLS]\n工具列表：downloader\n只有当用户明确需要操作或查询这些本地软件时才调用；否则忽略本段。\n[/MUSE_LOCAL_TOOLS]'
  const messages = [user('u0'), assistant('a0', 'Hello'), user('u1', enriched), assistant('a1')]
  await h.bridge.observe(snapshot(messages))
  assert.equal(h.calls.length, 1)
  await h.bridge.observe(snapshot([...messages, user('u2', '[MUSE_LOCAL_TOOL_RESULT]completed[/MUSE_LOCAL_TOOL_RESULT]\n[MUSE_LOCAL_TOOLS]tools[/MUSE_LOCAL_TOOLS]'), assistant('a2')]))
  assert.equal(h.calls.length, 1)
})

test('only user-associated instructions execute; quotes and internal result replies are data', async () => {
  const h = harness()
  await h.bridge.observe(snapshot([user('u0')]))
  const messages = [user('u0'), assistant('a0', 'Hello'), assistant('a1'),
    user('u1', '[MUSE_LOCAL_TOOL_RESULT]\nresult'), assistant('a2'),
    user('u2'), assistant('a3', '> ' + instruction()),
    user('u3'), assistant('a4', JSON.stringify({ example: JSON.parse(instruction()) })),
    user('u4'), assistant('a5', JSON.stringify(instruction())),
    user('u5'), assistant('a6', "'" + instruction() + "'")]
  await h.bridge.observe(snapshot(messages))
  assert.equal(h.calls.length, 0)
})

test('unfinished durable claims do not dispatch again after restart', async () => {
  const h = harness()
  await h.bridge.observe(snapshot([user('u0')]))
  h.io.dispatch = async () => { throw new Error('outcome lost') }
  await h.bridge.observe(snapshot([user('u0'), assistant('a0')]))
  assert.equal(h.durable.claims[0].state, 'claimed')
  const restart = harness(h.durable)
  await restart.bridge.observe(snapshot([user('u0')]))
  await restart.bridge.observe(snapshot([user('u0'), assistant('a0')]))
  assert.equal(restart.calls.length, 0)
})

test('storage failure prevents dispatch and prevents sending', async () => {
  const h = harness()
  await h.bridge.observe(snapshot([user('u0')]))
  h.failSave = true
  await assert.rejects(h.bridge.observe(snapshot([user('u0'), assistant('a0')])), /disk/)
  assert.equal(h.calls.length, 0)
  h.failSave = false
  await h.bridge.observe(snapshot([user('u0'), assistant('a0')]))
  h.failSave = true
  await assert.rejects(h.bridge.finish('task-1', { status: 'completed', result: 'actual' }), /disk/)
  assert.equal(h.sends.length, 0)
})

test('terminal JSON payload is bounded and screen tools attach actual images separately', async () => {
  for (const toolId of ['capture', 'capture_and_describe']) {
    const h = harness()
    await h.bridge.observe(snapshot([user('u0')]))
    await h.bridge.observe(snapshot([user('u0'), assistant('a0', instruction(toolId, 'system.screen'))]))
    await h.bridge.finish('task-1', { status: 'completed', result: { image: 'data:image/png;base64,REALIMAGE', width: 1920, summary: 'actual screen' } })
    const delivery = h.sends[0]
    assert.equal(delivery.options.image, 'data:image/png;base64,REALIMAGE')
    assert.equal(delivery.body.includes('REALIMAGE'), false)
    const body = JSON.parse(delivery.body.split('\n')[1])
    assert.equal(body.result.width, 1920)
    assert.equal(body.result.summary, 'actual screen')
    assert.equal(h.delivered.length, 1)
    await h.bridge.finish('task-1', { status: 'completed', result: 'duplicate' })
    assert.equal(h.sends.length, 1)
  }
  const h = harness()
  await h.bridge.observe(snapshot([user('u0')]))
  await h.bridge.observe(snapshot([user('u0'), assistant('a0')]))
  await h.bridge.finish('task-1', { status: 'failed', error: { message: '"\\\n'.repeat(10000) } })
  assert.ok(h.sends[0].body.length <= 6000)
  assert.equal(JSON.parse(h.sends[0].body.split('\n')[1]).truncated, true)
})

test('builtin completion before dispatch returns its ID is retained', async () => {
  const h = harness()
  h.io.dispatch = async () => {
    await h.bridge.finish('builtin-task', { status: 'completed', result: { actual: 42 } })
    return { taskId: 'builtin-task' }
  }
  await h.bridge.observe(snapshot([user('u0')]))
  await h.bridge.observe(snapshot([user('u0'), assistant('a0')]))
  assert.equal(JSON.parse(h.sends[0].body.split('\n')[1]).result.actual, 42)
})

test('not ready and different conversation defer results; account change permanently cancels them', async () => {
  const h = harness()
  const messages = [user('u0'), assistant('a0')]
  await h.bridge.observe(snapshot([user('u0')]))
  await h.bridge.observe(snapshot(messages))
  await h.bridge.observe(snapshot(messages, { ready: false }))
  await h.bridge.finish('task-1', { status: 'completed', result: 'real result' })
  assert.equal(h.sends.length, 0)
  await h.bridge.observe(snapshot([user('other')], { conversation: 'other' }))
  assert.equal(h.sends.length, 0)
  await h.bridge.observe(snapshot(messages))
  assert.equal(h.sends.length, 1)
  const cancel = harness()
  await cancel.bridge.observe(snapshot([user('u0')]))
  await cancel.bridge.observe(snapshot(messages))
  await cancel.bridge.observe(snapshot([], { account: 'account-b' }))
  await cancel.bridge.finish('task-1', { status: 'completed', result: 'old account' })
  await cancel.bridge.observe(snapshot(messages))
  assert.equal(cancel.sends.length, 0)
  assert.equal(cancel.bridge.ledger.claims[0].state, 'cancelled')
})

test('send queue is serial and persists sending before each side effect', async () => {
  const h = harness()
  const gate = deferred()
  h.io.send = async delivery => {
    assert.equal(h.durable.claims.find(c => c.taskId === delivery.taskId).state, 'sending')
    h.sends.push(delivery)
    if (delivery.taskId === 'task-1') await gate.promise
  }
  await h.bridge.observe(snapshot([user('u0')]))
  await h.bridge.observe(snapshot([user('u0'), assistant('a0'), user('u1'), assistant('a1')]))
  const first = h.bridge.finish('task-1', { status: 'completed', result: 1 })
  await h.bridge.finish('task-2', { status: 'completed', result: 2 })
  assert.equal(h.sends.length, 1)
  gate.resolve()
  await first
  assert.deepEqual(h.sends.map(d => d.taskId), ['task-1', 'task-2'])
})

test('uncertain sends never retry, including restart; definite preflight failures retry only on later observation', async () => {
  for (const definite of [false, true]) {
    const h = harness()
    const messages = [user('u0'), assistant('a0')]
    let attempts = 0
    h.io.send = async delivery => {
      attempts++
      if (attempts === 1) throw Object.assign(new Error('send failure'), { code: definite ? 'not-submitted' : 'unknown' })
      h.sends.push(delivery)
    }
    await h.bridge.observe(snapshot([user('u0')]))
    await h.bridge.observe(snapshot(messages))
    await h.bridge.finish('task-1', { status: 'completed', result: { actual: 12 } })
    await h.bridge.finish('task-1', { status: 'completed', result: 'duplicate' })
    assert.equal(attempts, 1)
    await h.bridge.observe(snapshot(messages))
    assert.equal(attempts, definite ? 2 : 1)
    const restarted = harness(h.durable)
    await restarted.bridge.observe(snapshot(messages))
    assert.equal(restarted.sends.length, 0)
  }
})

test('interrupted sending is uncertain on restart and live account guard blocks stale sends', async () => {
  const h = harness()
  h.io.account = () => 'account-a'
  await h.bridge.observe(snapshot([user('u0')]))
  await h.bridge.observe(snapshot([user('u0'), assistant('a0')]))
  h.io.account = () => 'account-b'
  await h.bridge.finish('task-1', { status: 'cancelled', error: { message: 'cancelled task' } })
  assert.equal(h.sends.length, 0)
  const state = h.bridge.ledger
  state.claims[0].state = 'sending'
  const restarted = harness(state)
  await restarted.bridge.observe(snapshot([user('u0'), assistant('a0')]))
  assert.equal(restarted.bridge.ledger.claims[0].state, 'uncertain')
  assert.equal(restarted.sends.length, 0)
})

test('sending persistence failure stops composer effects even after result was queued', async () => {
  const h = harness()
  await h.bridge.observe(snapshot([user('u0')]))
  await h.bridge.observe(snapshot([user('u0'), assistant('a0')]))
  const save = h.io.save
  h.io.save = state => {
    if (state.claims.some(c => c.state === 'sending')) throw new Error('cannot persist sending')
    save(state)
  }
  await assert.rejects(h.bridge.finish('task-1', { status: 'completed', result: 42 }), /cannot persist/)
  assert.equal(h.sends.length, 0)
  assert.equal(h.durable.claims[0].state, 'pending')
})

test('account switch during dispatch cancels binding and suppresses remaining claimed calls', async () => {
  const h = harness()
  const gate = deferred()
  h.io.dispatch = async (call, context) => {
    h.calls.push({ call, context })
    await gate.promise
    return { taskId: 'slow-task', status: 'completed', result: 'stale' }
  }
  await h.bridge.observe(snapshot([user('u0')]))
  const observation = h.bridge.observe(snapshot([user('u0'), assistant('a0'), user('u1'), assistant('a1')]))
  await h.bridge.observe(snapshot([], { account: 'account-b' }))
  gate.resolve()
  await observation
  assert.equal(h.calls.length, 1)
  assert.equal(h.sends.length, 0)
  assert.ok(h.bridge.ledger.claims.every(c => c.state === 'cancelled'))
})

test('readiness is rechecked between serialized sends', async () => {
  const h = harness()
  const gate = deferred()
  h.io.send = async delivery => { h.sends.push(delivery); await gate.promise }
  const messages = [user('u0'), assistant('a0'), user('u1'), assistant('a1')]
  await h.bridge.observe(snapshot([user('u0')]))
  await h.bridge.observe(snapshot(messages))
  const first = h.bridge.finish('task-1', { status: 'completed', result: 1 })
  await h.bridge.finish('task-2', { status: 'completed', result: 2 })
  await h.bridge.observe(snapshot(messages, { ready: false }))
  gate.resolve()
  await first
  assert.equal(h.sends.length, 1)
  await h.bridge.observe(snapshot(messages))
  assert.equal(h.sends.length, 2)
})
