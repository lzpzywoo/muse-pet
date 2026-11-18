import type { ChatMessage } from '../../types'

type RecordValue = Record<string, unknown>
const record = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value)
const failure = /failed|failure|error|uncertain|unavailable|cancelled|denied|rejected|timeout|timed_out|失败|异常|未确认|不确定|未送达/i

/** Only inspect outer JSON values. Quoted braces, escapes and nested values are data. */
export function jsonSpans(text: string, firstOnly = false): Array<{ start: number; end: number; complete: boolean }> {
  const spans: Array<{ start: number; end: number; complete: boolean }> = []
  let start = -1
  let quote = ''
  let escaped = false
  const stack: string[] = []
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === quote) quote = ''
      continue
    }
    if (c === '"' || (!stack.length && (c === "'" || c === '`'))) {
      // Outside JSON, shield literal quoted examples, but not ordinary prose inch marks.
      if (stack.length || c === '`' || /^[ \t]*[\[{]/.test(text.slice(i + 1))) quote = c
      continue
    }
    if (c === '{' || c === '[') {
      if (!stack.length) start = i
      stack.push(c)
    } else if ((c === '}' || c === ']') && stack.length) {
      const open = stack.pop()
      if ((c === '}' && open !== '{') || (c === ']' && open !== '[')) {
        spans.push({ start, end: text.length, complete: false })
        return spans
      }
      if (!stack.length) {
        spans.push({ start, end: i + 1, complete: true })
        if (firstOnly) return spans
      }
    }
  }
  if (stack.length) spans.push({ start, end: text.length, complete: false })
  return spans
}

// Read only top-level string fields, also on truncated JSON. Never promote nested examples.
function fields(text: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null)
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      const start = i++
      for (; i < text.length; i++) {
        if (text[i] === '\\') i++
        else if (text[i] === '"') break
      }
      if (depth !== 1) continue
      const tail = text.slice(i + 1)
      const value = tail.match(/^\s*:\s*"((?:[^"\\]|\\.)*)(?:"|$)/)
      if (value) {
        try { result[JSON.parse(text.slice(start, i + 1))] = JSON.parse(`"${value[1]}"`) } catch { /* incomplete escape */ }
      }
    } else if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') depth--
  }
  return result
}

function protocol(value: unknown): boolean {
  if (!record(value)) return false
  if (value.action === 'local_tool') return true
  if (record(value.controller) && record(value.result) && (
    typeof value.controller.rootId === 'string' || Array.isArray(value.controller.nextTools) ||
    (value.result.truncated === true && typeof value.result.preview === 'string') || protocol(value.result)
  )) return true
  return typeof value.taskId === 'string' && typeof value.status === 'string' &&
    (typeof value.appId === 'string' || 'result' in value || 'error' in value)
}

function errorText(value: unknown): string {
  if (!record(value)) return ''
  const envelope = record(value.controller) && record(value.result) ? value.result : value
  if (!failure.test(String(envelope.status ?? '')) && !envelope.error) return ''
  const error = envelope.error
  const detail = typeof error === 'string' ? error : record(error) && typeof error.message === 'string' ? error.message : ''
  // A serialized report/body is never a user-facing error preview.
  return detail && !/[{}\[\]]|MUSE_LOCAL_|data:.*base64/i.test(detail)
    ? `本地工具执行异常：${detail.slice(0, 500)}` : '本地工具执行异常，请在 /hub 查看任务详情。'
}

