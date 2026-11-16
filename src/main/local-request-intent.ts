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

export type HubIntentApp = Pick<AppManifest, 'appId' | 'name' | 'tools'> & {
  description?: string
  keywords?: string[]
}

function extractKeywords(app: HubIntentApp): string[] {
  const list: string[] = [app.name]
  if (app.keywords && Array.isArray(app.keywords)) {
    list.push(...app.keywords)
  }
  for (const t of app.tools || []) {
    if (t.name) {
      list.push(t.name)
      // Extract core nouns from compound tool names like "创建并执行会话任务", "查看所有会话列表", "查询会话进度与详情"
      const cleaned = t.name.replace(/^(?:创建并执行|查看所有|查看|查询|获取|读取|发送|列出)/, '').trim()
      if (cleaned.length >= 2 && !list.includes(cleaned)) {
        list.push(cleaned)
      }
    }
  }
  // Extract distinct technical / English tokens (length >= 3) from description & appId & toolIds
  const corpus = `${app.appId || ''} ${app.description || ''} ${(app.tools || []).map(t => `${t.toolId || ''} ${t.description || ''}`).join(' ')}`
  const englishTokens = corpus.toLowerCase().match(/[a-z0-9_-]{3,}/g) || []
  for (const token of englishTokens) {
    if (!['and', 'the', 'for', 'with', 'from', 'all', 'true', 'false', 'type', 'object', 'string', 'number',
      'read', 'search', 'query', 'get', 'set', 'list', 'run', 'execute', 'create', 'update', 'delete', 'write',
      'open', 'close', 'stop', 'start', 'app', 'tool', 'tools', 'software', 'local', 'system', 'files'].includes(token) && !list.includes(token)) {
      list.push(token)
    }
  }
  return list
}

/** Attach capability discovery only when the request actually concerns local tools. */
export function shouldIncludeHubTools(content: string, apps: HubIntentApp[]): boolean {
  const text = content.trim()
  if (/^\/(?:hub|agent-hub)(?:\s|$)/i.test(text) ||
      /(?:调用|使用|通过|查一下|查看|运行|用)\s*hub\b/i.test(text) ||
      /\b(?:call|use)\s+hub\b/i.test(text)) {
    return true
  }
  if (!text || text.startsWith('/') || isAvatarAppearanceRequest(text)) return false
  const asksForAction = /(?:查看|看看|检查|查询|搜索|读取|调用|使用|运行|执行|列出|打开|启动|停止|进度|状态|怎么样|在忙什么|在做什么|在干什么|是做什么|是干什么|当前任务|目前任务|\b(?:check|query|search|read|use|run|list|open|start|stop|status|progress)\b|\bwhat\b.*\b(?:doing|working|running)\b)/i.test(text)
  const lower = text.toLowerCase()
  if (apps.some(app => app.appId && mentionsLabel(lower, app.appId))) return true
  if (apps.some(app => (app.tools || []).some(t => t.toolId && /[_-]/.test(t.toolId) && mentionsLabel(lower, t.toolId)))) return true
  if (!asksForAction) return false
  if (apps.some(app => extractKeywords(app).some(kw => mentionsLabel(lower, kw)))) return true
  return /(本地|这台电脑|我的电脑|已接入|\blocal\b|\bmy (?:pc|computer)\b)/i.test(text) &&
    /(工具|软件|应用|文件|下载|渲染|构建|编译|\b(?:tool|app|software|file|download|render|build)\b)/i.test(text)
}

export function selectHubIntentAppIds(content: string, apps: HubIntentApp[]): string[] {
  return apps.filter(app => shouldIncludeHubTools(content, [app])).map(app => app.appId)
}
