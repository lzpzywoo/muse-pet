const { test } = require('node:test')
const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')
const Module = require('node:module')

// Transpile hub TypeScript modules to commonjs in-memory
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

const { HubRegistry } = bundleTs('src/main/hub/registry.ts')
const { HubAuth } = bundleTs('src/main/hub/auth.ts')
const { TaskManager } = bundleTs('src/main/hub/task-manager.ts')

test('HubRegistry: validates manifest and tracks online/heartbeat lifecycle', () => {
  let offlineApp = null
  let now = 1000
  const registry = new HubRegistry({
    now: () => now,
    onOffline: (appId) => { offlineApp = appId },
  })

  // Invalid appId
  assert.throws(() => registry.register({ appId: 'x', name: 'X', secret: '12345678', tools: [] }))

  // Valid manifest
  const app = registry.register({
    appId: 'com.test.downloader',
    name: 'Test Downloader',
    version: '1.0.0',
    description: 'A test download manager',
    secret: 'secret-key-12345',
    tools: [
      {
        toolId: 'download',
        name: '下载文件',
        description: '下载指定 URL 文件',
        category: 'action',
        riskLevel: 'write-safe',
        inputSchema: { type: 'object' },
      },
      {
        toolId: 'query',
        name: '查看进度',
        description: '查看下载进度',
        category: 'query',
        riskLevel: 'read-only',
        inputSchema: { type: 'object' },
      },
    ],
  })

  assert.equal(app.online, true)
  assert.equal(registry.listOnline().length, 1)
  assert.equal(registry.allTools().length, 2)
  assert.equal(registry.findTool('com.test.downloader', 'download')?.name, '下载文件')

  // Tool trust
  assert.equal(registry.isTrusted('com.test.downloader', 'download'), false)
  registry.trustTool('com.test.downloader', 'download')
  assert.equal(registry.isTrusted('com.test.downloader', 'download'), true)
  registry.untrustTool('com.test.downloader', 'download')
  assert.equal(registry.isTrusted('com.test.downloader', 'download'), false)

  // Heartbeat & sweep offline
  now += 10000
  registry.heartbeat('com.test.downloader')
  now += 50000 // Total 60s since last heartbeat -> not offline with 75s threshold
  assert.equal(registry.sweepOffline(75000).length, 0)
  now += 30000 // 90s since heartbeat -> swept offline
  const swept = registry.sweepOffline(75000)
  assert.deepEqual(swept, ['com.test.downloader'])
  assert.equal(offlineApp, 'com.test.downloader')
  assert.equal(registry.listOnline().length, 0)
})

test('HubAuth: token issuance, verification, and risk level evaluation', () => {
  const auth = new HubAuth({ signingKey: 'super-secret-signing-key-12345678' })
  const token = auth.issueToken('com.test.app')

  assert.equal(auth.verifyToken(token), 'com.test.app')
  assert.equal(auth.verifyToken('invalid.token'), null)
  assert.equal(auth.verifyToken(undefined), null)

  // Risk levels
  assert.equal(auth.evaluate('read-only', false), 'allow')
  assert.equal(auth.evaluate('read-only', true), 'allow')
  assert.equal(auth.evaluate('write-safe', false), 'approve')
  assert.equal(auth.evaluate('write-safe', true), 'allow')
  assert.equal(auth.evaluate('write-dangerous', false), 'approve')
  assert.equal(auth.evaluate('write-dangerous', true), 'approve') // Dangerous is NEVER auto-allowed
})

test('TaskManager: state machine transitions, progress, and cancellation', () => {
  let now = 1000
  const tasks = new TaskManager({ now: () => now })
  const events = []
  tasks.onAny((ev) => events.push(ev.type))

  const task = tasks.create({
    appId: 'com.test.app',
    toolId: 'render',
    parameters: { frames: 100 },
    priority: 'high',
  })

  assert.equal(task.status, 'pending')
  assert.equal(tasks.activeCount('com.test.app'), 1)

  tasks.markDispatched(task.taskId)
  assert.equal(task.status, 'running')
  assert.equal(events.includes('task.dispatched'), true)

  tasks.updateProgress(task.taskId, { percentage: 50, message: '50/100' })
  assert.equal(task.progress?.percentage, 50)
  assert.equal(events.includes('task.progress'), true)

  tasks.complete(task.taskId, { file: 'out.mp4' })
  assert.equal(task.status, 'completed')
  assert.equal(task.result?.file, 'out.mp4')
  assert.equal(tasks.activeCount('com.test.app'), 0)

  // Cancel offline tasks
  const t2 = tasks.create({ appId: 'com.test.app', toolId: 'render2', parameters: {} })
  tasks.markDispatched(t2.taskId)
  assert.equal(tasks.cancelAppTasks('com.test.app'), 1)
  assert.equal(t2.status, 'cancelled')
})
