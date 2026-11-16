const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { fileURLToPath } = require('node:url')
const Module = require('node:module')
const { buildSync } = require('esbuild')

const code = buildSync({ entryPoints: ['src/main/muse-client.ts'], bundle: true, platform: 'node',
  format: 'cjs', write: false, external: ['electron'] }).outputFiles[0].text
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function hooks(values) {
  return values.reduceRight((next, memoizedState) => ({ memoizedState, next }), null)
}
function stage(outfit = 'new', options = {}) {
  const urls = { default: `blob:${outfit}-default`, working: `blob:${outfit}-working`, resume: `blob:${outfit}-resume` }
  const video = {
    tagName: options.image ? 'IMG' : 'VIDEO',
    getAttribute: name => name === 'data-hatch-avatar-slot' ? (options.slot || 'current') : name === 'data-hatch-avatar-layer' ? 'ready' : null,
    src: options.image ? `blob:${outfit}-image` : urls.default, currentSrc: '',
    closest: () => options.chat ? {} : null,
    querySelector: () => null,
    __reactFiberTest: { memoizedState: hooks([{ current: { value: `blob:${outfit}-image` } }, urls]),
      return: { memoizedState: hooks([{ default: 'blob:historical-default', working: 'blob:historical-working' }]), return: null } },
  }
  return { video, urls }
}
function documentFor(videos) {
  return {
    title: 'Chat — Luna',
    querySelectorAll: selector => selector.includes('[data-hatch-avatar-layer]') ? videos : [],
    querySelector: () => ({ innerText: 'Luna\nStatus' }),
  }
}
function harness(t, fixture = stage()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-avatar-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const h = { root, cookies: 'hatch_sess=account-a', profile: { isLoggedIn: true }, calls: 0,
    fetched: [], failUrls: new Set(), events: [], saves: [], failWrite: '', fixture }
  const fsMock = { ...fs, writeFileSync: (filename, ...args) => {
    if (h.failWrite && filename.endsWith(h.failWrite)) throw new Error('mock disk failure')
    return fs.writeFileSync(filename, ...args)
  }, renameSync: (...args) => {
    if (h.failRename) throw new Error('mock metadata rename failure')
    return fs.renameSync(...args)
  } }
  const mod = new Module(path.resolve('src/main/muse-client.ts'), module)
  mod.paths = module.paths
  const original = mod.require.bind(mod)
  mod.require = name => name === 'electron' ? { app: { getPath: () => root } }
    : name === 'fs' ? fsMock : original(name)
  mod._compile(code, mod.filename + '.cjs')
  h.client = new mod.exports.MuseClient({
    getCookies: () => h.cookies, getProfile: () => h.profile,
    save: (cookies, profile) => { h.saves.push({ cookies, profile }); h.profile = profile },
  })
  h.client.onAvatarSyncedCallbacks.push(assets => h.events.push(assets))
  h.context = vm.createContext({
    document: documentFor([fixture.video]), window: {}, setTimeout, Map, Set,
    // Advance the timeout immediately for missing-stage fixtures; never wait for a live browser.
    Date: class extends Date { static now() { return (h.clock = (h.clock || 0) + 21000) } },
    fetch: async url => {
      h.fetched.push(url)
      if (h.fetchGate) await h.fetchGate.promise
      if (h.failUrls.has(url)) throw new Error('mock unavailable blob')
      return { ok: !h.httpFailure, blob: async () => ({ size: h.emptyBlob ? 0 : 1, url, type: /-image$/.test(url) ? 'image/webp' : 'video/mp4' }) }
    },
    FileReader: class {
      readAsDataURL(blob) {
        this.result = `data:${blob.type || 'video/mp4'};base64,${Buffer.from(blob.url).toString('base64')}`
        queueMicrotask(() => h.readerFailure ? this.onerror() : this.onload())
      }
    },
  })
  h.client.ensureMuseWindow = async () => ({ webContents: {
    executeJavaScript: async script => {
      if (script.includes('const readSource =')) {
        h.calls++
        if (h.executeGate) await h.executeGate.promise
      }
      return vm.runInContext(script, h.context)
    },
  } })
  h.meta = () => fs.readFileSync(path.join(root, 'avatar_cache', 'meta.json'), 'utf8')
  h.media = url => fs.readFileSync(fileURLToPath(new URL(url)), 'utf8')
  h.poll = async () => { await h.client.fetchCloudMessages(); if (h.client.avatarSyncPromise) await h.client.avatarSyncPromise }
  h.change = outfit => { h.fixture = stage(outfit); h.context.document = documentFor([h.fixture.video]) }
  return h
}

