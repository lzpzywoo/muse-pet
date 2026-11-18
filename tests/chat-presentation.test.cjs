const { test } = require('node:test')
const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')
const Module = require('node:module')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

function load(entry, hooks) {
  const code = buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react/jsx-runtime', 'lucide-react'], write: false }).outputFiles[0].text
  const mod = new Module(__filename)
  mod.paths = module.paths
  const original = mod.require.bind(mod)
  mod.require = name => name === 'react' && hooks ? hooks : original(name)
  mod._compile(code, __filename)
  return mod.exports
}
const { projectChatMessage: project, jsonSpans } = load('src/renderer/chat/chat-presentation.ts')
const msg = (content, extra = {}) => ({ id: 'message', role: 'assistant', content, ...extra })
const call = JSON.stringify({ action: 'local_tool', appId: 'test.app', toolId: 'read', parameters: { nested: [{ quote: 'a \\" } { [MUSE_LOCAL_TOOLS]', items: [{ x: true }] }] } })
const flat = { taskId: 'task-1', appId: 'test.app', toolId: 'read', status: 'completed', result: { secret: 'PAYLOAD', nested: [{ braces: '}{' }] } }
const exploration = { controller: { nextTools: [{ inputSchema: { nested: {} } }] }, result: { ...flat, result: { protocol: 'muse-software/1', kind: 'resource', data: { nested: ['PAYLOAD'] } } } }
const report = value => `[MUSE_LOCAL_TOOL_RESULT]\n${JSON.stringify(value)}\n[/MUSE_LOCAL_TOOL_RESULT]`

test('balanced quote-aware scanning removes only outer calls, including nested escaped parameters', () => {
  assert.equal(jsonSpans(call).length, 1)
  assert.deepEqual(project(msg(call)), { text: '', visible: false })
  for (const request of [call, `json\n${call}`, `\`\`\`json\n${call}\n\`\`\``, `\`\`\`json ${call}\`\`\``]) {
    assert.match(project(msg(`正在读取。\n${request}\n读取后给你总结。`)).text, /^正在读取。\n+读取后给你总结。$/)
  }
  const unrelated = '{"keep":{"x":"brace }"}}'
  assert.equal(project(msg(`${unrelated}\n${call}\n完成。`)).text, `${unrelated}\n\n完成。`)
  for (const data of [`{"example":${call}}`, `[${call}]`, `"${call}"`, `'${call}'`, `\`${call}\``]) {
    assert.equal(project(msg(data)).text, data)
  }
})

test('backticks inside JSON parameters do not split or expose protocol tails', () => {
  for (const query of ['Find `task` references', 'a ``` code fence inside JSON', 'nested \\" quote and `tick`']) {
    const json = JSON.stringify({ action: 'local_tool', appId: 'test.app', toolId: 'read', parameters: { query, secret: 'PAYLOAD' } })
    for (const text of [json, `\`\`\`json\n${json}\n\`\`\``]) {
      assert.deepEqual(project(msg(text)), { text: '', visible: false })
      assert.equal(project(msg(`先查一下。\n${text}\n查完告诉你。`)).text, '先查一下。\n\n查完告诉你。')
    }
  }
  const literal = '[MUSE_LOCAL_TOOL_RESULT]\n这个标记是什么意思？'
  assert.equal(project(msg(literal, { role: 'user' })).text, literal)
  const reportWithTicks = { ...flat, result: { text: 'Read `task` and ``` references', secret: 'PAYLOAD' } }
  for (const role of ['user', 'system', 'assistant']) assert.deepEqual(project(msg(JSON.stringify(reportWithTicks), { role })), { text: '', visible: false })
  const literalFence = '```json\n' + JSON.stringify(reportWithTicks) + '\n```'
  assert.equal(project(msg(literalFence, { role: 'user' })).text, literalFence)
  for (const role of ['user', 'assistant']) {
    const unclosedMarker = '[MUSE_LOCAL_TOOL_RESULT]\n' + JSON.stringify(flat) + '\n\n查询已完成，共有三个会话。'
    assert.equal(project(msg(unclosedMarker, { role })).text, '查询已完成，共有三个会话。')
  }
})

