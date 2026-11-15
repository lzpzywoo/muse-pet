const { test } = require('node:test')
const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')
const Module = require('node:module')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const output = buildSync({ entryPoints: ['src/main/hub/hub-server.ts'], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text
const mod = new Module(__filename)
mod._compile(output, __filename + '.bundle.cjs')
const { HubServer } = mod.exports
const tick = () => new Promise(r => setTimeout(r, 20))
async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await tick() }
  assert.fail('condition did not settle')
}
function manifest(appId, riskLevel = 'write-dangerous') {
  return { appId, name: appId, version: '1', description: 'test', secret: 'original-secret', tools: [{ toolId: 'work', name: 'Work', description: 'work', riskLevel, category: 'action', inputSchema: { type: 'object', required: ['count'], properties: { count: { type: 'integer', minimum: 1, maximum: 5 } }, additionalProperties: false } }] }
}
async function fixture(t, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-security-'))
  const hub = new HubServer({ port: 0, stateFilePath: path.join(dir, 'state.json'), executeTask: async () => {}, requestApproval: id => hub.waitForApproval(id), ...opts })
  await hub.start()
  t.after(() => { hub.stop(); fs.rmSync(dir, { recursive: true, force: true }) })
  const request = async (route, app, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${hub.port}/api/v1/${route}`, { method, headers: { 'Content-Type': 'application/json', ...(app ? { Authorization: `Bearer ${app.token}`, 'X-App-Id': app.id } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, body: await response.json() }
  }
  const register = async (id, risk) => {
    const response = await request('register', null, 'POST', manifest(id, risk))
    assert.equal(response.status, 200)
    return { id, token: response.body.data.sessionToken }
  }
  const connect = async (app, secret = 'original-secret') => {
    const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/ws?appId=${app.id}&secret=${secret}`)
    const messages = []
    ws.onmessage = e => messages.push(JSON.parse(e.data))
    t.after(() => ws.close())
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
    return { ws, messages }
  }
  return { hub, request, register, connect }
}

test('HTTP approval is human-only, scoped queries and updates enforce ownership and methods', async t => {
  let approvalCalls = 0
  let hubRef
  const f = await fixture(t, { requestApproval: id => { approvalCalls++; return hubRef.waitForApproval(id) } })
  const { hub, request, register, connect } = f
  hubRef = hub
  const a = await register('app.owner')
  const b = await register('hub')
  const worker = await connect(a)
  const attacker = await connect(b)
  const created = await request('tasks', a, 'POST', { toolId: 'work', parameters: { count: 2 } })
  assert.equal(created.status, 202)
  const id = created.body.data.taskId
  assert.equal(created.body.data.status, 'awaiting_approval')
  await until(() => approvalCalls === 1)
  const waiter = hub.waitForApproval(id)
  assert.equal(hub.waitForApproval(id), waiter, 'duplicate waits reuse the same promise')
  for (const action of ['approve', 'reject']) {
    assert.equal((await request(`tasks/${id}/${action}`, a, 'POST', {})).status, 403)
    assert.equal((await request(`tasks/${id}/${action}`, b, 'POST', {})).status, 403)
  }
  assert.equal((await request('tasks', b)).body.data.length, 0)
  assert.equal((await request(`tasks?appId=${a.id}`, b)).status, 403)
  assert.equal((await request(`tasks/${id}`, b)).status, 403)
  for (const action of ['progress', 'complete', 'fail', 'cancel']) assert.equal((await request(`tasks/${id}/${action}`, b, 'POST', {})).status, 403)
  assert.equal((await request(`tasks/${id}/complete`, a, 'GET')).status, 405)
  assert.equal((await request(`tasks/${id}/complete`, a, 'POST', { result: 'before approval' })).status, 409)
  for (const type of ['task.progress', 'task.completed', 'task.failed']) attacker.ws.send(JSON.stringify({ type, taskId: id, payload: { result: 'stolen', percentage: 99 } }))
  await tick()
  assert.equal(hub.tasks.get(id).status, 'awaiting_approval')
  assert.equal(hub.resolveApproval(id, true), true)
  assert.equal(await waiter, true)
  await until(() => worker.messages.some(m => m.type === 'task.dispatched'))
  assert.equal(worker.messages.filter(m => m.type === 'task.dispatched').length, 1)
  assert.equal(hub.resolveApproval(id, true), false)
  for (const type of ['task.progress', 'task.completed', 'task.failed']) attacker.ws.send(JSON.stringify({ type, taskId: id, payload: { result: 'stolen', percentage: 99 } }))
  await tick()
  assert.equal(hub.tasks.get(id).status, 'running')
  worker.ws.send(JSON.stringify({ type: 'task.completed', taskId: id, payload: { result: 'owned' } }))
  await until(() => hub.tasks.get(id).status === 'completed')
  assert.equal((await request(`tasks/${id}/fail`, a, 'POST', {})).status, 409)
  assert.equal(hub.tasks.get(id).result, 'owned')
})

