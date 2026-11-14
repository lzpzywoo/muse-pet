import type { LocalSecretary } from '../../local-secretary'
import type { AppManifest, ToolDefinition } from '../sdk-types'

/** Built-in read-only PC snapshot app — same data as desktop `/sys`. */
export const SYSTEM_SYS_APP_ID = 'system.sys'

export class SystemSysApp {
  constructor(private secretary: LocalSecretary) {}

  public readonly manifest: AppManifest = {
    appId: SYSTEM_SYS_APP_ID,
    name: '系统状态',
    version: '1.0.0',
    description:
      '只读查看当前电脑 CPU、内存与高占用进程快照。不执行脚本、不改系统。',
    secret: 'muse-builtin-system-sys',
    tools: [
      {
        toolId: 'snapshot',
        name: '查看系统快照',
        description:
          '返回当前电脑硬件与高占用进程的只读摘要。适用于「电脑卡不卡」「内存占用多少」。',
        category: 'query',
        riskLevel: 'read-only',
        inputSchema: { type: 'object', properties: {} },
      } satisfies ToolDefinition,
    ],
  }

  public async execute(_toolId: string, _params: Record<string, any> = {}): Promise<{
    note: string
    snapshot: string
    capturedAt: number
  }> {
    const snapshot = await this.secretary.getSystemSnapshot()
    return {
      note: '这是用户电脑当前的只读系统快照，请基于数据回答，不要声称已执行任何修改。',
      snapshot,
      capturedAt: Date.now(),
    }
  }
}
