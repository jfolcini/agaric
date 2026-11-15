/**
 * Compile parsed search syntax to the `FilterExpr` the engines run: one AND
 * run's conditions as search adds them, and an OR tree of them (#6742). Shared
 * by a query block's text (`query-text.ts`) and the search box's `filter_expr`,
 * and kept free of the editor's imports, which would follow the search box
 * into the entry chunk.
 */

import type {
  DatePredicate,
  FilterExpr,
  FilterPrimitive,
  PropertyPredicate,
  PropertyValue,
} from '@/lib/bindings'
import { prepareGlobs } from '@/lib/search-query/glob-validate'
import { isIsoDate } from '@/lib/search-query/is-iso-date'
import { resolveNamedDate } from '@/lib/search-query/resolve-date'
import type {
  DateFilterValue,
  FilterNode,
  FilterToken,
  SearchQueryAST,
} from '@/lib/search-query/types'

/** `infer_property_value` (Rust): a finite number, else an ISO date, else text, as the search box types a value. */
function inferPropertyValue(raw: string): PropertyValue {
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)) {
    const value = Number(raw)
    if (Number.isFinite(value)) return { type: 'Num', value }
  }
  if (isIsoDate(raw)) return { type: 'Date', value: raw }
  return { type: 'Text', value: raw }
}

/** `resolve_date_filter` + `meta_date_to_primitive` (Rust): a date token as search runs it on `today`. */
function datePredicate(value: DateFilterValue, today: Date): DatePredicate | null {
  if (value.kind === 'named') return resolveNamedDate(value.name, today)
  const { date } = value
  switch (value.op) {
    case '<': {
      return { type: 'Before', date }
    }
    case '<=': {
      return { type: 'OnOrBefore', date }
    }
    case '=': {
      return { type: 'On', date }
    }
    case '>=': {
      return { type: 'OnOrAfter', date }
    }
    case '>': {
      return { type: 'After', date }
    }
  }
}

/**
 * A `path:` / `not-path:` token as the prepared patterns search binds
 * (`prepare_globs`): the engine binds a `PathGlob` pattern as it stands.
 */
export function pathPatterns(token: FilterToken): string[] {
  return token.kind === 'pathInclude' || token.kind === 'pathExclude'
    ? prepareGlobs([token.value])
    : []
}

/** One `State` / `Priority` leaf over `values`, `none` as the null bucket, as search builds it. */
function membership(
  type: 'State' | 'Priority',
  values: string[],
  exclude: boolean,
): FilterPrimitive | null {
  const named = [...new Set(values.filter((v) => v.toLowerCase() !== 'none'))]
  const isNull = values.some((v) => v.toLowerCase() === 'none')
  if (named.length === 0 && !isNull) return null
  return { type, values: named, is_null: isNull, exclude }
}

type MembershipKind = 'state' | 'notState' | 'priority' | 'notPriority'

function valuesOf(filters: FilterToken[], kind: MembershipKind): string[] {
  return filters
    .filter((f): f is Extract<FilterToken, { kind: MembershipKind }> => f.kind === kind)
    .map((f) => f.value)
}

function propertyLeaf(key: string, value: string, exclude: boolean): FilterPrimitive {
  let predicate: PropertyPredicate
  if (value === '') predicate = { type: exclude ? 'NotExists' : 'Exists' }
  else predicate = { type: exclude ? 'Ne' : 'Eq', value: inferPropertyValue(value) }
  return { type: 'HasProperty', key: key.trim(), predicate }
}

export const leafOf = (primitive: FilterPrimitive): FilterExpr => ({ type: 'Leaf', primitive })