test('failed live signature retries unchanged on the next poll, then acknowledges only publication', async t => {
  const h = harness(t)
  h.failUrls.add(h.fixture.urls.working)
  await h.poll()
  assert.equal(h.calls, 1)
  assert.equal(h.client.lastAvatarSignature, null)
  assert.equal(h.client.getCachedAvatarAssets(), null)
  h.failUrls.clear()
  await h.poll()
  assert.equal(h.calls, 2)
  assert.ok(h.client.lastAvatarSignature)
  assert.equal(h.events.length, 1)
  await h.poll()
  assert.equal(h.calls, 2)
})

test('force and ordinary calls share one active promise and one publication', async t => {
  const h = harness(t)
  h.executeGate = deferred()
  const first = h.client.syncAvatarAssets()
  await Promise.resolve()
  const forced = h.client.syncAvatarAssets(true)
  const ordinary = h.client.syncAvatarAssets()
  assert.equal(first, forced)
  assert.equal(first, ordinary)
  assert.equal(h.calls, 1)
  h.executeGate.resolve()
  assert.ok(await first)
  assert.equal(h.events.length, 1)
})

test('unchanged successful syncs reuse the same complete snapshot even when forced', async t => {
  const h = harness(t)
  const first = await h.client.syncAvatarAssets()
  const meta = h.meta()
  for (let i = 0; i < 4; i++) assert.deepEqual(await h.client.syncAvatarAssets(true), first)
  assert.equal(h.meta(), meta)
  assert.equal(h.events.length, 1)
  assert.equal(fs.readdirSync(path.join(h.root, 'avatar_cache')).filter(name => !name.endsWith('.json')).length, 1)
})

test('startup removes obsolete snapshots before issuing URLs, retaining the published one', async t => {
  const h = harness(t, stage('old'))
  const old = await h.client.syncAvatarAssets()
  h.change('new')
  const current = await h.client.syncAvatarAssets(true)
  assert.ok(fs.existsSync(fileURLToPath(new URL(old.videos.default))), 'old renderer URLs survive the current session')
  const restarted = new h.client.constructor(h.client.sessionStore)
  assert.deepEqual(restarted.getCachedAvatarAssets(), current)
  assert.equal(fs.existsSync(fileURLToPath(new URL(old.videos.default))), false)
  assert.ok(fs.existsSync(fileURLToPath(new URL(current.videos.default))))
  assert.equal(fs.readdirSync(path.join(h.root, 'avatar_cache')).length, 2)
})

test('same source URLs with changed bytes publish a new complete snapshot', async t => {
  const h = harness(t)
  const first = await h.client.syncAvatarAssets()
  h.context.fetch = async url => ({ ok: true, blob: async () => ({ size: 1, url: url + '-new-bytes' }) })
  const second = await h.client.syncAvatarAssets(true)
  assert.notEqual(second.videos.default, first.videos.default)
  assert.match(h.media(second.videos.default), /new-bytes/)
  assert.equal(h.events.length, 2)
})

test('chat preview videos never substitute for a missing main stage', async t => {
  const h = harness(t, stage('chat', { chat: true }))
  await h.poll()
  assert.equal(h.calls, 0)
  assert.equal(await h.client.syncAvatarAssets(true), null)
  assert.deepEqual(h.fetched, [])
})

test('live IMG-only avatar publishes the current static image without waiting for videos', async t => {
  const h = harness(t, stage('halloween', { image: true }))
  await h.poll()
  const assets = h.client.getCachedAvatarAssets()
  assert.ok(assets.staticImageUrl.startsWith('data:image/webp;'))
  assert.equal(assets.videos, undefined)
  assert.deepEqual(h.fetched, ['blob:halloween-image'])
  assert.equal(JSON.parse(h.meta()).mediaKind, 'image')
  assert.equal(h.events.length, 1)
})