test('reserved builtin registrations and sockets cannot intercept internal execution; session takeover denied', async t => {
  let executed = 0
  const { hub, request, register, connect } = await fixture(t, { executeTask: async () => { executed++ } })
  for (const id of ['system.screen', 'system.future', 'SYSTEM.future']) assert.equal((await request('register', null, 'POST', manifest(id))).status, 403)
  for (const id of ['system.screen', 'app.builtin']) {
    hub.registry.register(manifest(id, 'read-only'))
    hub.registry.markBuiltin(id)
    assert.equal((await request('register', null, 'POST', manifest(id))).status, 403)
    const { ws, messages } = await connect({ id })
    await until(() => ws.readyState === WebSocket.CLOSED)
    assert.equal(messages.length, 0)
    await hub.dispatch({ appId: id, toolId: 'work', parameters: { count: 1 } })
  }
  assert.equal(executed, 2)
  const a = await register('app.session', 'read-only')
  const oldSocket = await connect(a)
  assert.equal((await request('register', null, 'POST', { ...manifest(a.id), secret: 'takeover-secret' })).status, 400)
  assert.equal((await request('heartbeat', a, 'POST', {})).status, 200)
  const replacement = await register(a.id, 'read-only')
  assert.notEqual(a.token, replacement.token)
  await until(() => oldSocket.ws.readyState === WebSocket.CLOSED)
  assert.equal((await request('heartbeat', a, 'POST', {})).status, 401)
  assert.equal((await request('heartbeat', replacement, 'POST', {})).status, 200)
})

test('cancel/remove/offline/stop settle approval and send one cancellation; late worker frames cannot resurrect', async t => {
  let now = 1000
  const { hub, request, register, connect } = await fixture(t, { now: () => now })
  for (const action of ['cancel', 'remove', 'offline', 'stop']) {
    const a = await register(`app.${action}`)
    const worker = await connect(a)
    const response = await request('tasks', a, 'POST', { toolId: 'work', parameters: { count: 1 } })
    const id = response.body.data.taskId
    const waiter = hub.waitForApproval(id)
    if (action === 'cancel') { hub.cancelTask(id); hub.cancelTask(id) }
    if (action === 'remove') hub.removeApp(a.id)
    if (action === 'offline') { now += 80000; hub.registry.sweepOffline(75000) }
    if (action === 'stop') hub.stop()
    assert.equal(await waiter, false)
    assert.equal(hub.resolveApproval(id, true), false)
    await until(() => worker.messages.some(m => m.type === 'task.cancelled'))
    assert.equal(worker.messages.filter(m => m.type === 'task.cancelled').length, 1)
    if (worker.ws.readyState === WebSocket.OPEN) {
      for (const type of ['task.progress', 'task.completed', 'task.failed']) worker.ws.send(JSON.stringify({ type, taskId: id, payload: { result: 'late' } }))
    }
    await tick()
    assert.equal(hub.tasks.get(id).status, 'cancelled')
    assert.equal(hub.tasks.get(id).result, undefined)
    assert.equal(worker.messages.filter(m => m.type === 'task.dispatched').length, 0)
  }
})

