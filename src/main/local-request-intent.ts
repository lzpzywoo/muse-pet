import type { AppManifest } from './hub/sdk-types'

/** Outfit changes belong to Muse's avatar, not local theme/script tools. */
export function isAvatarAppearanceRequest(content: string): boolean {
  const text = content.trim()
  if (text.startsWith('/') || /(终端|界面|插件|文件|目录|脚本|\b(?:css|terminal|plugin|file|folder|powershell)\b)/i.test(text)) return false
  return /(换装|换衣|穿上|脱下)/.test(text) ||
    (/(换|穿|变|改|打扮|戴|\b(?:change|wear|dress|switch|update)\b|put on)/i.test(text) &&
      /(衣服|衣裳|服装|穿搭|装扮|造型|形象|\b(?:outfit|clothes|costume|appearance|avatar)\b)/i.test(text))
}

/** Generic helper words alone never imply permission to prepare a local script. */
export function isLocalWriteRequest(content: string): boolean {
  const text = content.trim()
  if (text.startsWith('/') || isAvatarAppearanceRequest(text)) return false
  return /(整理桌面|结束进程|杀掉进程|关闭端口|清理端口)/i.test(text) ||
    /(?:执行|运行|编写|写一段|\b(?:run|execute|write)\b).*(?:脚本|命令|powershell|\bps1\b|\bscript\b|\bcommand\b)/i.test(text) ||
    /(?:删除|移动|新建|创建|修改|写入|保存|清理|关闭|关掉|结束|\b(?:delete|move|create|modify|save|kill|stop)\b).*(?:文件|文件夹|目录|进程|端口|注册表|环境变量|配置文件|\b(?:file|folder|directory|process|port|registry)\b)/i.test(text)
}

function mentionsLabel(text: string, label: string): boolean {
  const name = label.trim().toLowerCase()
  if (name.length < 2) return false
  if (/^[\x00-\x7f]+$/.test(name)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(?:^|[^a-z0-9_])${escaped}(?=$|[^a-z0-9_])`, 'i').test(text)
  }
  return text.includes(name)
}

/** Attach capability discovery only when the request actually concerns local tools. */
export function shouldIncludeHubTools(content: string, apps: Pick<AppManifest, 'appId' | 'name' | 'tools'>[]): boolean {
  const text = content.trim()
  if (/^\/(?:hub|agent-hub)(?:\s|$)/i.test(text)) return true
  if (!text || text.startsWith('/') || isAvatarAppearanceRequest(text)) return false
  const asksForAction = /(?:查看|看看|检查|查询|搜索|读取|调用|使用|运行|执行|列出|打开|启动|停止|进度|状态|怎么样|\b(?:check|query|search|read|use|run|list|open|start|stop|status|progress)\b)/i.test(text)
  const lower = text.toLowerCase()
  if (apps.some(app => lower.includes(app.appId.toLowerCase()))) return true
  if (!asksForAction) return false
  if (apps.some(app => [app.name, ...app.tools.map(tool => tool.name)].some(name => mentionsLabel(lower, name)))) return true
  return /(本地|这台电脑|我的电脑|已接入|\blocal\b|\bmy (?:pc|computer)\b)/i.test(text) &&
    /(工具|软件|应用|文件|下载|渲染|构建|编译|\b(?:tool|app|software|file|download|render|build)\b)/i.test(text)
}
