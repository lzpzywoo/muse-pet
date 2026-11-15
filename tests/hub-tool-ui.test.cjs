const { test } = require('node:test')
const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')
const Module = require('node:module')

function load(hooks) {
  const code = buildSync({ entryPoints: ['src/renderer/chat/HubToolInvocation.tsx'], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react/jsx-runtime'], write: false }).outputFiles[0].text
  const mod = new Module(__filename)
  mod.paths = module.paths
  const originalRequire = mod.require.bind(mod)
  mod.require = (name) => name === 'react' && hooks ? hooks : originalRequire(name)
  mod._compile(code, __filename)
  return mod.exports
}
const { parseHubParameters, formatHubResult, HubResultPreview } = load()

test('parameters accept objects and reject malformed JSON, null, arrays and primitives', () => {
  assert.deepEqual(parseHubParameters('{"keyword":"报告"}'), { keyword: '报告' })
  assert.deepEqual(parseHubParameters('{}'), {})
  for (const text of ['{', 'null', '[]', '1', 'true', '"text"']) assert.throws(() => parseHubParameters(text))
})

test('result preview bounds large, deep, cyclic and encoded payloads', () => {
  assert.match(formatHubResult({ total: 3, files: ['报告.txt'] }), /报告.txt/)
  assert.match(formatHubResult({ image: 'data:image/png;base64,' + 'A'.repeat(10000) }), /已省略/)
  assert.match(formatHubResult({ base64: 'A'.repeat(10000) }), /已省略/)
  assert.ok(formatHubResult(Array.from({ length: 1000 }, () => 'x'.repeat(10000))).length < 6100)
  const cyclic = {}; cyclic.self = cyclic
  assert.match(formatHubResult(cyclic), /循环引用/)
  assert.match(formatHubResult({ a: { b: { c: { d: { e: 'deep' } } } } }), /嵌套内容已省略/)
})

test('result text is escaped by React', () => {
  const React = require('react')
  const { renderToStaticMarkup } = require('react-dom/server')
  const html = renderToStaticMarkup(React.createElement(HubResultPreview, { value: '<img src=x onerror=alert(1)>' }))
  assert.ok(html.includes('&lt;img'))
  assert.ok(!html.includes('<img'))
})

function harness() {
  let cursor = 0
  const state = []
  let focused = 0
  const hooks = {
    useId: () => 'tool-test',
    useRef: () => ({ current: { focus: () => focused++ } }),
    useState: (initial) => {
      const index = cursor++
      if (!(index in state)) state[index] = initial
      return [state[index], (next) => { state[index] = next }]
    },
  }
  const { default: Component } = load(hooks)
  const props = { appId: 'test.app', tool: { name: '搜索', toolId: 'search', description: '搜索文件', inputSchema: { required: ['keyword'] } }, online: true, refresh: async () => {} }
  let tree
  const render = () => { cursor = 0; tree = Component(props) }
  const find = (type) => {
    function walk(node) {
      if (!node || typeof node !== 'object') return
      if (node.type === type) return node
      for (const child of [node.props?.children].flat(Infinity)) { const found = walk(child); if (found) return found }
    }
    return walk(tree)
  }
  render(); find('button').props.onClick(); render()
  return { render, find, props, focused: () => focused }
}

test('editor labels, validation timing, clear-on-input, submit prevention and invalid focus', async () => {
  const ui = harness()
  assert.equal(ui.find('label').props.htmlFor, ui.find('textarea').props.id)
  assert.equal(ui.find('textarea').props['aria-invalid'], false)
  ui.find('textarea').props.onChange({ target: { value: '[' } }); ui.render()
  assert.equal(ui.find('textarea').props['aria-invalid'], false)
  ui.find('textarea').props.onBlur(); ui.render()
  assert.equal(ui.find('textarea').props['aria-invalid'], true)
  assert.match(ui.find('textarea').props['aria-describedby'], /error/)
  let prevented = false
  await ui.find('form').props.onSubmit({ preventDefault: () => { prevented = true } })
  assert.equal(prevented, true)
  assert.equal(ui.focused(), 1)
  ui.find('textarea').props.onChange({ target: { value: '{}' } }); ui.render()
  assert.equal(ui.find('textarea').props['aria-invalid'], false)
})

test('submit forwards parameters, captures failure and refreshes after every call', async () => {
  const ui = harness()
  let refreshed = 0
  ui.props.refresh = async () => { refreshed++ }
  const previousWindow = global.window
  try {
    global.window = { chatApi: { runHubTool: async (app, tool, params) => {
      assert.equal(app, 'test.app'); assert.equal(tool, 'search'); assert.deepEqual(params, { keyword: '报告' })
      return { ok: true, taskId: 'task-1', status: 'awaiting_approval', result: { found: 1 } }
    } } }
    ui.find('textarea').props.onChange({ target: { value: '{"keyword":"报告"}' } }); ui.render()
    await ui.find('form').props.onSubmit({ preventDefault() {} }); ui.render()
    assert.equal(refreshed, 1)
    assert.equal(ui.find('form').props.children.find((item) => item?.type === 'button').props.disabled, false)
    global.window.chatApi.runHubTool = async () => { throw new Error('transport unavailable') }
    await ui.find('form').props.onSubmit({ preventDefault() {} }); ui.render()
    assert.equal(refreshed, 2)
    assert.match(JSON.stringify(ui.find('form')), /transport unavailable/)
  } finally { global.window = previousWindow }
})
