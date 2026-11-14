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

    // Verify task dispatched via WS
    await new Promise(r => setTimeout(r, 100))
    const taskMsg = wsMessages.find(m => m.type === 'task.dispatched')
    assert.ok(taskMsg)
    assert.equal(taskMsg.payload?.taskId, dispatchResult.taskId)

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
  } finally {
    hub.stop()
    try { fs.unlinkSync(tmpState) } catch {}
  }
})
