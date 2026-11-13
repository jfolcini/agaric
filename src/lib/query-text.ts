/**
 * A query block's text in the search box's syntax (#6628).
 *
 * After `{{query ` a block holds a structured `v2:` payload
 * (`inline-query-spec.ts`), the older query text (`parseQueryExpression`), or
 * the search syntax: read by the search box's own parser (`@/lib/search-query`)
 * and compiled here to the `FilterExpr` the query engine runs.
 *
 * The two texts share `tag:` and disagree on it. The older text's `tag:work`
 * is every tag whose name starts with `work`, attached or written inline, its
 * repeats OR'd; the search syntax's is the tag named `work`, attached, its
 * repeats AND'd. {@link isLegacyQueryText} therefore reads a block as the older
 * text when it uses a key only that text has, or its only keyed words are `tag:`
 * words without `#` (the older text skips a word with no key), which is every
 * such block stored before the search syntax was accepted, so none of them
 * changes its results. The older text is frozen:
 * read, never extended.
 *
 * `table:` and `columns:` are the view words both texts carry
 * (`readQueryColumns`); the reader blanks them, so the search box never
 * registers them.
 */

import { ULID_RE } from '@/editor/markdown-common'
import { isEscapableChar } from '@/editor/markdown-parse/parser'
import type {
  DatePredicate,
  FilterExpr,
  FilterPrimitive,
  PropertyPredicate,
  PropertyValue,
} from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { type FilterToken, parse, type SearchQueryAST, tokenize } from '@/lib/search-query'
import type { DateFilterValue } from '@/lib/search-query'
import { isIsoDate } from '@/lib/search-query/is-iso-date'

/** The keys only the older query text reads (`parseQueryExpression` and its resolver). */
const LEGACY_ONLY_KEYS: ReadonlySet<string> = new Set([
  'property',
  'type',
  'expr',
  'key',
  'value',
  'target',
  'operator',
  'date',
])

const VIEW_WORD = /^(?:table|columns):/

/** The text as the editor shows it: the block's Markdown escapes decoded, as its parser decodes them. */
export function unescapeQueryText(text: string): string {
  return text.replace(/\\([\s\S])/g, (escape, ch: string) => (isEscapableChar(ch) ? ch : escape))
}

/** `word`'s key, the text before its first `:`, as the older text splits it. */
function wordKey(word: string): string {
  const colon = word.indexOf(':')
  return colon > 0 ? word.slice(0, colon) : ''
}

/** Whether a block's query text (not a `v2:` payload) is the older query text rather than the search syntax. */
export function isLegacyQueryText(expression: string): boolean {
  const words = unescapeQueryText(expression)
    .split(/\s+/)
    .filter((word) => word !== '' && !VIEW_WORD.test(word))
  if (words.some((word) => LEGACY_ONLY_KEYS.has(wordKey(word)))) return true
  // The older text skips a word without a key, so such words do not decide.
  const keyed = words.filter((word) => wordKey(word) !== '')
  return keyed.length > 0 && keyed.every((w) => w.startsWith('tag:') && !w.startsWith('tag:#'))
}

/** The search-syntax reading of a block's query text, and the text it was read from (for token spans). */
export function readQueryText(expression: string): { ast: SearchQueryAST; source: string } {
  let source = unescapeQueryText(expression)
  // Blanked, not cut: every token keeps its column.
  for (const token of tokenize(source)) {
    if (token.kind !== 'word' || !VIEW_WORD.test(token.text)) continue
    const [start, end] = token.span
    source = source.slice(0, start) + ' '.repeat(end - start) + source.slice(end)
  }
  return { ast: parse(source), source }
}

/** A token the block cannot run, with the 1-based column it starts at. */
export interface QueryTextProblem {
  token: string
  column: number
  message: string
}

/** The filter to run, or why not: the tokens the block cannot run, none when it holds no filter at all. */
export type CompiledQueryText =
  | { ok: true; filter: FilterExpr }
  | { ok: false; problems: QueryTextProblem[] }

export interface QueryTextDeps {
  /** The active space's tags, listed only when the text names one. */
  listTags: () => Promise<ReadonlyArray<{ tag_id: string; name: string }>>
}

/** A tag chip's id: a `#name` typed in the block is stored as `#[ULID]`, which reads as the tag `[ULID]`. */
export function chipTagId(value: string): string | null {
  const inner = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : ''
  return ULID_RE.test(inner) ? inner : null
}

