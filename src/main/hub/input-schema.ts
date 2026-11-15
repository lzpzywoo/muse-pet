/** Bounded validation of the common JSON Schema keywords used by Hub tools. */
export function validateToolParameters(parameters: unknown, schema: Record<string, any>): void {
  const record = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v)
  if (!record(parameters)) throw new Error('parameters must be an object')
  const check = (value: any, rule: any, field: string, depth: number) => {
    if (depth > 32) throw new Error('input schema nesting exceeds limit')
    if (rule === false) throw new Error(`${field} is not allowed`)
    if (!record(rule)) return
    const matches = (type: string) => type === 'object' ? record(value)
      : type === 'array' ? Array.isArray(value)
      : type === 'null' ? value === null
      : type === 'integer' ? Number.isInteger(value)
      : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
      : typeof value === type
    if (rule.type && !(Array.isArray(rule.type) ? rule.type : [rule.type]).some(matches)) throw new Error(`${field} has invalid type`)
    if (Array.isArray(rule.enum) && !rule.enum.some((v: any) => JSON.stringify(v) === JSON.stringify(value))) throw new Error(`${field} is outside enum`)
    if ('const' in rule && JSON.stringify(rule.const) !== JSON.stringify(value)) throw new Error(`${field} must match const`)
    if (record(value)) {
      for (const key of rule.required ?? []) if (!Object.hasOwn(value, key)) throw new Error(`${field}.${key} is required`)
      for (const [key, child] of Object.entries(value)) {
        if (record(rule.properties) && Object.hasOwn(rule.properties, key)) check(child, rule.properties[key], `${field}.${key}`, depth + 1)
        else if (rule.additionalProperties === false) throw new Error(`${field}.${key} is not allowed`)
        else if (record(rule.additionalProperties)) check(child, rule.additionalProperties, `${field}.${key}`, depth + 1)
      }
    }
    if (Array.isArray(value)) {
      if (rule.minItems !== undefined && value.length < rule.minItems || rule.maxItems !== undefined && value.length > rule.maxItems) throw new Error(`${field} has invalid length`)
      value.forEach((v, i) => check(v, rule.items, `${field}[${i}]`, depth + 1))
    }
    if (typeof value === 'string') {
      if (rule.minLength !== undefined && value.length < rule.minLength || rule.maxLength !== undefined && value.length > rule.maxLength) throw new Error(`${field} has invalid length`)
    }
    if (typeof value === 'number') {
      if (rule.minimum !== undefined && value < rule.minimum || rule.maximum !== undefined && value > rule.maximum) throw new Error(`${field} is outside bounds`)
    }
  }
  check(parameters, schema, 'parameters', 0)
}
