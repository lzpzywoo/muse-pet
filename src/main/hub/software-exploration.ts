import { createHash } from 'node:crypto'
import type { AppManifest, SoftwareExplorationDescriptor, ToolDefinition } from './sdk-types'

export interface SoftwareExplorationPolicy extends SoftwareExplorationDescriptor {
  appId: string
  revision: string
  tools: ToolDefinition[]
}

function record(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function fail(message: string): never {
  throw new Error(`software exploration: ${message}`)
}

/** Accept provider-owned schemas without imposing a particular directory model. */
export function validateSoftwareExploration(manifest: AppManifest): void {
  const descriptor = manifest.exploration
  if (descriptor === undefined) return
  if (!record(descriptor) || descriptor.version !== 1) fail('unsupported or malformed descriptor version')
  const ids = [descriptor.overviewToolId, descriptor.discoverToolId, descriptor.readToolId]
  if (ids.some(id => typeof id !== 'string' || !id.trim()) || new Set(ids).size !== 3) {
    fail('endpoint IDs must be non-empty and distinct')
  }
  if (!Array.isArray(manifest.tools)) fail('endpoint tools are missing')
  for (const id of ids) {
    const matches = manifest.tools.filter(tool => tool?.toolId === id)
    if (matches.length !== 1) fail(`endpoint ${id} must identify one registered tool`)
    const tool = matches[0]
    if (tool.riskLevel !== 'read-only' || (tool.requiresApproval !== undefined && tool.requiresApproval !== false)) {
      fail(`endpoint ${id} must be read-only without required approval`)
    }
    if (!record(tool.inputSchema) || (tool.outputSchema !== undefined && !record(tool.outputSchema))) {
      fail(`endpoint ${id} needs object schemas`)
    }
  }
}

/** Canonical JSON also rejects cycles, non-JSON values and excessive nesting. */
function canonical(value: unknown, depth = 0, ancestors = new Set<object>(), budget = { nodes: 0 }): string {
  if (++budget.nodes > 20000 || depth > 32) fail('JSON structure exceeds limits')
  if (typeof value === 'string' && value.length > 256000) fail('JSON string exceeds limits')
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (typeof value !== 'object' || value === null || ancestors.has(value)) fail('expected finite JSON data')
  ancestors.add(value)
  let result: string
  if (Array.isArray(value)) {
    result = `[${value.map(item => canonical(item, depth + 1, ancestors, budget)).join(',')}]`
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail('expected JSON object')
    result = `{${Object.keys(value).sort().map(key => {
      if (key.length > 2048) fail('JSON key exceeds limits')
      return `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], depth + 1, ancestors, budget)}`
    }).join(',')}}`
  }
  ancestors.delete(value)
  if (result.length > 256000) fail('JSON payload exceeds limits')
  return result
}

/** Revalidate on every lookup: callers may retain and mutate registered manifests. */
export function getSoftwareExplorationPolicy(manifest: AppManifest): SoftwareExplorationPolicy | undefined {
  validateSoftwareExploration(manifest)
  if (!manifest.exploration) return undefined
  const { version, overviewToolId, discoverToolId, readToolId } = manifest.exploration
  const descriptor = { version, overviewToolId, discoverToolId, readToolId }
  const tools = [overviewToolId, discoverToolId, readToolId].map(id => {
    const tool = manifest.tools.find(item => item.toolId === id)!
    // Explicit fields prevent runtime-only manifest credentials from leaking into policy.
    return {
      toolId: tool.toolId, name: tool.name, description: tool.description,
      category: tool.category, riskLevel: tool.riskLevel, inputSchema: tool.inputSchema,
      ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
      ...(tool.requiresApproval === undefined ? {} : { requiresApproval: tool.requiresApproval }),
    }
  })
  const clonedTools: ToolDefinition[] = JSON.parse(canonical(tools))
  const revision = createHash('sha256').update(canonical({ appVersion: manifest.version ?? '', descriptor, tools: clonedTools })).digest('hex')
  return { appId: manifest.appId, revision, ...descriptor, tools: clonedTools }
}

function boundedString(value: unknown, max: number, field: string, nonempty = true): void {
  if (typeof value !== 'string' || value.length > max || (nonempty && !value.trim())) fail(`invalid ${field}`)
}

function validIso(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 64) return false
  const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value)
  if (!match || !Number.isFinite(Date.parse(value))) return false
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3])
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
}

/** Throws on invalid envelopes; availability statuses remain explicit for the loop. */
export function validateSoftwareResponse(toolId: string, policy: SoftwareExplorationPolicy, value: unknown): void {
  const kind = toolId === policy.overviewToolId ? 'overview'
    : toolId === policy.discoverToolId ? 'directory'
      : toolId === policy.readToolId ? 'resource' : undefined
  if (!kind) fail('tool is not a declared endpoint')
  if (!record(value) || value.protocol !== 'muse-software/1' || value.kind !== kind) fail('invalid response protocol or kind')
  if (!['ok', 'unsupported', 'unavailable'].includes(value.status)) fail('invalid response status')
  if (!record(value.source) || !['live', 'documentation', 'cache'].includes(value.source.kind)) fail('invalid source')
  boundedString(value.source.id, 2048, 'source.id')
  if (!validIso(value.observedAt)) fail('observedAt must be a valid ISO timestamp')
  if (value.status === 'ok' && (!Object.prototype.hasOwnProperty.call(value, 'data') || value.data === undefined)) fail('ok requires data')
  if (value.references !== undefined) {
    if (!Array.isArray(value.references) || value.references.length > 30) fail('references must contain at most 30 entries')
    for (const ref of value.references) {
      if (!record(ref) || !['guide', 'collection', 'entity', 'query'].includes(ref.kind)) fail('invalid reference')
      boundedString(ref.ref, 2048, 'reference.ref')
      boundedString(ref.title, 512, 'reference.title')
      if (ref.description !== undefined) boundedString(ref.description, 4000, 'reference.description', false)
      if (ref.inputSchema !== undefined && !record(ref.inputSchema)) fail('reference.inputSchema must be an object')
    }
  }
  if (value.nextCursor !== undefined && value.nextCursor !== null) boundedString(value.nextCursor, 2048, 'nextCursor', false)
  if (Buffer.byteLength(canonical(value), 'utf8') > 256000) fail('response exceeds 256000 bytes')
}
