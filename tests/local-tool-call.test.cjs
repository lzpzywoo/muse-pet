const { test } = require('node:test')
const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')
const Module = require('node:module')
const filename = 'src/main/hub/local-tool-call.ts'
const bundled = buildSync({ entryPoints: [filename], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text
const m = new Module(filename)
m._compile(bundled, filename + '.cjs')
const { extractLocalToolCall: extract } = m.exports
const call = (parameters = {}) => ({ action: 'local_tool', appId: 'system.files', toolId: 'read', parameters })

test('nested objects and arrays survive fenced, raw and prose-wrapped JSON', () => {
  const value = call({ path: 'C:\\Users\\test\\Documents\\a.txt', options: { tags: ['a', { enabled: true }] } })
  const json = JSON.stringify(value)
  for (const text of [json, `准备调用：${json}。`, '```json\n' + json + '\n```', '```\n' + json + '\n```']) {
    assert.deepEqual(extract(text), value)
  }
})
test('fenced instructions are independent of unmatched punctuation in surrounding prose', () => {
  const value = call({ path: 'report.txt' })
  for (const prefix of ['I will check your 27" monitor.', '文字中未闭合的 {', 'unfinished [']) {
    assert.deepEqual(extract(prefix + '\n```json\n' + JSON.stringify(value) + '\n```'), value)
  }
})

test('braces, quotes and backslashes inside strings do not end the instruction', () => {
  const value = call({ path: 'a{b}.txt', text: 'quote " and slash \\ and }{' })
  assert.deepEqual(extract(JSON.stringify(value)), value)
})
test('reject invalid identifiers and non-object parameters', () => {
  for (const value of [
    { ...call(), appId: {} }, { ...call(), appId: '' }, { ...call(), toolId: 1 },
    { ...call(), toolId: ' ' }, { ...call(), appId: 'system.files\n' },
    { ...call(), parameters: [] }, { ...call(), parameters: null },
    { ...call(), parameters: 'x' }, { ...call(), action: 'other' },
  ]) assert.equal(extract(JSON.stringify(value)), null)
  const { parameters, ...withoutParams } = call()
  assert.deepEqual(extract(JSON.stringify(withoutParams)), call())
})
test('does not promote nested instructions or instructions quoted inside JSON', () => {
  assert.equal(extract(JSON.stringify({ example: call({ path: 'a' }) })), null)
  assert.equal(extract(JSON.stringify({ example: JSON.stringify(call()) })), null)
  assert.equal(extract(JSON.stringify([call()])), null)
  assert.equal(extract(JSON.stringify(JSON.stringify(call()))), null)
})
test('ignores malformed/truncated JSON; accepts later independent valid objects', () => {
  assert.equal(extract('{"action":"local_tool","appId":"system.sys","toolId":"snapshot","parameters":{'), null)
  assert.equal(extract('{"action":"local_tool", "appId": }'), null)
  assert.deepEqual(extract('文字 {"other":true} ' + JSON.stringify(call())), call())
})
test('system.sys rejects an unknown tool before collecting a snapshot', async () => {
  const filename = 'src/main/hub/builtins/system-sys.ts'
  const source = buildSync({ entryPoints: [filename], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text
  const mod = new Module(filename)
  mod._compile(source, filename + '.cjs')
  let captures = 0
  const app = new mod.exports.SystemSysApp({ getSystemSnapshot: async () => { captures++; return 'ok' } })
  await assert.rejects(app.execute('not_a_tool'), /unknown tool/)
  assert.equal(captures, 0)
  assert.equal((await app.execute('snapshot')).snapshot, 'ok')
})

test('repeated instruction copies yield just one call', () => {
  const value = call({ path: 'a.txt' })
  const json = JSON.stringify(value)
  assert.deepEqual(extract('```json\n' + json + '\n```\n' + json), value)
})
