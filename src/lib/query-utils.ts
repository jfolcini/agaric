import type { BacklinkFilter, CompareOp } from './tauri'

/** Parsed property filter from shorthand syntax (property:key=value). */
export interface PropertyFilter {
  key: string
  value: string
  operator?: 'eq' | 'neq' | 'lt' | 'gt' | 'lte' | 'gte' | undefined // default: 'eq'
}

/** Map operator symbol to PropertyFilter operator name. */
const OPERATOR_MAP: Record<string, PropertyFilter['operator']> = {
  '>=': 'gte',
  '<=': 'lte',
  '!=': 'neq',
  '>': 'gt',
  '<': 'lt',
  '=': 'eq',
}

/** Map PropertyFilter operator name to display symbol. */
export const OPERATOR_SYMBOLS: Record<string, string> = {
  eq: '=',
  neq: '≠',
  lt: '<',
  gt: '>',
  lte: '≤',
  gte: '≥',
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
  // The markdown serializer escapes parser-significant characters (`\`,
  // `*`, `` ` ``, `~`, `=`, `[`, `]`, `#[`) in block content. Round-tripped
  // `{{query ...}}` blocks therefore arrive here with escaped `=`, which
  // breaks property-shorthand parsing (`property:key=value`). Unescape the
  // common single-char escapes before tokenising (TEST-1f).
  const unescaped = expr.replace(/\\([\\*`~=[\]#])/g, '$1')
  const parts = unescaped.trim().split(/\s+/)
  const params: Record<string, string> = {}
  const propertyFilters: PropertyFilter[] = []
  const tagFilters: string[] = []

  for (const part of parts) {
    const colonIdx = part.indexOf(':')
    if (colonIdx > 0) {
      const prefix = part.slice(0, colonIdx)
      const rest = part.slice(colonIdx + 1)

      if (prefix === 'property' && /[><=!]/.test(rest)) {
        // Shorthand: property:key{op}value  (>=, <=, != matched before >, <, =)
        const opMatch = rest.match(/^(\w+)(>=|<=|!=|>|<|=)(.+)$/)
        if (opMatch) {
          propertyFilters.push({
            key: opMatch[1] as string,
            value: opMatch[3] as string,
            operator: OPERATOR_MAP[opMatch[2] as string],
          })
        }
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

  const explicitType = params['type'] as 'tag' | 'property' | 'backlinks' | undefined
  return { type: explicitType ?? 'unknown', params, propertyFilters, tagFilters }
}

/** Map PropertyFilter operator to Rust CompareOp variant. */
function toCompareOp(op: PropertyFilter['operator']): CompareOp {
  switch (op) {
    case 'neq':
      return 'Neq'
    case 'lt':
      return 'Lt'
    case 'gt':
      return 'Gt'
    case 'lte':
      return 'Lte'
    case 'gte':
      return 'Gte'
    default:
      return 'Eq'
  }
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
    const op = toCompareOp(pf.operator)
    if (pf.key === 'todo_state') {
      filters.push({ type: 'TodoState', state: pf.value })
    } else if (pf.key === 'priority') {
      filters.push({ type: 'Priority', level: pf.value })
    } else if (pf.key === 'due_date') {
      filters.push({ type: 'DueDate', op, value: pf.value })
    } else {
      filters.push({ type: 'PropertyText', key: pf.key, op, value: pf.value })
    }
  }

  for (const tf of tagFilters) {
    filters.push({ type: 'HasTagPrefix', prefix: tf })
  }

  return filters
}
