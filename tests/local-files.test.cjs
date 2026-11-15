const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const { buildSync } = require('esbuild')
function load(file, overrides = {}) {
  const code = buildSync({ entryPoints: [file], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron'] }).outputFiles[0].text
  const mod = new Module(file, module)
  mod.paths = module.paths
  const original = mod.require.bind(mod)
  mod.require = name => Object.hasOwn(overrides, name) ? overrides[name] : original(name)
  mod._compile(code, file + '.cjs')
  return mod.exports
}
const { LocalFiles } = load('src/main/local-files.ts')
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-files-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const roots = ['Known Desktop', 'Known Downloads', 'Known Documents'].map(name => path.join(base, name))
  const outside = roots[0] + '-sibling'
  for (const dir of [...roots, outside]) fs.mkdirSync(dir)
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside secret')
  return { base, roots, outside, files: new LocalFiles(roots) }
}
test('reads only allowed real roots, including Documents and relative files', t => {
  const { files, roots, outside } = fixture(t)
  fs.writeFileSync(path.join(roots[2], 'note.txt'), 'hello')
  assert.equal(files.readLocalFileExcerpt('note.txt').content, 'hello')
  assert.equal(files.readLocalFileExcerpt(path.join(roots[2], 'note.txt')).resolvedPath, fs.realpathSync(path.join(roots[2], 'note.txt')))
  for (const target of [path.join(outside, 'secret.txt'), '../Known Desktop-sibling/secret.txt', roots[0] + '/../../escape', 'note.txt:secret', 'C:relative', '\\\\?\\C:\\secret', '', {}, null]) {
    assert.throws(() => files.readLocalFileExcerpt(target))
  }
  assert.throws(() => files.searchLocalFiles('secret', outside))
  assert.throws(() => files.searchLocalFiles({}))
})
test('rejects junction escapes and omits linked entries from search and directory output', t => {
  const { files, roots, outside } = fixture(t)
  const link = path.join(roots[0], 'escape')
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => files.readLocalFileExcerpt(path.join(link, 'secret.txt')))
  assert.throws(() => files.readLocalFileExcerpt(link))
  assert.throws(() => files.searchLocalFiles('secret', link))
  assert.deepEqual(files.searchLocalFiles('escape'), [])
  assert.deepEqual(files.searchLocalFiles('secret'), [])
  assert.doesNotMatch(files.readLocalFileExcerpt(roots[0]).content, /escape/)
})
test('known-folder roots may themselves be redirected, with canonical results', t => {
  const { roots, outside } = fixture(t)
  const redirected = path.join(roots[1], 'redirected')
  fs.symlinkSync(outside, redirected, process.platform === 'win32' ? 'junction' : 'dir')
  const files = new LocalFiles([redirected])
  assert.equal(files.readLocalFileExcerpt('secret.txt').content, 'outside secret')
  assert.deepEqual(files.searchLocalFiles('secret'), [fs.realpathSync(path.join(outside, 'secret.txt'))])
})
test('caps excerpts at 4000 characters and rejects files above 1 MiB', t => {
  const { files, roots } = fixture(t)
  const file = path.join(roots[0], 'large.txt')
  fs.writeFileSync(file, 'é'.repeat(524288))
  assert.equal(files.readLocalFileExcerpt(file).content.length, 4000)
  assert.equal(files.readLocalFileExcerpt(file, 9000).content.length, 4000)
  assert.equal(files.readLocalFileExcerpt(file, 10).content.length, 10)
  fs.appendFileSync(file, 'x')
  assert.throws(() => files.readLocalFileExcerpt(file), /1 MiB/)
})
test('preserves search depth 3 / 25 results and directory 50 entries', t => {
  const { files, roots } = fixture(t)
  let dir = roots[0]
  for (let depth = 0; depth <= 4; depth++) {
    fs.writeFileSync(path.join(dir, `depth${depth}.txt`), 'ok')
    dir = path.join(dir, 'child'); fs.mkdirSync(dir)
  }
  assert.equal(files.searchLocalFiles('depth').length, 4)
  for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(roots[1], `match-${i}`), 'ok')
  assert.equal(files.searchLocalFiles('match').length, 25)
  assert.equal(files.readLocalFileExcerpt(roots[1]).content.split('\n').length, 51)
})
test('SystemFilesApp requires actual primary string params and ignores root widening', async () => {
  const { SystemFilesApp } = load('src/main/hub/builtins/system-files.ts')
  const calls = []
  const app = new SystemFilesApp({ searchLocalFiles: (...args) => { calls.push(args); return [] }, readLocalFileExcerpt: target => ({ resolvedPath: target, content: 'ok' }) })
  for (const value of [{}, [], 42, null, '', '  ']) {
    await assert.rejects(app.execute('search', { keyword: value }))
    await assert.rejects(app.execute('read', { path: value }))
  }
  await assert.rejects(app.execute('search', { query: 'secret' }))
  await assert.rejects(app.execute('read', { file: 'secret' }))
  await app.execute('search', { keyword: ' note ', root: 'C:\\' })
  assert.deepEqual(calls, [['note']])
})
test('bounds reads to 1 MiB plus one byte when the opened file grows', t => {
  const { roots } = fixture(t)
  const file = path.join(roots[0], 'growing.txt')
  fs.writeFileSync(file, 'initial')
  let requested = 0
  const mockFs = { ...fs, readSync(fd, buffer, offset, length, position) {
    if (!requested) fs.appendFileSync(file, Buffer.alloc(2 * 1024 * 1024, 120))
    requested += length
    return fs.readSync(fd, buffer, offset, length, position)
  } }
  const { LocalFiles: GrowingFiles } = load('src/main/local-files.ts', { fs: mockFs })
  assert.throws(() => new GrowingFiles(roots).readLocalFileExcerpt(file), /1 MiB/)
  assert.equal(requested, 1024 * 1024 + 1)
})
test('rejects binary and special files without opening special files', t => {
  const { files, roots } = fixture(t)
  const binary = path.join(roots[0], 'binary.bin')
  fs.writeFileSync(binary, Buffer.from([1, 0, 2]))
  assert.throws(() => files.readLocalFileExcerpt(binary), /文本/)
  let opened = false
  const mockFs = { ...fs, statSync(target) {
    const stat = fs.statSync(target)
    if (target === fs.realpathSync(binary)) stat.isFile = () => false
    return stat
  }, openSync() { opened = true; throw Error('must not open') } }
  const { LocalFiles: SpecialFiles } = load('src/main/local-files.ts', { fs: mockFs })
  assert.throws(() => new SpecialFiles(roots).readLocalFileExcerpt(binary), /普通文本/)
  assert.equal(opened, false)
})
test('LocalSecretary delegates using Electron known folders for desktop and Hub methods', t => {
  const { roots, outside } = fixture(t)
  fs.writeFileSync(path.join(roots[2], 'document.txt'), 'known folder content')
  const folders = { desktop: roots[0], downloads: roots[1], documents: roots[2] }
  const requested = []
  const { LocalSecretary } = load('src/main/local-secretary.ts', { electron: { app: { getPath(name) { requested.push(name); return folders[name] } } } })
  // No constructor/initialization: this exercises file delegation without app state or private files.
  const secretary = Object.create(LocalSecretary.prototype)
  assert.equal(secretary.readLocalFileExcerpt('document.txt').content, 'known folder content')
  assert.equal(secretary.searchLocalFiles('document').length, 1)
  assert.throws(() => secretary.readLocalFileExcerpt(path.join(outside, 'secret.txt')))
  assert.deepEqual(requested.slice(0, 3), ['desktop', 'downloads', 'documents'])
  const { SystemFilesApp } = load('src/main/hub/builtins/system-files.ts')
  return assert.rejects(new SystemFilesApp(secretary).execute('read', { path: path.join(outside, 'secret.txt') }))
})
