const { test } = require('node:test')
const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')
const Module = require('node:module')
const file = 'src/main/local-request-intent.ts'
const mod = new Module(file)
mod._compile(buildSync({ entryPoints: [file], bundle: true, format: 'cjs', platform: 'node', write: false }).outputFiles[0].text, file + '.cjs')
const { isAvatarAppearanceRequest: avatar, isLocalWriteRequest: write, shouldIncludeHubTools: hub } = mod.exports
const apps = [{ appId: 'com.demo.downloader', name: 'Demo Downloader', tools: [{ name: '查看下载队列' }] }]

test('ordinary chat and Muse outfit requests do not opt into local context', () => {
  for (const text of ['yoho. fish fish , 换一件万圣节的衣服吧', '帮我换一件万圣节的衣服吧', '帮我换个桌宠的造型', 'fish fish, change your outfit', 'put on a Halloween costume', '帮我写一首诗', '替我想个名字', 'hello fish fish', '运行得怎么样', '删掉刚才那句话']) {
    assert.equal(hub(text, apps), false, text)
    assert.equal(write(text), false, text)
  }
  assert.equal(avatar('帮我换个桌宠的造型'), true)
})
test('explicit discovery, registered software and concrete local-tool requests keep discovery', () => {
  for (const text of ['/hub tools', '/hub 查询下载队列', '检查 Demo Downloader 的队列', '查看下载队列', 'com.demo.downloader 怎么用', '使用本地渲染工具', '检查我的电脑下载进度', '调用hub中的方法哦', '用hub里的方法']) assert.equal(hub(text, apps), true, text)
  assert.equal(hub('请写一个关于下载的故事', apps), false)
  assert.equal(hub('Demo Downloader 是个有趣的名字', apps), false)
  assert.equal(hub('check latest news', [{ appId: 'com.demo.test', name: 'test', tools: [] }]), false)
})
test('third-party app keywords, descriptions and compound tool names trigger hub context', () => {
  const sessionApp = {
    appId: 'com.muse.session-manager',
    name: '会话与任务管理器',
    description: '提供 ThinkRail 多步骤长耗时会话生命周期管理与进度推送',
    keywords: ['thinkrail', 'session'],
    tools: [
      { toolId: 'create_and_run_session', name: '创建并执行会话任务', description: '创建会话' },
      { toolId: 'list_sessions', name: '查看所有会话列表', description: '列出所有会话' },
    ],
  }
  const appList = [sessionApp]
  assert.equal(hub('查看下 thinkrail 目前的会话任务', appList), true)
  assert.equal(hub('查询会话任务进度', appList), true)
  assert.equal(hub('列出会话列表', appList), true)
  assert.equal(hub('list_sessions', appList), true)
  assert.equal(hub('com.muse.session-manager 状态怎么样', appList), true)
  // Non-action mention of description word does not trigger
  assert.equal(hub('ThinkRail 是个不错的开源工具', appList), false)
})
test('local script preparation requires an operation and a concrete local target', () => {
  for (const text of ['运行 PowerShell 命令', '帮我删除本地文件', '替我移动文件到下载目录', '整理桌面', '关闭端口3000', '结束进程', 'run this script']) assert.equal(write(text), true, text)
  assert.equal(avatar('修改本地文件里的形象描述'), false)
  assert.equal(write('修改本地文件里的形象描述'), true)
  assert.equal(avatar('/plugin 万圣节主题'), false)
  assert.equal(avatar('把终端换成万圣节主题'), false)
})
