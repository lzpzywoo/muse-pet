import * as fs from 'fs'
import * as path from 'path'

const MAX_BYTES = 1024 * 1024
const MAX_CHARS = 4000

/** File policy shared by desktop commands and system.files; no Electron dependency. */
export class LocalFiles {
  constructor(private readonly roots: readonly string[]) {}

  private input(value: string): string {
    if (typeof value !== 'string' || !value.trim()) throw new Error('需要非空文件路径或关键字')
    return value.trim()
  }

  private target(value: string): string {
    const target = this.input(value).replace(/^["']|["']$/g, '')
    // Reject traversal, device namespaces and alternate data streams before normalization.
    const withoutDrive = process.platform === 'win32' ? target.replace(/^[a-z]:[\\/]/i, '') : target
    if (!target || target.includes('\0') || target.split(/[\\/]/).includes('..') ||
        withoutDrive.includes(':') || /^[\\/]{2}[?.][\\/]/.test(target)) {
      throw new Error('不允许的文件路径')
    }
    return target
  }

  private contains(root: string, target: string): boolean {
    const relative = path.relative(root, target)
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  }

  private allowedRoots(): string[] {
    return this.roots.flatMap(root => {
      try {
        const real = fs.realpathSync(root)
        return fs.statSync(real).isDirectory() ? [real] : []
      } catch {
        return []
      }
    })
  }

  private canonical(target: string, roots: readonly string[]): string {
    const real = fs.realpathSync(target)
    if (!roots.some(root => this.contains(root, real))) throw new Error('仅允许访问桌面、下载和文档目录')
    return real
  }

  private resolve(target: string, roots: readonly string[]): string {
    if (path.isAbsolute(target)) return this.canonical(target, roots)
    for (const root of roots) {
      const candidate = path.resolve(root, target)
      if (!this.contains(root, candidate)) continue
      if (fs.existsSync(candidate)) return this.canonical(candidate, roots)
    }
    throw new Error('找不到允许目录中的文件')
  }

  public searchLocalFiles(keyword: string, customRoot?: string): string[] {
    const lowerKey = this.input(keyword).toLowerCase()
    const roots = this.allowedRoots()
    const starts = customRoot === undefined ? roots : [this.resolve(this.target(customRoot), roots)]
    const matches: string[] = []
    const seen = new Set<string>()
    const walk = (dir: string, depth: number) => {
      if (depth > 3 || matches.length >= 25) return
      // Recheck each directory, including linked entries, before opening it.
      let handle: fs.Dir | undefined
      try {
        const realDir = this.canonical(dir, roots)
        handle = fs.opendirSync(realDir)
        let entry: fs.Dirent | null
        while (matches.length < 25 && (entry = handle.readSync())) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
          try {
            const candidate = this.target(path.join(realDir, entry.name))
            const real = this.canonical(candidate, roots)
            const stat = fs.statSync(real)
            if (!stat.isFile() && !stat.isDirectory()) continue
            if (entry.name.toLowerCase().includes(lowerKey) && !seen.has(real)) {
              matches.push(real)
              seen.add(real)
            }
            // Linked directories can cycle; depth is always bounded.
            if (stat.isDirectory()) walk(real, depth + 1)
          } catch {
            // Missing, inaccessible, special or escaping entries are not results.
          }
        }
      } catch {
        // An unavailable search directory contributes no results.
      } finally {
        handle?.closeSync()
      }
    }
    for (const root of starts) walk(root, 0)
    return matches
  }

  public readLocalFileExcerpt(targetPath: string, maxChars = MAX_CHARS): { resolvedPath: string; content: string } {
    const roots = this.allowedRoots()
    const resolvedPath = this.resolve(this.target(targetPath), roots)
    const cap = Number.isFinite(maxChars) ? Math.max(0, Math.min(MAX_CHARS, Math.floor(maxChars))) : MAX_CHARS
    const stat = fs.statSync(resolvedPath)
    if (stat.isDirectory()) {
      const items: string[] = []
      const dir = fs.opendirSync(this.canonical(resolvedPath, roots))
      try {
        let entry: fs.Dirent | null
        while (items.length < 50 && (entry = dir.readSync())) {
          try {
            const real = this.canonical(this.target(path.join(resolvedPath, entry.name)), roots)
            const entryStat = fs.statSync(real)
            if (entryStat.isDirectory() || entryStat.isFile()) items.push(entry.name)
          } catch {
            // Do not expose entries whose targets escape the allowed roots.
          }
        }
      } finally {
        dir.closeSync()
      }
      return { resolvedPath, content: `[目录内容 (${items.length} 项)]:\n${items.join('\n')}`.slice(0, cap) }
    }
    if (!stat.isFile()) throw new Error('仅支持普通文本文件或目录')
    if (stat.size > MAX_BYTES) throw new Error('文件超过 1 MiB 上限')
    // O_NONBLOCK avoids blocking on a FIFO substituted between stat and open.
    const fd = fs.openSync(this.canonical(resolvedPath, roots), fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0))
    try {
      const opened = fs.fstatSync(fd)
      if (!opened.isFile()) throw new Error('仅支持普通文本文件')
      if (opened.size > MAX_BYTES) throw new Error('文件超过 1 MiB 上限')
      const checked = fs.statSync(this.canonical(resolvedPath, roots))
      if (checked.dev !== opened.dev || checked.ino !== opened.ino) throw new Error('文件在读取前已更改')
      // Fixed allocation and one sentinel byte bound reads even if the file grows.
      const buffer = Buffer.alloc(MAX_BYTES + 1)
      let length = 0
      while (length < buffer.length) {
        const count = fs.readSync(fd, buffer, length, buffer.length - length, length)
        if (!count) break
        length += count
      }
      if (length > MAX_BYTES || fs.fstatSync(fd).size > MAX_BYTES) throw new Error('文件超过 1 MiB 上限')
      this.canonical(resolvedPath, roots)
      if (buffer.subarray(0, length).includes(0)) throw new Error('仅支持文本文件')
      return { resolvedPath, content: buffer.toString('utf8', 0, length).slice(0, cap) }
    } finally {
      fs.closeSync(fd)
    }
  }
}