test('new static outfit replaces old video assets, then upgrades when current animations appear', async t => {
  const h = harness(t, stage('old'))
  const old = await h.client.syncAvatarAssets()
  h.fixture = stage('halloween', { image: true })
  h.context.document = documentFor([h.fixture.video])
  await h.poll()
  const image = h.client.getCachedAvatarAssets()
  assert.equal(image.videos, undefined)
  assert.notEqual(image.staticImageUrl, old.staticImageUrl)
  h.change('halloween')
  await h.poll()
  const animated = h.client.getCachedAvatarAssets()
  assert.equal(h.media(animated.videos.default), 'blob:halloween-default')
  assert.equal(animated.staticImageUrl, image.staticImageUrl)
  assert.equal(h.events.length, 3)
})

test('outgoing old video and chat IMG cannot override a current ready image layer', async t => {
  const h = harness(t)
  const old = stage('old', { slot: 'previous' })
  const current = stage('current', { image: true })
  const chat = stage('chat', { image: true, chat: true })
  h.context.document = documentFor([old.video, chat.video, current.video])
  const assets = await h.client.syncAvatarAssets(true)
  assert.equal(assets.videos, undefined)
  assert.deepEqual(h.fetched, ['blob:current-image'])
})

test('nearest current hooks supply the bundle; older ancestor maps and chat widgets are ignored', async t => {
  const h = harness(t)
  h.context.document = documentFor([stage('chat', { chat: true }).video, h.fixture.video])
  const assets = await h.client.syncAvatarAssets()
  assert.equal(h.media(assets.videos.default), 'blob:new-default')
  assert.equal(h.media(assets.videos.working), 'blob:new-working')
  assert.equal(h.media(assets.videos.resume), 'blob:new-resume')
  assert.deepEqual(h.fetched.sort(), ['blob:new-default', 'blob:new-image', 'blob:new-resume', 'blob:new-working'])
})

test('resume-only change affects the shared signature and triggers a new bundle', async t => {
  const h = harness(t)
  await h.poll()
  const signature = h.client.lastAvatarSignature
  h.fixture.urls.resume = 'blob:changed-resume'
  await h.poll()
  assert.equal(h.calls, 2)
  assert.notEqual(h.client.lastAvatarSignature, signature)
  assert.equal(h.media(h.client.getCachedAvatarAssets().videos.resume), 'blob:changed-resume')
})

for (const state of ['default', 'working', 'resume', 'image']) {
  test(`failed ${state} fetch preserves the complete previous bundle and its files`, async t => {
    const h = harness(t, stage('old'))
    const old = await h.client.syncAvatarAssets()
    const meta = h.meta()
    h.change('new')
    h.failUrls.add(`blob:new-${state}`)
    const assets = await h.client.syncAvatarAssets(true)
    assert.deepEqual(assets, old)
    assert.equal(h.meta(), meta)
    assert.equal(h.media(old.videos.default), 'blob:old-default')
    assert.equal(h.media(old.videos.working), 'blob:old-working')
    assert.equal(h.media(old.videos.resume), 'blob:old-resume')
    assert.equal(h.events.length, 1)
  })
}

test('failed staged write preserves metadata, old files, and acknowledged signature, then retries', async t => {
  const h = harness(t, stage('old'))
  const old = await h.client.syncAvatarAssets()
  const meta = h.meta()
  const signature = h.client.lastAvatarSignature
  h.change('new')
  h.failWrite = 'working.mp4'
  assert.deepEqual(await h.client.syncAvatarAssets(true), old)
  assert.equal(h.meta(), meta)
  assert.equal(h.client.lastAvatarSignature, signature)
  assert.equal(h.media(old.videos.default), 'blob:old-default')
  assert.equal(fs.readdirSync(path.join(h.root, 'avatar_cache')).length, 2)
  h.failWrite = ''
  await h.poll()
  assert.equal(h.media(h.client.getCachedAvatarAssets().videos.working), 'blob:new-working')
  assert.equal(h.media(old.videos.default), 'blob:old-default')
})

for (const switchSession of ['logout', 'account']) {
  test(`${switchSession} during extraction cannot publish or update the profile`, async t => {
    const h = harness(t, stage('old'))
    const old = await h.client.syncAvatarAssets()
    const meta = h.meta()
    h.change('new')
    h.fetchGate = deferred()
    const pending = h.client.syncAvatarAssets(true)
    await new Promise(resolve => setImmediate(resolve))
    h.cookies = switchSession === 'logout' ? '' : 'hatch_sess=account-b'
    h.profile = { isLoggedIn: switchSession !== 'logout' }
    h.fetchGate.resolve()
    assert.deepEqual(await pending, old)
    assert.equal(h.meta(), meta)
    assert.equal(h.events.length, 1)
    assert.equal(h.saves.length, 1)
    if (switchSession === 'account') {
      await h.poll()
      assert.equal(h.events.length, 2)
      assert.equal(h.saves[1].cookies, 'hatch_sess=account-b')
    }
  })
}

