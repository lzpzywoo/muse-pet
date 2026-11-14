const { test } = require('node:test')
const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')
const Module = require('node:module')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

const bundleTs = (filePath) => {
  const output = buildSync({
    entryPoints: [filePath],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    external: ['electron'],
  }).outputFiles[0].text
  const m = new Module(filePath)
  m._compile(output, filePath + '.cjs')
  return m.exports
}

const { HubServer, HUB_PORT } = bundleTs('src/main/hub/hub-server.ts')

test('HubServer: HTTP endpoints, app registration, task dispatch and WS event flow', async () => {
  const tmpState = path.join(os.tmpdir(), `hub-test-${Date.now()}.json`)
  const TEST_PORT = 19855
  let taskDispatched = null

  const hub = new HubServer({
    port: TEST_PORT,
    stateFilePath: tmpState,
    executeTask: async (taskId, appId, toolId, params) => {
      taskDispatched = { taskId, appId, toolId, params }
    },
    requestApproval: async () => true,
  })

  await hub.start()

  try {
    const base = `http://127.0.0.1:${TEST_PORT}`

    // 1. Initial tools list (empty or only builtins)
    const initialTools = await (await fetch(`${base}/api/v1/tools`)).json()
    assert.equal(initialTools.ok, true)
    assert.ok(Array.isArray(initialTools.data))

    // 2. Register a demo app
    const regRes = await (await fetch(`${base}/api/v1/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appId: 'com.demo.downloader',
        name: 'Demo Downloader',
        version: '1.0.0',
        description: 'Test downloader plugin',
        secret: 'demo-secret-key-12345',
        tools: [
          {
            toolId: 'add_download',
            name: '添加下载任务',
            description: '添加文件下载',
            category: 'action',
            riskLevel: 'write-safe',
            inputSchema: { type: 'object' },
          },
        ],
      }),
    })).json()

    assert.equal(regRes.ok, true)
    assert.ok(regRes.data.sessionToken)
    const token = regRes.data.sessionToken

    // 3. Heartbeat
    const hbRes = await (await fetch(`${base}/api/v1/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-App-Id': 'com.demo.downloader',
      },
      body: JSON.stringify({ status: 'active', activeTasks: 1 }),
    })).json()
    assert.equal(hbRes.ok, true)

    // 4. Verify app listed
    const apps = await (await fetch(`${base}/api/v1/apps`)).json()
    assert.equal(apps.ok, true)
    const demo = apps.data.find(a => a.appId === 'com.demo.downloader')
    assert.ok(demo)
    assert.equal(demo.online, true)

    // 5. Connect WebSocket client
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/ws?appId=com.demo.downloader&secret=demo-secret-key-12345`)
    const wsMessages = []
    await new Promise(r => ws.onopen = r)
    ws.onmessage = (e) => wsMessages.push(JSON.parse(e.data))

    await new Promise(r => setTimeout(r, 100))
    assert.equal(wsMessages[0]?.type, 'hub.connected')

    // 6. In-process dispatch from Luna
    const dispatchResult = await hub.dispatch({
      appId: 'com.demo.downloader',
      toolId: 'add_download',
      parameters: { url: 'https://example.com/test.zip' },
      origin: 'luna',
    })
    assert.equal(dispatchResult.status, 'running')
    assert.ok(dispatchResult.taskId)

    // Verify task dispatched via WS (documented contract: top-level taskId + payload.parameters)
    await new Promise(r => setTimeout(r, 100))
    const taskMsgs = wsMessages.filter(m => m.type === 'task.dispatched')
    assert.equal(taskMsgs.length, 1, 'exactly one task.dispatched frame')
    const taskMsg = taskMsgs[0]
    assert.equal(taskMsg.taskId, dispatchResult.taskId)
    assert.equal(taskMsg.payload?.taskId, dispatchResult.taskId)
    assert.equal(taskMsg.payload?.toolId, 'add_download')
    assert.deepEqual(taskMsg.payload?.parameters, { url: 'https://example.com/test.zip' })
    // Connected apps are delivered over WS; the in-process hook is only for builtins/offline fallback.
    assert.equal(taskDispatched, null)

    // 7. Client reports completion via WS
    ws.send(JSON.stringify({
      type: 'task.completed',
      taskId: dispatchResult.taskId,
      payload: { result: { savedTo: '/tmp/test.zip' } },
    }))

    await new Promise(r => setTimeout(r, 150))
    const taskStatus = hub.tasks.get(dispatchResult.taskId)
    assert.equal(taskStatus.status, 'completed')
    assert.equal(taskStatus.result?.savedTo, '/tmp/test.zip')

    ws.close()

    // 8. UI-style approval: waitForApproval unblocks only via resolveApproval
    hub.trustTool('com.demo.downloader', 'add_download') // trusted for later persistence check
    hub.untrustTool('com.demo.downloader', 'add_download')

    let approvalResolved = false
    const waiter = hub.waitForApproval('tsk_ui_approve_1').then((ok) => {
      approvalResolved = true
      return ok
    })
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(approvalResolved, false)
    assert.equal(hub.resolveApproval('tsk_ui_approve_1', true), true)
    assert.equal(await waiter, true)
    assert.equal(hub.resolveApproval('tsk_ui_approve_1', true), false)

    // Reject path
    const rejectWaiter = hub.waitForApproval('tsk_ui_reject_1')
    assert.equal(hub.resolveApproval('tsk_ui_reject_1', false), true)
    assert.equal(await rejectWaiter, false)

    // Persist trust then restore on a fresh HubServer
    hub.trustTool('com.demo.downloader', 'add_download')
    assert.equal(hub.registry.isTrusted('com.demo.downloader', 'add_download'), true)
    hub.stop()

    const hub2 = new HubServer({
      port: TEST_PORT + 1,
      stateFilePath: tmpState,
      executeTask: async () => {},
      requestApproval: async () => true,
    })
    assert.equal(hub2.registry.isTrusted('com.demo.downloader', 'add_download'), true)
    hub2.stop()

    // 9. Force-remove third-party apps from the panel path
    const hub3 = new HubServer({
      port: TEST_PORT + 2,
      stateFilePath: path.join(os.tmpdir(), `hub-test-remove-${Date.now()}.json`),
      executeTask: async () => {},
      requestApproval: async () => true,
    })
    await hub3.start()
    try {
      hub3.registry.register({
        appId: 'com.temp.plugin',
        name: 'Temp Plugin',
        secret: 'temp-secret-123456',
        tools: [
          {
            toolId: 'ping',
            name: 'Ping',
            description: 'ping',
            category: 'query',
            riskLevel: 'read-only',
            inputSchema: { type: 'object' },
          },
        ],
      })
      hub3.trustTool('com.temp.plugin', 'ping')
      assert.equal(hub3.removeApp('com.temp.plugin'), true)
      assert.equal(hub3.registry.get('com.temp.plugin'), undefined)
      assert.equal(hub3.registry.isTrusted('com.temp.plugin', 'ping'), false)

      hub3.registry.register({
        appId: 'system.screen',
        name: '系统屏幕视觉',
        secret: 'muse-builtin-system-screen',
        tools: [
          {
            toolId: 'capture',
            name: '截取当前屏幕',
            description: '截屏',
            category: 'vision',
            riskLevel: 'read-only',
            inputSchema: { type: 'object' },
          },
        ],
      })
      hub3.registry.markBuiltin('system.screen')
      assert.equal(hub3.removeApp('system.screen'), false)
      assert.ok(hub3.registry.get('system.screen'))
    } finally {
      hub3.stop()
    }
  } finally {
    try { hub.stop() } catch {}
    try { fs.unlinkSync(tmpState) } catch {}
  }
})