test('late hook approval, dispatch listener cancellation and invalid schema are contained', async t => {
  let resolveHook
  let executed = 0
  const { hub, request, register } = await fixture(t, { requestApproval: () => new Promise(resolve => { resolveHook = resolve }), executeTask: async () => { executed++ } })
  const a = await register('app.validation')
  for (const parameters of [null, [], 3, { count: 0 }, { count: '2' }, {}, { count: 1, extra: true }]) {
    assert.equal((await request('tasks', a, 'POST', { toolId: 'work', parameters })).status, 400)
    await assert.rejects(hub.dispatch({ appId: a.id, toolId: 'work', parameters }))
  }
  const pending = hub.dispatch({ appId: a.id, toolId: 'work', parameters: { count: 1 } })
  await until(() => resolveHook)
  const task = hub.tasks.list()[0]
  hub.cancelTask(task.taskId)
  await pending
  resolveHook(true)
  await tick()
  assert.equal(executed, 0)
  assert.equal(task.status, 'cancelled')
  hub.trustTool(a.id, 'work')
  assert.match(hub.describeToolsForLuna(), /inputSchema: .*required/)
  const read = await register('app.revalidate', 'read-only')
  hub.bus.subscribe('task.dispatched', ev => hub.cancelTask(ev.payload.taskId))
  await hub.dispatch({ appId: read.id, toolId: 'work', parameters: { count: 1 } })
  assert.equal(executed, 0)
})

test('running worker cancellation is cooperative and terminal; generic WS events cannot spoof completion', async t => {
  const { hub, request, register, connect } = await fixture(t)
  const a = await register('app.running', 'read-only')
  const { ws, messages } = await connect(a)
  const created = await request('tasks', a, 'POST', { toolId: 'work', parameters: { count: 1 } })
  const id = created.body.data.taskId
  await until(() => messages.some(m => m.type === 'task.dispatched'))
  ws.send(JSON.stringify({ type: 'event', payload: { type: 'task.completed', taskId: id, result: 'spoof' } }))
  await tick()
  assert.equal(hub.tasks.get(id).status, 'running')
  assert.equal((await request(`tasks/${id}/cancel`, a, 'POST', { reason: 'stop' })).status, 200)
  assert.equal((await request(`tasks/${id}/cancel`, a, 'POST', {})).status, 409)
  await until(() => messages.some(m => m.type === 'task.cancelled'))
  ws.send(JSON.stringify({ type: 'task.completed', taskId: id, payload: { result: 'late' } }))
  assert.equal((await request(`tasks/${id}/progress`, a, 'POST', { percentage: 99 })).status, 409)
  await tick()
  assert.equal(hub.tasks.get(id).status, 'cancelled')
  assert.equal(messages.filter(m => m.type === 'task.cancelled').length, 1)
})

test('rejected approval/execution hooks settle tasks without unhandled rejection; discovery is bounded', async t => {
  const { hub, request, register } = await fixture(t, {
    requestApproval: async () => { throw new Error('approval hook failed') },
    executeTask: async () => { throw new Error('execution hook failed') },
  })
  const a = await register('app.hook')
  const response = await request('tasks', a, 'POST', { toolId: 'work', parameters: { count: 1 } })
  assert.equal(response.status, 202)
  const id = response.body.data.taskId
  await until(() => hub.tasks.get(id).status === 'failed')
  assert.match(hub.tasks.get(id).error.message, /approval hook failed/)
  assert.equal(await hub.waitForApproval(id), false)
  const read = await register('app.execution', 'read-only')
  const dispatched = await hub.dispatch({ appId: read.id, toolId: 'work', parameters: { count: 1 } })
  await until(() => hub.tasks.get(dispatched.taskId).status === 'failed')
  assert.match(hub.tasks.get(dispatched.taskId).error.message, /execution hook failed/)
  const big = manifest('app.discovery', 'read-only')
  big.tools = Array.from({ length: 150 }, (_, i) => ({ ...big.tools[0], toolId: `tool_${i}`, description: 'long'.repeat(1000) }))
  hub.registry.register(big)
  const discovery = hub.describeToolsForLuna()
  assert.ok(discovery.length < 25000)
  assert.match(discovery, /inputSchema:/)
  assert.match(discovery, /已截断/)
})
