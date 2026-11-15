import { useId, useRef, useState } from 'react'
import type { MuseHubToolInfo } from '../../types'

export function parseHubParameters(text: string): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error('请输入有效的 JSON 对象。') }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('参数必须是 JSON 对象，不能是数组、null 或基本值。')
  }
  return value as Record<string, unknown>
}

// Bound both traversal and individual values before serialization (including screenshot base64).
export function formatHubResult(value: unknown): string {
  let remaining = 100
  const seen = new WeakSet<object>()
  const preview = (item: unknown, depth: number): unknown => {
    if (--remaining < 0) return '[更多内容已省略]'
    if (typeof item === 'string') {
      if (/^(?:data:image\/|[A-Za-z0-9+/]{256})/.test(item)) return '[图像或编码数据已省略]'
      return item.length > 600 ? `${item.slice(0, 600)}… [已截断]` : item
    }
    if (!item || typeof item !== 'object') return item
    if (seen.has(item)) return '[循环引用]'
    if (depth >= 4) return '[嵌套内容已省略]'
    seen.add(item)
    if (Array.isArray(item)) return item.slice(0, 20).map((entry) => preview(entry, depth + 1)).concat(item.length > 20 ? ['[更多项已省略]'] : [])
    const result: Record<string, unknown> = Object.create(null)
    let count = 0
    for (const key in item) {
      if (!Object.prototype.hasOwnProperty.call(item, key)) continue
      if (++count > 20 || remaining <= 0) { result['…'] = '[更多字段已省略]'; break }
      result[key.slice(0, 100)] = preview((item as Record<string, unknown>)[key], depth + 1)
    }
    return result
  }
  try {
    const bounded = preview(value, 0)
    const text = typeof bounded === 'string' ? bounded : JSON.stringify(bounded, null, 2) ?? String(bounded)
    return text.length > 6000 ? `${text.slice(0, 6000)}\n… [已截断]` : text
  } catch { return '结果无法预览。' }
}

export function HubResultPreview({ value }: { value: unknown }) {
  return <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all text-[11px] text-slate-200">{formatHubResult(value)}</pre>
}

export default function HubToolInvocation({ appId, tool, online, refresh }: {
  appId: string
  tool: MuseHubToolInfo
  online: boolean
  refresh: () => Promise<void>
}) {
  const id = useId()
  const editor = useRef<HTMLTextAreaElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [text, setText] = useState('{}')
  const [edited, setEdited] = useState(false)
  const [error, setError] = useState('')
  const [failure, setFailure] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [response, setResponse] = useState<{ taskId?: string; status?: string; result?: unknown } | null>(null)
  const required = Array.isArray(tool.inputSchema?.required) ? tool.inputSchema.required.filter((key): key is string => typeof key === 'string') : []
  const validate = () => {
    try { return parseHubParameters(text) } catch (err) {
      setError((err as Error).message)
      return null
    }
  }
  return <div className="space-y-2">
    <button type="button" aria-expanded={expanded} aria-controls={`${id}-form`} onClick={() => setExpanded(!expanded)} className="liquid-glass-pill min-h-8 px-3 rounded text-sky-200">{expanded ? '收起参数' : '调用'}</button>
    {expanded && <form id={`${id}-form`} className="space-y-2" onSubmit={async (event) => {
      event.preventDefault()
      if (submitting || !online) return
      const parameters = validate()
      if (!parameters) { editor.current?.focus(); return }
      setSubmitting(true)
      setFailure('')
      setResponse(null)
      try {
        const res = await window.chatApi?.runHubTool(appId, tool.toolId, parameters)
        if (res) setResponse(res)
        if (!res?.ok) setFailure(res?.error || '调用失败：Hub 不可用。')
      } catch (err) { setFailure(err instanceof Error ? err.message : '调用失败。') }
      finally { setSubmitting(false); await refresh() }
    }}>
      <label htmlFor={`${id}-parameters`} className="block text-slate-200">调用参数（JSON 对象） · {tool.name}</label>
      <p id={`${id}-help`} className="text-slate-400">{tool.description} 必填字段：{required.length ? required.join('、') : '未声明'}。提交或编辑后离开输入框时验证 JSON 对象。</p>
      {tool.inputSchema && <details className="text-slate-400"><summary className="cursor-pointer">参数 Schema</summary><HubResultPreview value={tool.inputSchema} /></details>}
      <textarea ref={editor} id={`${id}-parameters`} value={text} rows={5} spellCheck={false} aria-invalid={Boolean(error)} aria-describedby={`${id}-help${error ? ` ${id}-error` : ''}`} onChange={(event) => { setText(event.target.value); setEdited(true); setError('') }} onBlur={() => { if (edited) validate() }} className="w-full rounded border border-slate-600 bg-black/40 p-2 font-terminal text-xs text-slate-100 focus:border-sky-400 focus:outline-none" />
      {error && <p id={`${id}-error`} role="alert" className="text-rose-300">{error}</p>}
      <button type="submit" disabled={!online || submitting} className="liquid-glass-pill min-h-8 px-3 rounded text-sky-200 disabled:opacity-40">{submitting ? '提交中…' : '调用工具'}</button>
      <div role="status" aria-live="polite">
        {failure && <p className="text-rose-300">{failure}</p>}
        {response && <div className="text-slate-300">任务：{response.taskId || '未返回任务 ID'} · {response.status || '已返回'}{response.result !== undefined && <HubResultPreview value={response.result} />}</div>}
      </div>
    </form>}
  </div>
}
