import type { LocalSecretary } from '../../local-secretary'
import type { AppManifest, ToolDefinition } from '../sdk-types'

/**
 * Built-in read-only file search/read app.
 * Search roots and excerpt caps stay inside LocalSecretary — do not widen them here.
 */
export const SYSTEM_FILES_APP_ID = 'system.files'

export class SystemFilesApp {
  constructor(private secretary: LocalSecretary) {}

  public readonly manifest: AppManifest = {
    appId: SYSTEM_FILES_APP_ID,
    name: '本地文件（只读）',
    version: '1.0.0',
    description:
      '仅在桌面、下载和文档目录中搜索文件名或读取文本摘要；不写入、不删除，不读取目录外的文件。',
    secret: 'muse-builtin-system-files',
    tools: [
      {
        toolId: 'search',
        name: '搜索本地文件',
        description:
          '按文件名关键字搜索桌面、下载和文档（深度与条数有上限）。参数 keyword 必填。',
        category: 'query',
        riskLevel: 'read-only',
        inputSchema: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: '文件名关键字' },
          },
          required: ['keyword'],
        },
      } satisfies ToolDefinition,
      {
        toolId: 'read',
        name: '读取文件摘要',
        description:
          '读取桌面/下载/文档中的文本文件摘要（有长度上限）。参数 path 为文件名或路径。',
        category: 'query',
        riskLevel: 'read-only',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '文件名或路径' },
          },
          required: ['path'],
        },
      } satisfies ToolDefinition,
    ],
  }

  public async execute(toolId: string, params: Record<string, any> = {}): Promise<any> {
    if (toolId === 'search') {
      if (typeof params?.keyword !== 'string' || !params.keyword.trim()) throw new Error('缺少非空字符串 keyword')
      const keyword = params.keyword.trim()
      const paths = this.secretary.searchLocalFiles(keyword)
      return {
        note: '只读搜索结果（桌面/下载/文档，有条数上限）。',
        keyword,
        count: paths.length,
        paths,
        capturedAt: Date.now(),
      }
    }
    if (toolId === 'read') {
      if (typeof params?.path !== 'string' || !params.path.trim()) throw new Error('缺少非空字符串 path')
      const target = params.path.trim()
      const file = this.secretary.readLocalFileExcerpt(target)
      return {
        note: '只读文本摘要（可能被截断）。',
        resolvedPath: file.resolvedPath,
        content: file.content,
        capturedAt: Date.now(),
      }
    }
    throw new Error(`unknown tool ${toolId}`)
  }
}