test('outfit changed during media reads is discarded and retried on next poll', async t => {
  const h = harness(t)
  h.fetchGate = deferred()
  const pending = h.client.syncAvatarAssets()
  await new Promise(resolve => setImmediate(resolve))
  h.change('latest')
  h.fetchGate.resolve()
  assert.equal(await pending, null)
  assert.equal(h.events.length, 0)
  await h.poll()
  assert.equal(h.media(h.client.getCachedAvatarAssets().videos.default), 'blob:latest-default')
})

for (const source of ['currentSrc', 'src', 'source']) {
  test(`stage ${source} supports HTTPS media without fiber state and uses only current files`, async t => {
    const h = harness(t, stage('old'))
    await h.client.syncAvatarAssets()
    const url = `https://example.test/${source}.mp4`
    const video = { src: '', currentSrc: '', closest: () => null, querySelector: () => null }
    if (source === 'source') video.querySelector = () => ({ src: url })
    else video[source] = url
    h.context.document = documentFor([video])
    const assets = await h.client.syncAvatarAssets(true)
    assert.equal(assets.staticImageUrl, undefined)
    for (const state of ['default', 'working', 'resume']) assert.equal(h.media(assets.videos[state]), url)
    assert.equal(h.fetched.filter(value => value === url).length, 1)
    assert.equal(h.profile.avatarUrl, undefined)
  })
}

test('profile persistence failure does not acknowledge an unannounced outfit and retries', async t => {
  const h = harness(t)
  const save = h.client.sessionStore.save
  h.client.sessionStore.save = () => { throw new Error('mock profile save failure') }
  await h.client.syncAvatarAssets()
  assert.equal(h.client.lastAvatarSignature, null)
  assert.equal(h.events.length, 0)
  h.client.sessionStore.save = save
  await h.poll()
  assert.equal(h.events.length, 1)
  assert.ok(h.client.lastAvatarSignature)
})

test('notification failure cannot acknowledge an outfit before hot-reload delivery', async t => {
  const h = harness(t)
  let reject = true
  h.client.onAvatarSynced(() => { if (reject) throw new Error('mock IPC failure') })
  await h.client.syncAvatarAssets()
  assert.equal(h.client.lastAvatarSignature, null)
  reject = false
  await h.poll()
  assert.ok(h.client.lastAvatarSignature)
})

test('bounded fiber and hook walks terminate on cycles', async t => {
  const h = harness(t)
  const hook = { memoizedState: null }; hook.next = hook
  const fiber = { memoizedState: hook }; fiber.return = fiber
  h.fixture.video.__reactFiberTest = fiber
  assert.ok(await h.client.syncAvatarAssets())
  assert.equal(h.fetched.length, 1)
})

for (const failure of ['httpFailure', 'emptyBlob', 'readerFailure']) {
  test(`${failure} does not acknowledge or publish a bundle`, async t => {
    const h = harness(t)
    h[failure] = true
    assert.equal(await h.client.syncAvatarAssets(), null)
    assert.equal(h.client.lastAvatarSignature, null)
    assert.equal(h.events.length, 0)
  })
}

for (const failure of ['metadata-write', 'metadata-rename']) {
  test(`${failure} failure keeps the previous snapshot readable and retries the same outfit`, async t => {
    const h = harness(t, stage('old'))
    const old = await h.client.syncAvatarAssets()
    const meta = h.meta()
    h.change('new')
    if (failure === 'metadata-write') h.failWrite = '.json'
    else h.failRename = true
    assert.deepEqual(await h.client.syncAvatarAssets(true), old)
    assert.equal(h.meta(), meta)
    assert.equal(h.events.length, 1)
    assert.equal(fs.readdirSync(path.join(h.root, 'avatar_cache')).length, 2)
    h.failWrite = ''; h.failRename = false
    await h.poll()
    assert.equal(h.events.length, 2)
    assert.equal(h.media(h.client.getCachedAvatarAssets().videos.default), 'blob:new-default')
  })
}