/** The conditions of a text whose every token can run, in the order search adds them. */
export function conditions(
  filters: FilterToken[],
  tagIds: string[],
  type: 'Tag' | 'TagUnder',
  today: Date,
): FilterExpr[] {
  const out: FilterExpr[] = [...new Set(tagIds)].map((tag) => leafOf({ type, tag }))
  // Search ORs the page names to keep and drops a block on any name to leave out.
  const keep = filters
    .filter((f) => f.kind === 'pathInclude')
    .flatMap(pathPatterns)
    .map((pattern) => leafOf({ type: 'PathGlob', pattern, exclude: false }))
  if (keep.length === 1) out.push(...keep)
  else if (keep.length > 1) out.push({ type: 'Or', children: keep })
  for (const pattern of filters.filter((f) => f.kind === 'pathExclude').flatMap(pathPatterns)) {
    out.push(leafOf({ type: 'PathGlob', pattern, exclude: true }))
  }
  for (const primitive of [
    membership('State', valuesOf(filters, 'state'), false),
    membership('State', valuesOf(filters, 'notState'), true),
    membership('Priority', valuesOf(filters, 'priority'), false),
    membership('Priority', valuesOf(filters, 'notPriority'), true),
  ]) {
    if (primitive) out.push(leafOf(primitive))
  }
  for (const f of filters) {
    if (f.kind === 'prop' || f.kind === 'notProp') {
      out.push(leafOf(propertyLeaf(f.key, f.value, f.kind === 'notProp')))
    }
  }
  for (const f of filters) {
    // `parse` leaves one valid `due:` and one `scheduled:` at most.
    const predicate =
      f.kind === 'due' || f.kind === 'scheduled' ? datePredicate(f.value, today) : null
    if (predicate) out.push(leafOf({ type: f.kind === 'due' ? 'DueDate' : 'Scheduled', predicate }))
  }
  return out
}

/** The condition a `tag:` / `under:` token names, or `null` when no tag holds its name. */
export type TagCondition = (
  token: Extract<FilterToken, { kind: 'tag' | 'under' }>,
) => FilterExpr | null

/** One AND run's conditions: its tags, then the rest in the order search adds them. */
function runConditions(
  tokens: FilterToken[],
  tagCondition: TagCondition,
  today: Date,
): FilterExpr[] {
  const tags: FilterExpr[] = []
  for (const token of tokens) {
    if (token.kind !== 'tag' && token.kind !== 'under') continue
    const condition = tagCondition(token)
    if (condition && !tags.some((tag) => canonical(tag) === canonical(condition))) {
      tags.push(condition)
    }
  }
  return [...tags, ...conditions(tokens, [], 'Tag', today)]
}

function compileNode(
  ast: SearchQueryAST,
  node: FilterNode,
  tagCondition: TagCondition,
  today: Date,
): FilterExpr | null {
  if (node.kind === 'token') {
    const token = ast.filters[node.index]
    const run = token ? runConditions([token], tagCondition, today) : []
    if (run.length === 0) return null
    return run.length === 1 ? (run[0] as FilterExpr) : { type: 'And', children: run }
  }
  const groups = node.children.flatMap((child) => {
    if (node.kind === 'and' && child.kind === 'token') return []
    return compileNode(ast, child, tagCondition, today) ?? []
  })
  if (node.kind === 'or') return { type: 'Or', children: groups }
  const tokens = node.children.flatMap((child) =>
    child.kind === 'token' ? (ast.filters[child.index] ?? []) : [],
  )
  return { type: 'And', children: [...runConditions(tokens, tagCondition, today), ...groups] }
}

/**
 * The `FilterExpr` of a query whose filters have an OR tree (`ast.expr`): each
 * AND run compiled as a flat query's filters are, joined by the tree's `And`
 * and `Or` nodes. An invalid token compiles to nothing.
 */
export function compileFilterTree(
  ast: SearchQueryAST & { expr: FilterNode },
  tagCondition: TagCondition,
  today: Date = new Date(),
): FilterExpr {
  return compileNode(ast, ast.expr, tagCondition, today) ?? { type: 'And', children: [] }
}

/** A value with its object keys in one order, so two leaves compare whatever built them. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).toSorted(([a], [b]) => a.localeCompare(b)))
      : v,
  )
}
