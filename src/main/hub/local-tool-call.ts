import type { LocalToolCall } from './sdk-types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validate(value: unknown): LocalToolCall | null {
  if (!isRecord(value) || value.action !== 'local_tool') return null
  if (typeof value.appId !== 'string' || !/^[a-z0-9._-]{3,80}$/i.test(value.appId)) return null
  if (typeof value.toolId !== 'string' || !/^[a-z0-9._-]{2,60}$/i.test(value.toolId)) return null
  if ('parameters' in value && !isRecord(value.parameters)) return null
  return {
    action: 'local_tool',
    appId: value.appId,
    toolId: value.toolId,
    parameters: value.parameters as Record<string, unknown> | undefined ?? {},
  }
}

/**
 * Read complete outer JSON values, respecting quoted braces and escapes.
 * Only a top-level instruction is executable; examples nested in other JSON
 * are data. Returning once preserves one invocation per assistant response.
 */
export function extractLocalToolCall(text: string): LocalToolCall | null {
  const fences = text.matchAll(/```(?:json)?[^\S\r\n]*\r?\n([\s\S]*?)\r?\n```/gi)
  for (const fence of fences) {
    const call = scanJsonValues(fence[1])
    if (call) return call
  }
  return scanJsonValues(text)
}

function scanJsonValues(text: string): LocalToolCall | null {
  let start = -1
  const stack: string[] = []
  let quoted = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') {
      // Prose inch marks are not JSON strings. Outside a container, only
      // shield a quoted JSON container; escaped embedded JSON stays data.
      quoted = stack.length > 0 || /^[ \t]*[\[{]/.test(text.slice(i + 1))
      continue
    }
    if (char === '{' || char === '[') {
      if (stack.length === 0) start = i
      stack.push(char)
      continue
    }
    if ((char === '}' || char === ']') && stack.length > 0) {
      const opening = stack.pop()
      if ((char === '}' && opening !== '{') || (char === ']' && opening !== '[')) {
        // A mismatched container is not a source of executable nested values.
        return null
      }
      if (stack.length === 0) {
        try {
          const call = validate(JSON.parse(text.slice(start, i + 1)))
          if (call) return call
        } catch {
          // A later independent JSON value may still carry the instruction.
        }
        start = -1
      }
    }
  }
  return null
}
