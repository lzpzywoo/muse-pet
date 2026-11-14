import { app, BrowserWindow, desktopCapturer } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AppManifest, ToolDefinition } from '../sdk-types'

/**
 * Built-in `system.screen` application — the reference implementation of a
 * Muse Local Agent Hub app, and the delivery vehicle for P1
 * "let me see my PC screen from my phone".
 *
 * It reuses the proven content-protection trick so Muse Pet's own windows are
 * excluded from the capture without hiding or flickering them.
 */
export const SYSTEM_SCREEN_APP_ID = 'system.screen'

export interface ScreenCaptureResult {
  filePath: string
  fileUrl: string
  base64Data: string
  mimeType: string
  width: number
  height: number
  capturedAt: number
}

export class SystemScreenApp {
  public readonly manifest: AppManifest = {
    appId: SYSTEM_SCREEN_APP_ID,
    name: '系统屏幕视觉',
    version: '1.0.0',
    description:
      '获取当前电脑桌面画面，供 Luna 分析挂机进度、排队状态、游戏画面、报错弹窗等视觉信息。截屏会自动排除 Muse Pet 自身的桌宠与终端窗口。',
    secret: 'muse-builtin-system-screen',
    tools: [
      {
        toolId: 'capture',
        name: '截取当前屏幕',
        description:
          '截取主显示器当前画面并返回 base64 图像。适用于用户询问"看看我电脑上怎么样了""下载到多少了""游戏排到没"等需要视觉判断的问题。',
        category: 'vision',
        riskLevel: 'read-only',
        inputSchema: {
          type: 'object',
          properties: {
            displayIndex: { type: 'number', default: 0, description: '显示器序号，默认 0' },
            maxWidth: { type: 'number', default: 1920, description: '输出图像最大宽度，默认 1920' },
            quality: { type: 'number', default: 75, description: 'JPEG 质量 1-100' },
          },
        },
        outputSchema: {
          type: 'object',
          properties: {
            width: { type: 'number' },
            height: { type: 'number' },
            capturedAt: { type: 'number' },
          },
        },
      } satisfies ToolDefinition,
      {
        toolId: 'capture_and_describe',
        name: '截屏并描述画面',
        description: '截取当前屏幕，返回图像与一份简短的技术性画面摘要（分辨率、窗口遮挡情况）。',
        category: 'vision',
        riskLevel: 'read-only',
        inputSchema: {
          type: 'object',
          properties: {
            displayIndex: { type: 'number', default: 0 },
          },
        },
      } satisfies ToolDefinition,
    ],
  }

  /** Manifest without the builtin secret, safe to expose to the renderer. */
  public publicManifest(): AppManifest {
    return { ...this.manifest, secret: '' }
  }

  public async execute(toolId: string, params: Record<string, any>): Promise<any> {
    if (toolId === 'capture') {
      const shot = await this.capture(params)
      return {
        image: `data:${shot.mimeType};base64,${shot.base64Data}`,
        width: shot.width,
        height: shot.height,
        capturedAt: shot.capturedAt,
        note: '这是用户电脑当前桌面的真实截图，请基于画面内容回答。',
      }
    }
    if (toolId === 'capture_and_describe') {
      const shot = await this.capture(params)
      return {
        image: `data:${shot.mimeType};base64,${shot.base64Data}`,
        width: shot.width,
        height: shot.height,
        capturedAt: shot.capturedAt,
        summary: `主屏 ${shot.width}×${shot.height}，采集于 ${new Date(shot.capturedAt).toISOString()}`,
        note: '请描述画面内容并回答用户问题。',
      }
    }
    throw new Error(`unknown tool: ${toolId}`)
  }

  private async capture(params: Record<string, any>): Promise<ScreenCaptureResult> {
    const displayIndex = Math.max(0, Number(params.displayIndex) || 0)
    const maxWidth = Math.min(3840, Math.max(640, Number(params.maxWidth) || 1920))
    const quality = Math.min(100, Math.max(30, Number(params.quality) || 75))

    const visibleAppWindows = BrowserWindow.getAllWindows().filter(
      (w) => !w.isDestroyed() && w.isVisible()
    )
    const winBuild = Number(require('node:os').release().split('.')[2] || 0)
    const useDwmExclude =
      (process.platform === 'win32' && winBuild >= 19041) || process.platform === 'darwin'

    try {
      if (useDwmExclude) {
        for (const w of visibleAppWindows) w.setContentProtection(true)
        await new Promise((r) => setTimeout(r, 90))
      } else {
        for (const w of visibleAppWindows) w.hide()
        await new Promise((r) => setTimeout(r, 140))
      }

      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: maxWidth, height: Math.round((maxWidth * 9) / 16) },
      })
      if (!sources || sources.length === 0) {
        throw new Error('未能获取到当前桌面屏幕画面')
      }
      const source = sources[Math.min(displayIndex, sources.length - 1)]
      const pngBuffer = source.thumbnail.toPNG()
      const size = source.thumbnail.getSize()

      const mediaDir = path.join(app.getPath('userData'), 'media_cache')
      fs.mkdirSync(mediaDir, { recursive: true })
      const filePath = path.join(mediaDir, `hub-screen-${Date.now()}.png`)
      fs.writeFileSync(filePath, pngBuffer)

      return {
        filePath,
        fileUrl: pathToFileURL(filePath).href,
        base64Data: pngBuffer.toString('base64'),
        mimeType: 'image/png',
        width: size.width,
        height: size.height,
        capturedAt: Date.now(),
      }
    } finally {
      if (useDwmExclude) {
        for (const w of visibleAppWindows) {
          if (!w.isDestroyed()) w.setContentProtection(false)
        }
      } else {
        for (const w of visibleAppWindows) {
          if (!w.isDestroyed()) w.show()
        }
      }
    }
  }
}
