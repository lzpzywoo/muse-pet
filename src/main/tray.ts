import { Tray, Menu, nativeImage, NativeImage, app } from 'electron'
import { WindowManager } from './window-manager'

export class TrayManager {
  private tray: Tray | null = null
  private windowManager: WindowManager

  constructor(windowManager: WindowManager) {
    this.windowManager = windowManager
  }

  public init() {
    // Generate a clean 16x16 / 32x32 blue sphere icon for tray
    const icon = this.createDefaultIcon()
    this.tray = new Tray(icon)
    this.tray.setToolTip('Muse Pet — Windows 桌面 AI 伴侣')

    this.tray.on('click', () => {
      this.windowManager.toggleChatWindow()
    })

    this.updateContextMenu()
  }

  public updateContextMenu() {
    if (!this.tray) return

    const petWin = this.windowManager.getPetWindow()
    const isPetVisible = petWin ? petWin.isVisible() : true

    const loginSettings = app.getLoginItemSettings()

    const contextMenu = Menu.buildFromTemplate([
      {
        label: '呼出/收起对话 (Alt+Space)',
        click: () => {
          this.windowManager.toggleChatWindow()
        },
      },
      {
        label: isPetVisible ? '隐藏桌面宠物' : '显示桌面宠物',
        click: () => {
          const win = this.windowManager.getPetWindow()
          if (win) {
            if (win.isVisible()) win.hide()
            else win.show()
          }
          this.updateContextMenu()
        },
      },
      { type: 'separator' },
      {
        label: '开机自动启动',
        type: 'checkbox',
        checked: loginSettings.openAtLogin,
        click: (item) => {
          app.setLoginItemSettings({
            openAtLogin: item.checked,
          })
        },
      },
      { type: 'separator' },
      {
        label: '退出 Muse Pet',
        click: () => {
          app.quit()
        },
      },
    ])

    this.tray.setContextMenu(contextMenu)
  }

  private createDefaultIcon(): NativeImage {
    // Minimal 16x16 transparent PNG with a blue gradient circle
    const pngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAGxSURBVDhPrZJNSxtBFIafmd1skzRptdJSKYqC4EFRRBC86MGDerKgFz+e9X/0L/g3PLgQL3rw4KGI4EkQhCL4AcVqKaSmpkmbzWQ2c8bduLVoBfXChVl4ee6Hh5kZ4WfEwWJ1vj01u+W50XqH5+2bK2fXw4Nq8T9o98b2tZtzf63g1v0dnh3+Z03fS3f2K1Wlq63Z9Zf+87/z22m84sP521u6V5h86d+M2U+/t2/H9rV5eK/v0V79vV65f2D8d2a/N9f2X531/rPfvj72Z36d/36f1+fV+g611q9vV6s7386z/5+s2V75fvf3v7+9tW9z1/t/u/r/d7d8f/XWb63e9f+/2d7r/f/n+d5f/P+Z7f/n2b63Z1n+9/ev3f/X7v/v91+v71e4e+4r+7e3N/fv7x+1d7f/d+/18/97+/9d/e/v12/v17/evb98/1/9r+97/9ff7/9/e/v/v/f3/r9/7397/ff3/9//f3/99/f/319/vf3/9+/f/379//f97+9/vv17e2z/z+933x/6/f1v/b9e7/f/Z7f/n7/399/1+v/79/f/1/vf3/779f/n/f/n+d7f/n7/9///+6+fN6t+3jJ7Jj8AAAAASUVORK5CYII='
    const buffer = Buffer.from(pngBase64, 'base64')
    return nativeImage.createFromBuffer(buffer)
  }

  public destroy() {
    if (this.tray) {
      this.tray.destroy()
      this.tray = null
    }
  }
}
