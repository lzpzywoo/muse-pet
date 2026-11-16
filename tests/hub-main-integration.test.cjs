const { test } = require('node:test')
const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')
const Module = require('node:module')
function load(file, overrides = {}, external = []) {
  const code = buildSync({ entryPoints: [file], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', ...external] }).outputFiles[0].text
  const mod = new Module(file, module)
  mod.paths = module.paths
  const original = mod.require.bind(mod)
  mod.require = name => Object.hasOwn(overrides, name) ? overrides[name] : name === 'electron' ? {} : original(name)
  mod._compile(code, file + '.cjs')
  return mod.exports
}
const { MuseClient } = load('src/main/muse-client.ts')
const { pcAccount } = load('src/main/pc-status-bridge.ts')
function client() {
  const c = Object.create(MuseClient.prototype)
  c.isSendingChat = false
  c.isFetchingCloudData = false
  c.sessionStore = { getCookies: () => 'hatch_sess=test' }
  c.museWindow = { isDestroyed: () => false, isVisible: () => false, webContents: { isLoading: () => false, getURL: () => 'https://muse.ai/' } }
  return c
}
test('Hub reports preserve origin checks and forward screenshots through the conservative composer', async () => {
  const c = client()
  let args
  c.sendViaMuseWindow = async (...value) => { args = value }
  const image = { imageBase64: 'YWJj', imageMimeType: 'image/png', imageFileName: 'screen.png' }
  await c.sendHubReport('actual result', 'https://muse.ai/', pcAccount('hatch_sess=test'), image)
  assert.equal(args[0], 'actual result')
  assert.deepEqual(args[5], { ...image, pcBridge: true, pcAccount: pcAccount('hatch_sess=test'), hubBridge: true })
  assert.equal(c.isSendingChat, false)
  args = undefined
  await assert.rejects(c.sendHubReport('secret', 'https://muse.ai/other', pcAccount('hatch_sess=test')), err => err.code === 'pc_not_submitted')
  await assert.rejects(c.sendHubReport('secret', 'https://muse.ai/', 'wrong-account'), err => err.code === 'pc_not_submitted')
  assert.equal(args, undefined)
})
test('Hub preflight can defer text; post-attachment rejection and post-click failure are never labelled safe to retry', async () => {
  const c = client()
  c.sendViaMuseWindow = async (_text, _cookies, _chunk, _end, error) => error('pc_not_submitted')
  const account = pcAccount('hatch_sess=test')
  await assert.rejects(c.sendHubReport('text', 'https://muse.ai/', account), err => err.code === 'pc_not_submitted')
  await assert.rejects(c.sendHubReport('image', 'https://muse.ai/', account, { imageBase64: 'YWJj', imageMimeType: 'image/png', imageFileName: 'a.png' }), err => err.code !== 'pc_not_submitted')
  c.sendViaMuseWindow = async (_text, _cookies, _chunk, _end, error) => error('submission_unknown')
  await assert.rejects(c.sendHubReport('text', 'https://muse.ai/', account), err => err.code !== 'pc_not_submitted')
  assert.equal(c.isSendingChat, false)
})
test('previous stop does not poison a new report; interruption during submission is uncertain', async () => {
  const c = client()
  c.aborted = true
  c.sendViaMuseWindow = async () => { assert.equal(c.aborted, false) }
  await c.sendHubReport('new result', 'https://muse.ai/', pcAccount('hatch_sess=test'))
  c.sendViaMuseWindow = async () => { c.aborted = true }
  await assert.rejects(c.sendHubReport('interrupted', 'https://muse.ai/', pcAccount('hatch_sess=test')), err => err.code !== 'pc_not_submitted' && /不确定/.test(err.message))
})

test('Hub gate cards cannot fall through to PowerShell even without a live IPC mapping', async () => {
  const { LocalSecretary } = load('src/main/local-secretary.ts')
  const secretary = Object.create(LocalSecretary.prototype)
  secretary.pendingActions = new Map([['hub-action', { id: 'hub-action', type: 'hub_tool', status: 'pending', command: '{"path":"x"}' }]])
  let executed = false
  secretary.executeCommandForAction = () => { executed = true }
  await assert.rejects(secretary.approveAction('hub-action'), /Hub/)
  assert.equal(executed, false)
})
test('tracked result waiter handles early completion, late failure and timeout without listener leaks', async () => {
  const { waitForHubResult } = load('src/main/hub/task-result.ts')
  const { HubEventBus } = load('src/main/hub/event-bus.ts')
  const bus = new HubEventBus()
  const task = { taskId: 't', status: 'completed', result: 42 }
  const hub = { bus, tasks: { get: () => task }, cancelTask: () => { task.status = 'cancelled' } }
  assert.equal(await waitForHubResult(hub, 't'), 42)
  assert.equal(bus.listenerCount('*'), 0)
  task.status = 'running'
  const pending = waitForHubResult(hub, 't')
  task.status = 'failed'; task.error = { message: 'worker failed' }
  bus.publish({ type: 'task.failed', payload: { taskId: 't' } })
  await assert.rejects(pending, /worker failed/)
  assert.equal(bus.listenerCount('*'), 0)
  task.status = 'running'
  await assert.rejects(waitForHubResult(hub, 't', 5), /超时/)
  assert.equal(task.status, 'cancelled')
  assert.equal(bus.listenerCount('*'), 0)
})

test('actual IPC registration connects phone observations, tracked builtins and cancelled approval cards', async t => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const { EventEmitter } = require('node:events')
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-hub-main-'))
  const app = new EventEmitter()
  app.getPath = () => temp
  const handlers = new Map()
  const ipcMain = { handle: (name, fn) => handlers.set(name, fn), on: () => {} }
  const { HubServer } = load('src/main/hub/hub-server.ts')
  let activeHub
  class TestHub extends HubServer {
    constructor(options) { super({ ...options, port: 0 }); activeHub = this }
    start() { return (this.started = super.start()) }
  }
  let pluginCalls = 0
  class Secretary {
    init() {}
    synthesizePluginFromRequest() { pluginCalls++; return { name: 'fake', category: 'theme', description: 'fake' } }
    onStateUpdated() {}
    onActionUpdated(callback) { this.updated = callback }
    async getSystemSnapshot() { return 'actual CPU snapshot' }
    createPendingAction(type, title, command, description, extra) {
      const action = { id: 'approval-1', type, title, command, description, status: 'pending', ...extra }
      this.actions = new Map([[action.id, action]]); this.updated(action); return action
    }
    getPendingAction(id) { return this.actions?.get(id) }
    settlePendingAction(id, status, output) {
      const action = this.actions.get(id)
      if (action.status !== 'pending') return action
      const changed = { ...action, status, output }; this.actions.set(id, changed); this.updated(changed); return changed
    }
  }
  const sends = [], events = [], outgoing = []
  let observer, cloudUpdate
  const cloudHistory = [{ id: 'cloud-user', role: 'user', content: 'Use my tool', timestamp: Date.now() }]
  const muse = {
    onPcObservation: callback => { observer = callback },
    startCloudMessageWatcher() {}, onCloudBrowserStatus() {}, onCloudMessagesUpdated(callback) { cloudUpdate = callback }, onAvatarSynced() {},
    fetchCloudMessages: async () => cloudHistory,
    syncAvatarAssets: async () => {},
    pcAvailable: () => true,
    refreshToolObservation: async () => {},
    sendChatMessage: async text => { outgoing.push(text) },
    sendHubReport: async (...args) => { sends.push(args) },
  }
  const chat = { isDestroyed: () => false, webContents: { send: (name, payload) => events.push([name, payload]) } }
  const windows = { getChatWindow: () => chat, getPetWindow: () => null, setAvatarState: () => {} }
  const { registerIpcHandlers } = load('src/main/ipc-handlers.ts', {
    electron: { app, ipcMain }, './hub/hub-server': { HubServer: TestHub, HUB_PORT: 19840 },
    './local-secretary': { LocalSecretary: Secretary },
  }, ['./hub/hub-server', './local-secretary'])
  t.after(() => { activeHub?.stop(); fs.rmSync(temp, { recursive: true, force: true }) })
  registerIpcHandlers(windows, muse, { getCookies: () => 'hatch_sess=test', getProfile: () => ({ isLoggedIn: true }) }, {})
  await activeHub.started
  for (const text of ['yoho. fish fish , 换一件万圣节的衣服吧', '帮我换一件万圣节的衣服吧', '帮我换个桌宠的造型', '帮我写一首诗', 'hello fish fish']) {
    await handlers.get('chat:send-message')({}, text)
    assert.equal(outgoing.at(-1), text, 'ordinary chat must reach Muse unchanged')
  }
  assert.equal(pluginCalls, 0, 'Muse outfit changes are not local CSS/plugin requests')
  await handlers.get('chat:send-message')({}, '/hub tools')
  assert.match(outgoing.at(-1), /\[MUSE_LOCAL_TOOLS\]/)
  const account = pcAccount('hatch_sess=test')
  const base = { account, conversation: 'https://muse.ai/', epoch: 'page', ready: true }
  await observer({ ...base, messages: [{ id: 'old', role: 'user', content: 'Hello' }] })
  await observer({ ...base, messages: [
    { id: 'old', role: 'user', content: 'Hello' },
    { id: 'ask', role: 'user', content: 'Use the tool\n[MUSE_LOCAL_TOOLS]catalog[/MUSE_LOCAL_TOOLS]' },
    { id: 'answer', role: 'assistant', content: JSON.stringify({ action: 'local_tool', appId: 'system.sys', toolId: 'snapshot', parameters: {} }) },
  ] })
  for (let i = 0; i < 50 && sends.length === 0; i++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(sends.length, 1)
  assert.match(sends[0][0], /actual CPU snapshot/)
  assert.equal(sends[0][1], 'https://muse.ai/')
  const state = await handlers.get('hub:get-state')({})
  assert.equal(state.tasks[0].status, 'completed')
  assert.ok(state.apps.find(a => a.appId === 'system.files').tools[0].inputSchema)
  activeHub.registry.register({ appId: 'com.integration.app', name: 'test', version: '1', secret: 'secret-12345', tools: [{ toolId: 'write', name: 'Write', description: 'test', riskLevel: 'write-dangerous', category: 'action', inputSchema: { type: 'object' } }] })
  const pending = activeHub.dispatch({ appId: 'com.integration.app', toolId: 'write', parameters: {} })
  await new Promise(resolve => setImmediate(resolve))
  const task = activeHub.tasks.list().find(task => task.appId === 'com.integration.app')
  assert.equal(task.status, 'awaiting_approval')
  assert.ok(events.some(([name, payload]) => name === 'chat:messages-synced' && payload.some(m => m.pendingAction?.type === 'hub_tool')))
  cloudUpdate(cloudHistory)
  let synced = await handlers.get('chat:get-messages')({})
  assert.ok(synced.some(message => message.pendingAction?.id === 'approval-1' && message.pendingAction.status === 'pending'))
  synced = await handlers.get('chat:sync-messages')({})
  assert.ok(synced.some(message => message.pendingAction?.id === 'approval-1' && message.pendingAction.status === 'pending'))
  assert.equal(task.status, 'awaiting_approval')
  await handlers.get('hub:cancel-task')({}, task.taskId)
  await pending
  const result = await handlers.get('secretary:approve-action')({}, 'approval-1')
  assert.equal(result.status, 'denied')
  assert.equal(task.status, 'cancelled')
})