test('user code, quoted markers, unrelated JSON, and prose mentioning markers remain literal', () => {
  for (const content of [call, `\`\`\`json\n${call}\n\`\`\``, '为什么 [MUSE_LOCAL_TOOLS] 会出现？', '请解释 [MUSE_LOCAL_CONTEXT] 和 [MUSE_LOCAL_TOOL_RESULT] 的区别。', '`[MUSE_LOCAL_TOOLS]` 是什么？', '[MUSE_LOCAL_TOOLS]\n这个标记是什么意思？', '```text\n[MUSE_LOCAL_TOOLS]\nexample\n[/MUSE_LOCAL_TOOLS]\n```', '{"result":{"status":"ok"}}', '{"controller":{},"result":{"data":"human code"}}', '{"action":"other","parameters":{"action":"local_tool"}}']) {
    assert.equal(project(msg(content, { role: 'user' })).text, content)
  }
})

test('full decorated traces retain the question and strip injected schemas even with embedded fences', () => {
  const tools = '[MUSE_LOCAL_TOOLS]\nTools:\n```json\n' + call + '\n```\n[/MUSE_LOCAL_TOOLS]'
  const context = '[MUSE_LOCAL_CONTEXT]\nprivate context\n[/MUSE_LOCAL_CONTEXT]'
  for (const content of [`用户消息： 查询会话\n\n${tools}\n${context}`, `${tools}\n用户消息：查询会话\n${context}`, `查询会话\n${context}\n${tools}`]) {
    assert.deepEqual(project(msg(content, { role: 'user' })), { text: '查询会话', visible: true })
  }
  for (const content of [`用户消息：\n${tools}`, `${context}`, '用户消息：']) {
    assert.deepEqual(project(msg(content, { role: 'user' })), { text: '', visible: false })
  }
  assert.equal(project(msg('用户消息：请解释 用户消息： 这个标签', { role: 'user' })).text, '请解释 用户消息： 这个标签')
})

test('flat and exploration reports vanish without serialized previews, including malformed/truncated reports', () => {
  for (const value of [flat, exploration, { controller: {}, result: { truncated: true, preview: JSON.stringify(flat) } }]) {
    for (const role of ['user', 'assistant', 'system']) {
      assert.equal(project(msg(report(value), { role })).visible, false)
      assert.equal(project(msg(JSON.stringify(value), { role })).visible, false)
    }
  }
  for (const content of ['[MUSE_LOCAL_TOOL_RESULT]\n{"controller":{"result":BROKEN', '[MUSE_LOCAL_TOOL_RESULT]\n{ bad json }\n[/MUSE_LOCAL_TOOL_RESULT]', JSON.stringify(exploration).slice(0, -20), call.slice(0, -5), '{"action":"local_tool", nope}']) {
    assert.deepEqual(project(msg(content)), { text: '', visible: false })
  }
  assert.equal(project(msg(`已完成分析。\n${report(exploration)}\n共有三个会话。`)).text, '已完成分析。\n\n共有三个会话。')
  const embeddedDelimiter = { ...flat, result: { text: '[/MUSE_LOCAL_TOOL_RESULT]', secret: 'PAYLOAD' } }
  assert.equal(project(msg(report(embeddedDelimiter))).visible, false)
  const compact = `[MUSE_LOCAL_TOOL_RESULT]${JSON.stringify(flat)}[/MUSE_LOCAL_TOOL_RESULT]`
  assert.equal(project(msg(`${compact}\n保留这段总结。\n${report(exploration)}`)).text, '保留这段总结。')
})

test('streaming payloads do not flash once the protocol signature arrives; narrative survives', () => {
  for (let end = 1; end <= call.length; end++) {
    for (const prefix of ['', 'json\n', '```json\n']) {
      const projected = project(msg(`正在查询。\n${prefix}${call.slice(0, end)}`, { status: 'streaming' }))
      assert.equal(projected.text, '正在查询。')
      assert.equal(projected.visible, true)
    }
  }
  assert.equal(project(msg('', { status: 'streaming' })).visible, true)
})

