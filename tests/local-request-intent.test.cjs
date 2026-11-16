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
  for (const text of ['/hub tools', '/hub 查询下载队列', '检查 Demo Downloader 的队列', '查看下载队列', 'com.demo.downloader 怎么用', '使用本地渲染工具', '检查我的电脑下载进度']) assert.equal(hub(text, apps), true, text)
  assert.equal(hub('请写一个关于下载的故事', apps), false)
  assert.equal(hub('Demo Downloader 是个有趣的名字', apps), false)
  assert.equal(hub('check latest news', [{ appId: 'com.demo.test', name: 'test', tools: [] }]), false)
})
test('local script preparation requires an operation and a concrete local target', () => {
  for (const text of ['运行 PowerShell 命令', '帮我删除本地文件', '替我移动文件到下载目录', '整理桌面', '关闭端口3000', '结束进程', 'run this script']) assert.equal(write(text), true, text)
  assert.equal(avatar('修改本地文件里的形象描述'), false)
  assert.equal(write('修改本地文件里的形象描述'), true)
  assert.equal(avatar('/plugin 万圣节主题'), false)
  assert.equal(avatar('把终端换成万圣节主题'), false)
})