function projectJson(text: string, hideCalls = true, holdIncomplete = false): string {
  let result = ''
  let cursor = 0
  for (const span of jsonSpans(text)) {
    const raw = text.slice(span.start, span.end)
    let value: unknown
    try { value = JSON.parse(raw) } catch { /* streaming or malformed */ }
    const prefix = fields(raw)
    const internal = (holdIncomplete && !span.complete && raw.startsWith('{')) ||
      (protocol(value) && (hideCalls || !record(value) || value.action !== 'local_tool')) || (value === undefined && (
      hideCalls && prefix.action === 'local_tool' ||
      (typeof prefix.taskId === 'string' && typeof prefix.status === 'string' && typeof prefix.appId === 'string') ||
      /^\{\s*"controller"\s*:\s*\{\s*"(?:rootId|revision|remainingSteps|deadline|nextTools)"\s*:/.test(raw)
    ))
    if (!internal) continue
    let before = text.slice(cursor, span.start)
    // Some DOM traces omit the backticks but retain the JSON language label.
    before = before.replace(/(?:^|\n)[ \t]*json[ \t]*\r?\n[ \t]*$/i, '')
    result += before + (errorText(value) || (!span.complete && failure.test(prefix.status || '') ? '本地工具执行异常，请在 /hub 查看任务详情。' : ''))
    cursor = span.end
  }
  return result + text.slice(cursor)
}

function projectPlain(text: string): { text: string; decorated: boolean } {
  let decorated = false
  // Markers must occupy a protocol line, never a prose substring or inline code example.
  const marker = /^[ \t]*\[(MUSE_LOCAL_TOOLS|MUSE_LOCAL_CONTEXT|MUSE_LOCAL_TOOL_RESULT)\][ \t]*(?=\r?$|\{|\[)/gm
  let output = ''
  let cursor = 0
  for (let match = marker.exec(text); match; match = marker.exec(text)) {
    if (match.index < cursor) continue
    // A marker inside a user code example is literal. Fences inside an actual
    // injected block are skipped as part of that block, rather than split out.
    const preceding = text.slice(cursor, match.index)
    if ((preceding.match(/^[ \t]*```/gm)?.length || 0) % 2) continue
    const closing = `[/${match[1]}]`
    const closingLine = new RegExp(`^[ \\t]*\\[/${match[1]}\\][ \\t]*\\r?$`, 'gm')
    closingLine.lastIndex = marker.lastIndex
    const line = closingLine.exec(text)
    // Prefer a real delimiter line over marker text embedded in JSON strings.
    let end = line ? text.indexOf(closing, line.index) : text.indexOf(closing, marker.lastIndex)
    if (match[1] === 'MUSE_LOCAL_TOOL_RESULT') {
      // Compact reports may precede another multiline report. Validate the
      // earlier JSON boundary so the later delimiter cannot consume narrative.
      for (let candidate = text.indexOf(closing, marker.lastIndex); candidate >= 0 && candidate < end; candidate = text.indexOf(closing, candidate + closing.length)) {
        try { JSON.parse(text.slice(marker.lastIndex, candidate)); end = candidate; break } catch { /* marker inside a JSON string */ }
      }
    }
    // An unpaired marker name in a user's question is not an injected block.
    if (end < 0 && match[1] !== 'MUSE_LOCAL_TOOL_RESULT') continue
    let bodyEnd = end < 0 ? text.length : end
    let body = text.slice(marker.lastIndex, bodyEnd)
    let consumeEnd = end < 0 ? text.length : end + closing.length
    if (end < 0 && match[1] === 'MUSE_LOCAL_TOOL_RESULT') {
      if (!/^\s*\{\s*(?:"(?:controller|taskId|appId|toolId|status)"\s*:|$)/.test(body)) continue
      const first = jsonSpans(body, true)[0]
      if (first?.complete && first.start === body.search(/\S/)) {
        bodyEnd = marker.lastIndex + first.end
        consumeEnd = bodyEnd
        body = text.slice(marker.lastIndex, bodyEnd)
      }
    }
    let error = ''
    if (match[1] === 'MUSE_LOCAL_TOOL_RESULT') {
      try { error = errorText(JSON.parse(body)) } catch {
        if (failure.test(fields(body).status || '')) error = '本地工具执行异常，请在 /hub 查看任务详情。'
      }
    }
    output += text.slice(cursor, match.index) + error
    cursor = consumeEnd
    decorated = true
  }
  output += text.slice(cursor)
  return { text: output, decorated }
}

function projectMarkupText(text: string, streaming: boolean, hideCalls: boolean, preserveFences: boolean): string {
  let output = ''
  let jsonFence = false
  for (let i = 0; i < text.length;) {
    if (text.startsWith('```', i)) {
      if (jsonFence) { output += '```'; i += 3; jsonFence = false; continue }
      const opening = !preserveFences && text.slice(i).match(/^```(?:json)?[ \t]*(?:\r?\n|(?=\{))/i)
      if (opening) { output += opening[0]; i += opening[0].length; jsonFence = true; continue }
      const closeLine = /^[ \t]*```[ \t]*\r?$/gm
      closeLine.lastIndex = i + 3
      const closing = closeLine.exec(text)
      const end = closing ? closing.index + closing[0].length : text.length
      output += text.slice(i, end)
      i = end
      continue
    }
    if (!jsonFence && text[i] === '`') {
      const ticks = text.slice(i).match(/^`+/)![0]
      const end = text.indexOf(ticks, i + ticks.length)
      output += text.slice(i, end < 0 ? text.length : end + ticks.length)
      i = end < 0 ? text.length : end + ticks.length
      continue
    }
    if ((text[i] === '"' || text[i] === "'") && /^[ \t]*[\[{]/.test(text.slice(i + 1))) {
      const quote = text[i]
      let end = i + 1
      for (; end < text.length; end++) {
        if (text[end] === '\\') end++
        else if (text[end] === quote) { end++; break }
      }
      output += text.slice(i, end); i = end; continue
    }
    if (text[i] === '{' || text[i] === '[') {
      const span = jsonSpans(text.slice(i), true)[0]
      if (span?.start === 0) {
        const raw = text.slice(i, i + span.end)
        const projected = projectJson(raw, hideCalls, streaming)
        if (projected !== raw) output = output.replace(/(?:^|\n)[ \t]*json[ \t]*\r?\n[ \t]*$/i, '')
        output += projected
        i += span.end
        continue
      }
    }
    output += text[i++]
  }
  output = output.replace(/```(?:json)?[ \t]*[\r\n \t]*```/gi, '')
  return jsonFence ? output.replace(/```(?:json)?[ \t]*[\r\n \t]*$/i, '') : output
}

/** Display only: never use this projection for execution, persistence or synchronization. */
export function projectChatMessage(message: Pick<ChatMessage, 'id' | 'role' | 'content' | 'status' | 'attachments' | 'browser' | 'pendingAction' | 'appliedPlugin'>): { text: string; visible: boolean } {
  const rolePrefix = message.role === 'user' ? /^(?:用户消息|用户|你|you|user|human)[:：][ \t]*/i
    : message.role === 'system' ? /^(?:系统消息|系统|system)[:：][ \t]*/i
    : /^(?:助手消息|助手|assistant|AI)[:：][ \t]*/i
  const source = message.content.replace(rolePrefix, '')
  let decorated = false
  // Keep ordinary fenced code verbatim, including protocol examples authored by users.
  const stripped = projectPlain(source)
  decorated = stripped.decorated
  let text = projectMarkupText(stripped.text, message.role === 'assistant' && message.status === 'streaming', message.role !== 'user', message.role === 'user').trim()
  if (message.role === 'assistant' && message.status === 'streaming' && /^(?:json\s*|```(?:json)?\s*)$/i.test(text)) text = ''
  if (decorated && message.role === 'user') text = text.replace(/^(?:用户消息|用户|你|you|user|human)[:：]\s*/i, '').trim()
  const delivery = message.id.startsWith('hub-result-') || (decorated && /^工具结果已/.test(text))
  if (delivery) {
    // Old local delivery notifications contain a human status line followed by the report.
    text = failure.test(text) ? text.split(/\r?\n/).filter(line => failure.test(line) && !/[{}\[\]]/.test(line)).join('\n') || '工具结果送达状态未确认，请在 /hub 查看详情。' : ''
  }
  if (!text && message.status === 'error') text = '操作失败，请重试或在 /hub 查看详情。'
  const controls = !!(message.attachments?.length || message.browser || message.pendingAction || message.appliedPlugin)
  return { text, visible: !!text || controls || message.status === 'error' || (!source && message.status === 'streaming') }
}