test('success deliveries hide, failures remain readable without the report body', () => {
  assert.equal(project(msg('工具结果已同步到会话。\n' + report(flat))).visible, false)
  assert.equal(project(msg('本地结果已同步', { id: 'hub-result-1' })).visible, false)
  for (const text of ['工具结果送达失败，请稍后重试。', '工具结果未确认送达，请检查连接。', 'Result delivery uncertain']) {
    const result = project(msg(text + '\n' + report(flat), { id: 'hub-result-task-1', status: 'error' }))
    assert.equal(result.text, text)
    assert.equal(result.visible, true)
  }
  for (const value of [{ ...flat, status: 'failed', error: '连接已断开' }, { ...exploration, result: { ...flat, status: 'failed', error: '连接已断开' } }]) {
    assert.equal(project(msg(report(value))).text, '本地工具执行异常：连接已断开')
  }
  assert.equal(project(msg(report({ ...flat, status: 'failed', error: JSON.stringify(flat) }))).text, '本地工具执行异常，请在 /hub 查看任务详情。')
  assert.equal(project(msg('通信异常: 网络断开', { role: 'system', status: 'error' })).text, '通信异常: 网络断开')
})

test('attachments and all control types preserve protocol-only messages without mutating canonical data', () => {
  for (const extra of [{ attachments: [{ type: 'image', url: 'data:image/png;base64,SCREEN' }] }, { pendingAction: { id: 'approval' } }, { browser: { id: 'browser' } }, { appliedPlugin: { id: 'plugin' } }, { status: 'error' }]) {
    const message = msg(report(exploration), extra)
    const before = JSON.stringify(message)
    assert.equal(project(message).visible, true)
    assert.equal(JSON.stringify(message), before)
  }
})

function renderMessages(messages) {
  let cursor = 0
  const hooks = { ...React, useState: initial => React.useState(cursor++ === 0 ? messages : initial) }
  const { default: ChatApp } = load('src/renderer/chat/App.tsx', hooks)
  return renderToStaticMarkup(React.createElement(ChatApp))
}

test('actual chat React output hides protocol bubbles and preserves escaped narrative, screenshots and approvals', () => {
  const html = renderMessages([
    msg(call), msg(report(exploration), { id: 'report', role: 'user' }),
    msg('工具结果已同步到会话。\n' + report(flat), { id: 'hub-result-ok' }),
    msg('用户消息：真实问题\n[MUSE_LOCAL_TOOLS]\nprivate\n[/MUSE_LOCAL_TOOLS]', { id: 'question', role: 'user' }),
    msg('<script>alert(1)</script> 人类可读回答', { id: 'answer' }),
    msg(report(flat), { id: 'image', role: 'user', attachments: [{ type: 'image', url: 'data:image/png;base64,SCREEN', title: '屏幕截图' }] }),
    msg(call, { id: 'approval', pendingAction: { id: 'action', kind: 'powershell', title: '执行确认', status: 'pending', command: 'Get-Date' } }),
    msg(call, { id: 'browser', browser: { id: 'browser-1' } }),
    msg('结果送达失败', { id: 'hub-result-failed', role: 'system', status: 'error' }),
  ])
  for (const secret of ['MUSE_LOCAL_', 'local_tool', 'PAYLOAD', '已挂载本地能力', 'private', '本地工具结果已同步到会话']) assert.ok(!html.includes(secret), secret)
  for (const visible of ['真实问题', '人类可读回答', '&lt;script&gt;', '屏幕截图', 'SCREEN', 'Get-Date', '打开浏览器', '结果送达失败']) assert.ok(html.includes(visible), visible)
  assert.ok(!html.includes('<script>'))
  assert.equal((html.match(/stdout/g) || []).length, 3) // narrative, approval, browser
})


test('React keeps literal user tool examples and plugin controls, with ordinary shell execution available', () => {
  const html = renderMessages([
    msg('```json\n' + call + '\n```', { id: 'user-code', role: 'user' }),
    msg('```powershell\nGet-Process\n```', { id: 'shell' }),
    msg(report(flat), { id: 'plugin', appliedPlugin: { id: 'widget', name: '时钟小组件', description: '保留插件控制' } }),
  ])
  for (const visible of ['local_tool', 'Get-Process', '本地执行', '时钟小组件', '保留插件控制', '卸载并回滚']) assert.ok(html.includes(visible), visible)
  assert.ok(!html.includes('PAYLOAD'))
})