/** `infer_property_value` (Rust): a finite number, else an ISO date, else text, as the search box types a value. */
function inferPropertyValue(raw: string): PropertyValue {
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)) {
    const value = Number(raw)
    if (Number.isFinite(value)) return { type: 'Num', value }
  }
  if (isIsoDate(raw)) return { type: 'Date', value: raw }
  return { type: 'Text', value: raw }
}

/** `meta_date_to_primitive` (Rust) over a date token; `null` for a relative bucket a query block cannot run yet. */
function datePredicate(value: DateFilterValue): DatePredicate | null {
  if (value.kind === 'named') return value.name === 'none' ? { type: 'IsNull' } : null
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

/** Why `token` cannot run in a query block, or `null` when it can. */
function tokenProblem(token: FilterToken): string | null {
  switch (token.kind) {
    case 'invalid': {
      return token.error
    }
    case 'under':
    case 'pathInclude':
    case 'pathExclude': {
      return t('query.text.cannotRun')
    }
    case 'due':
    case 'scheduled': {
      return datePredicate(token.value) ? null : t('query.text.relativeDate')
    }
    default: {
      return null
    }
  }
}

/** The free text's first word: free text is the source left over once every filter's span is out. */
function freeTextColumn(source: string, ast: SearchQueryAST): number {
  const filterStarts = new Set(ast.filters.map((f) => f.span[0]))
  const first = tokenize(source).find((tok) => !filterStarts.has(tok.span[0]))
  return (first?.span[0] ?? 0) + 1
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

/** The leaves of a text whose every token can run, in the order search adds them. */
function leaves(filters: FilterToken[], tagIds: string[]): FilterPrimitive[] {
  const out: FilterPrimitive[] = [...new Set(tagIds)].map((tag) => ({ type: 'Tag', tag }))
  for (const leaf of [
    membership('State', valuesOf(filters, 'state'), false),
    membership('State', valuesOf(filters, 'notState'), true),
    membership('Priority', valuesOf(filters, 'priority'), false),
    membership('Priority', valuesOf(filters, 'notPriority'), true),
  ]) {
    if (leaf) out.push(leaf)
  }
  for (const f of filters) {
    if (f.kind === 'prop' || f.kind === 'notProp') {
      out.push(propertyLeaf(f.key, f.value, f.kind === 'notProp'))
    }
  }
  for (const f of filters) {
    // `parse` leaves one valid `due:` and one `scheduled:` at most.
    const predicate = f.kind === 'due' || f.kind === 'scheduled' ? datePredicate(f.value) : null
    if (predicate) out.push({ type: f.kind === 'due' ? 'DueDate' : 'Scheduled', predicate })
  }
  return out
}

/**
 * Compile a block's search-syntax query text to the filter the engine runs, a
 * root `And` over the leaves as the builder writes it; or the tokens it cannot
 * run, each with its column. A tag is looked up by name in the space as the
 * search box looks it up (exact, any case), or is a chip's own id.
 */
export async function compileQueryText(
  expression: string,
  deps: QueryTextDeps,
): Promise<CompiledQueryText> {
  const { ast, source } = readQueryText(expression)
  const problems: QueryTextProblem[] = []
  const at = (token: FilterToken) => ({
    token: source.slice(token.span[0], token.span[1]),
    column: token.span[0] + 1,
  })
  for (const token of ast.filters) {
    const message = tokenProblem(token)
    if (message !== null) problems.push({ ...at(token), message })
  }
  if (ast.freeText !== '') {
    problems.push({
      token: ast.freeText,
      column: freeTextColumn(source, ast),
      message: t('query.text.freeText'),
    })
  }

  const tagIds: string[] = []
  const tagTokens = ast.filters.filter((f) => f.kind === 'tag')
  const named = tagTokens.filter((f) => chipTagId(f.value) === null)
  const tags = named.length > 0 ? await deps.listTags() : []
  for (const token of tagTokens) {
    const chip = chipTagId(token.value)
    const name = token.value.normalize('NFC').toLowerCase()
    const id = chip ?? tags.find((tag) => tag.name.toLowerCase() === name)?.tag_id
    if (id === undefined) {
      problems.push({ ...at(token), message: t('query.text.unknownTag', { name: token.value }) })
    } else {
      tagIds.push(id)
    }
  }

  if (problems.length > 0) {
    return { ok: false, problems: problems.toSorted((a, b) => a.column - b.column) }
  }
  const children = leaves(ast.filters, tagIds).map((primitive): FilterExpr => ({
    type: 'Leaf',
    primitive,
  }))
  // An empty `And` is every block in the space, never what a block with no filter asked for.
  if (children.length === 0) return { ok: false, problems: [] }
  return { ok: true, filter: { type: 'And', children } }
}
