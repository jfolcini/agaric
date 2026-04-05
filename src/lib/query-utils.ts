import type { BacklinkFilter } from './tauri'

/** Parsed property filter from shorthand syntax (property:key=value). */
export interface PropertyFilter {
  key: string
  value: string
}

/** Parse a query expression string into structured params.
 *
 * Supports both the legacy explicit-type syntax and the new shorthand:
 * - Legacy: `type:tag expr:project` or `type:property key:X value:Y`
 * - Shorthand: `property:key=value` and `tag:prefix`
 *
 * Multiple shorthand tokens are collected and produce a `'filtered'` type
 * with AND semantics.
 */
export function parseQueryExpression(expr: string): {
  type: 'tag' | 'property' | 'backlinks' | 'filtered' | 'unknown'
  params: Record<string, string>
  propertyFilters: PropertyFilter[]
  tagFilters: string[]
} {
  const parts = expr.trim().split(/\s+/)
  const params: Record<string, string> = {}
  const propertyFilters: PropertyFilter[] = []
  const tagFilters: string[] = []

  for (const part of parts) {
    const colonIdx = part.indexOf(':')
    if (colonIdx > 0) {
      const prefix = part.slice(0, colonIdx)
      const rest = part.slice(colonIdx + 1)

      if (prefix === 'property' && rest.includes('=')) {
        // Shorthand: property:key=value
        const eqIdx = rest.indexOf('=')
        propertyFilters.push({ key: rest.slice(0, eqIdx), value: rest.slice(eqIdx + 1) })
      } else if (prefix === 'tag' && rest !== '') {
        // Shorthand: tag:prefix
        tagFilters.push(rest)
      } else {
        params[prefix] = rest
      }
    }
  }

  // If shorthand filters were found, treat as a 'filtered' query
  if (propertyFilters.length > 0 || tagFilters.length > 0) {
    return { type: 'filtered', params, propertyFilters, tagFilters }
  }

  const explicitType = params.type as 'tag' | 'property' | 'backlinks' | undefined
  return { type: explicitType ?? 'unknown', params, propertyFilters, tagFilters }
}

/** Build BacklinkFilter objects from parsed shorthand filters.
 *
 * Maps known fixed-field keys (todo_state, priority, due_date) to their
 * specialised filter variants, and falls back to PropertyText for custom
 * property keys.  Tag filters become HasTagPrefix filters.
 */
export function buildFilters(
  propertyFilters: PropertyFilter[],
  tagFilters: string[],
): BacklinkFilter[] {
  const filters: BacklinkFilter[] = []

  for (const pf of propertyFilters) {
    if (pf.key === 'todo_state') {
      filters.push({ type: 'TodoState', state: pf.value })
    } else if (pf.key === 'priority') {
      filters.push({ type: 'Priority', level: pf.value })
    } else if (pf.key === 'due_date') {
      filters.push({ type: 'DueDate', op: 'Eq', value: pf.value })
    } else {
      filters.push({ type: 'PropertyText', key: pf.key, op: 'Eq', value: pf.value })
    }
  }

  for (const tf of tagFilters) {
    filters.push({ type: 'HasTagPrefix', prefix: tf })
  }

  return filters
}
