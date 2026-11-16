const { test } = require('node:test')
const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')
const Module = require('node:module')
const bundle = (file) => {
  const m = new Module(file)
  m._compile(buildSync({ entryPoints: [file], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, file)
  return m.exports
}
const { HubRegistry } = bundle('src/main/hub/registry.ts')
const { HubServer } = bundle('src/main/hub/hub-server.ts')
const { getSoftwareExplorationPolicy, validateSoftwareExploration, validateSoftwareResponse } = bundle('src/main/hub/software-exploration.ts')
const manifest = () => ({
  appId: 'test.software', name: 'Software', version: '1', description: 'Software guide', secret: 'private-secret',
  exploration: { version: 1, overviewToolId: 'overview', discoverToolId: 'discover', readToolId: 'read' },
  tools: ['overview', 'discover', 'read', 'other'].map(toolId => ({ toolId, name: toolId, description: `${toolId} description`, category: 'query', riskLevel: 'read-only', inputSchema: { type: 'object' } })),
})
const response = (kind = 'overview') => ({ protocol: 'muse-software/1', kind, status: 'ok', source: { id: 'provider', kind: 'live' }, observedAt: '2026-06-01T12:00:00.000Z', data: { projects: [] } })

test('registration accepts legacy and exploration manifests, rejecting malformed or unsafe endpoints', () => {
  const legacy = manifest(); delete legacy.exploration
  assert.doesNotThrow(() => new HubRegistry().register(legacy))
  assert.equal(getSoftwareExplorationPolicy(legacy), undefined)
  assert.doesNotThrow(() => new HubRegistry().register(manifest()))
  const changes = [
    m => { m.exploration = null }, m => { m.exploration = [] },
    m => { m.exploration.version = 2 }, m => { delete m.exploration.readToolId },
    m => { m.exploration.readToolId = 'missing' }, m => { m.exploration.readToolId = 'overview' },
    m => { m.tools[1].riskLevel = 'write-safe' }, m => { m.tools[2].riskLevel = 'write-dangerous' },
    m => { m.tools[0].requiresApproval = true },
    m => { m.tools[0].requiresApproval = 'false' },
    m => { m.tools[1].inputSchema = [] },
    m => { m.tools.push({ ...m.tools[0] }) },
  ]
  for (const change of changes) {
    const m = manifest(); change(m)
    assert.throws(() => new HubRegistry().register(m))
    assert.throws(() => getSoftwareExplorationPolicy(m), /exploration/i)
  }
  const m = manifest()
  m.tools[1].inputSchema = { type: 'object', properties: { parentRef: { type: 'string' }, query: { type: 'string' }, cursor: { type: 'string' } } }
  m.tools[2].inputSchema = { type: 'object', required: ['ref'], properties: { ref: { type: 'string' }, arguments: { type: 'object' } } }
  assert.doesNotThrow(() => validateSoftwareExploration(m))
})

test('policy revisions are stable, secret-free, sensitive to metadata and safe after mutation', () => {
  const m = manifest()
  const p = getSoftwareExplorationPolicy(m)
  assert.equal(p.tools.length, 3)
  assert.equal(p.appId, m.appId)
  assert.match(p.revision, /^[a-f0-9]{64}$/)
  assert.ok(!JSON.stringify(p).includes(m.secret))
  const changedSecret = { ...m, secret: 'different-secret', sessionToken: 'hidden' }
  assert.equal(getSoftwareExplorationPolicy(changedSecret).revision, p.revision)
  const reordered = manifest(); reordered.tools[0].inputSchema = { properties: {}, type: 'object' }
  const reorderedAgain = structuredClone(reordered); reorderedAgain.tools[0].inputSchema = { type: 'object', properties: {} }
  assert.equal(getSoftwareExplorationPolicy(reordered).revision, getSoftwareExplorationPolicy(reorderedAgain).revision)
  for (const change of [m => { m.version = '2' }, m => { m.tools[0].description = 'Changed' }, m => { m.tools[2].inputSchema.required = ['ref'] }, m => { m.tools[0].outputSchema = { type: 'object' } }]) {
    const changed = manifest(); change(changed)
    assert.notEqual(getSoftwareExplorationPolicy(changed).revision, p.revision)
  }
  const unexpected = manifest(); unexpected.tools[0].secret = 'runtime-secret'
  assert.ok(!JSON.stringify(getSoftwareExplorationPolicy(unexpected)).includes('runtime-secret'))
  p.tools[1].inputSchema.properties = { injected: { type: 'string' } }
  assert.equal(m.tools[1].inputSchema.properties, undefined)
  m.tools[0].inputSchema.required = ['leaked']
  assert.equal(p.tools[0].inputSchema.required, undefined)
  m.tools[0].riskLevel = 'write-safe'
  assert.throws(() => getSoftwareExplorationPolicy(m), /exploration/i)
})

test('response validates source, endpoint kind, ISO time and explicit availability', () => {
  const policy = getSoftwareExplorationPolicy(manifest())
  for (const [tool, kind] of [['overview', 'overview'], ['discover', 'directory'], ['read', 'resource']]) {
    assert.doesNotThrow(() => validateSoftwareResponse(tool, policy, response(kind)))
    for (const status of ['unsupported', 'unavailable']) {
      const value = response(kind); value.status = status; delete value.data
      value.source.kind = status === 'unsupported' ? 'documentation' : 'cache'
      assert.doesNotThrow(() => validateSoftwareResponse(tool, policy, value))
    }
  }
  const changes = [
    v => { v.protocol = 'other' }, v => { v.kind = 'resource' }, v => { v.status = 'empty' },
    v => { delete v.data }, v => { v.source.id = '' }, v => { v.source.kind = 'filesystem' },
    v => { v.observedAt = 'yesterday' }, v => { v.observedAt = '2026-02-30T00:00:00Z' },
    v => { v.references = Array(31).fill({ ref: 'x', title: 'X', kind: 'entity' }) },
    v => { v.references = [{ ref: '', title: 'X', kind: 'entity' }] },
    v => { v.references = [{ ref: 'x', title: 'X', kind: 'file' }] },
    v => { v.references = [{ ref: 'x', title: 'X', kind: 'query', inputSchema: [] }] },
    v => { v.nextCursor = 1 }, v => { v.nextCursor = 'x'.repeat(2049) },
    v => { v.data = 'x'.repeat(300000) },
    v => { v.data = {}; v.data.self = v.data },
    v => { v.data = Array.from({ length: 20001 }, () => null) },
    v => { v.data = {}; let node = v.data; for (let i = 0; i < 40; i++) { node.child = {}; node = node.child } },
  ]
  for (const change of changes) { const v = response(); change(v); assert.throws(() => validateSoftwareResponse('overview', policy, v), /software/i) }
  assert.throws(() => validateSoftwareResponse('other', policy, response()), /software/i)
  const valid = response(); valid.references = [{ ref: 'opaque:project', title: 'Project', kind: 'entity', description: 'Guide', inputSchema: { type: 'object' } }]; valid.nextCursor = null
  assert.doesNotThrow(() => validateSoftwareResponse('overview', policy, valid))
})

test('filtered initial discovery exposes exploration overview and legacy tools within 24k', () => {
  const hub = new HubServer({ stateFilePath: 'nonexistent-exploration-test-state.json', executeTask: async () => {}, requestApproval: async () => false })
  const m = manifest(); hub.registry.register(m)
  const legacy = manifest(); legacy.appId = 'test.legacy'; delete legacy.exploration; hub.registry.register(legacy)
  const text = hub.describeToolsForLuna([m.appId])
  assert.match(text, /toolId: overview/)
  assert.doesNotMatch(text, /toolId: (discover|read|other)/)
  assert.doesNotMatch(text, /test.legacy|private-secret/)
  assert.match(text, /muse-software\/1/)
  assert.equal(hub.describeToolsForLuna([]), '')
  assert.match(hub.describeToolsForLuna(['test.legacy']), /toolId: read/)
  const publicApp = hub.publicApp(hub.registry.get(m.appId))
  assert.deepEqual(publicApp.exploration, m.exploration)
  assert.ok(!JSON.stringify(publicApp).includes(m.secret))
  for (let i = 0; i < 30; i++) { const large = manifest(); large.appId = `large.app${i}`; large.tools[0].description = 'x'.repeat(1000); hub.registry.register(large) }
  assert.ok(hub.describeToolsForLuna().length <= 24000)
  hub.stop()
})
