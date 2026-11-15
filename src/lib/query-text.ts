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
 * repeats OR'd; the search syntax's is the tag named `work` and the tags
 * nested under it (`work/urgent`), attached, its repeats AND'd. {@link isLegacyQueryText} therefore reads a block as the older
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
import type { FilterExpr, FilterPrimitive } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { type FilterToken, parse, type SearchQueryAST, tokenize } from '@/lib/search-query'
import {
  canonical,
  compileFilterTree,
  conditions,
  leafOf,
  pathPatterns,
} from '@/lib/search-query/compile-filter'
import { quoteValueIfNeeded } from '@/lib/search-query/serialize'

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

/**
 * What to run, or why not: the tokens the block cannot run, none when it holds
 * nothing to run at all. `fulltext` is the text outside every filter, empty for
 * none. `textOnly` marks what the builder's form has no control for (free text,
 * `under:`, a page-name glob, and a relative date, which the form would save as
 * today's dates).
 */
export type CompiledQueryText =
  | { ok: true; filter: FilterExpr; fulltext: string; textOnly: boolean }
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

/** Why `token` cannot run in a query block, or `null` when it can. */
function tokenProblem(token: FilterToken): string | null {
  if (token.kind === 'invalid') return token.error
  try {
    pathPatterns(token)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/** Whether the builder's form has no control for `token`. */
function isTextOnly(token: FilterToken): boolean {
  if (token.kind === 'pathInclude' || token.kind === 'pathExclude') return true
  if (token.kind === 'under') return true
  return (
    (token.kind === 'due' || token.kind === 'scheduled') &&
    token.value.kind === 'named' &&
    token.value.name !== 'none'
  )
}

/**
 * A token's tag, looked up by name in `tags` as the search box looks it up
 * (exact, any case) or a chip's own id; a name no tag holds is an `Or` of the
 * tags nested under it, and `null` with none.
 */
function tagConditionIn(
  tags: ReadonlyArray<{ tag_id: string; name: string }>,
  token: Extract<FilterToken, { kind: 'tag' | 'under' }>,
): FilterExpr | null {
  const type = token.kind === 'under' ? 'TagUnder' : 'Tag'
  const name = token.value.normalize('NFC').toLowerCase()
  const id = chipTagId(token.value) ?? tags.find((tag) => tag.name.toLowerCase() === name)?.tag_id
  if (id !== undefined) return leafOf({ type, tag: id })
  const nested = tags.filter((tag) => tag.name.toLowerCase().startsWith(`${name}/`))
  if (nested.length === 0) return null
  return { type: 'Or', children: nested.map((tag) => leafOf({ type, tag: tag.tag_id })) }
}

/**
 * Compile a block's search-syntax query text to what the engine runs: a root
 * `And` over its conditions, as the builder writes it, and its free text as
 * the full-text term; or the tokens it cannot run, each with its column. A tag
 * is looked up by name in `tags` as the search box looks it up (exact, any
 * case), or is a chip's own id; the engine matches it with the tags nested
 * under it. A name no tag holds is an `Or` of the tags nested under it
 * (`projects` with only `projects/web`). A relative date is resolved on
 * `today`, so on every run.
 */
export function compileQueryTextWithTags(
  expression: string,
  tags: ReadonlyArray<{ tag_id: string; name: string }>,
  today: Date = new Date(),
): CompiledQueryText {
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

  if (ast.expr) {
    const { expr } = ast
    let nestedOnly = false
    const tree = compileFilterTree(
      { ...ast, expr },
      (token) => {
        const condition = tagConditionIn(tags, token)
        if (condition === null) {
          problems.push({
            ...at(token),
            message: t('query.text.unknownTag', { name: token.value }),
          })
        } else if (condition.type === 'Or') {
          nestedOnly = true
        }
        return condition
      },
      today,
    )
    if (problems.length > 0) {
      return { ok: false, problems: problems.toSorted((a, b) => a.column - b.column) }
    }
    return {
      ok: true,
      filter: tree,
      fulltext: ast.freeText,
      textOnly: ast.freeText !== '' || nestedOnly || ast.filters.some(isTextOnly),
    }
  }

  const tagIds: string[] = []
  const nestedOnly: FilterExpr[] = []
  // The parser refuses `tag:` beside `under:`, so one `under:` means every tag is one.
  const tagLeaf = ast.filters.some((f) => f.kind === 'under') ? 'TagUnder' : 'Tag'
  for (const token of ast.filters.filter((f) => f.kind === 'tag' || f.kind === 'under')) {
    const name = token.value.normalize('NFC').toLowerCase()
    const id = chipTagId(token.value) ?? tags.find((tag) => tag.name.toLowerCase() === name)?.tag_id
    const nested = tags.filter((tag) => tag.name.toLowerCase().startsWith(`${name}/`))
    if (id !== undefined) {
      tagIds.push(id)
    } else if (nested.length > 0) {
      nestedOnly.push({
        type: 'Or',
        children: nested.map((tag) => ({
          type: 'Leaf',
          primitive: { type: tagLeaf, tag: tag.tag_id },
        })),
      })
    } else {
      problems.push({ ...at(token), message: t('query.text.unknownTag', { name: token.value }) })
    }
  }

  if (problems.length > 0) {
    return { ok: false, problems: problems.toSorted((a, b) => a.column - b.column) }
  }
  const children = [...conditions(ast.filters, tagIds, tagLeaf, today), ...nestedOnly]
  // An empty `And` alone is every block in the space, never what an empty block asked for.
  if (children.length === 0 && ast.freeText === '') return { ok: false, problems: [] }
  return {
    ok: true,
    filter: { type: 'And', children },
    fulltext: ast.freeText,
    // A name standing for its nested tags would be saved as today's tags.
    textOnly: ast.freeText !== '' || nestedOnly.length > 0 || ast.filters.some(isTextOnly),
  }
}

/** {@link compileQueryTextWithTags} over the space's tags, listed only when the text names one. */
export async function compileQueryText(
  expression: string,
  deps: QueryTextDeps,
): Promise<CompiledQueryText> {
  const namesATag = readQueryText(expression).ast.filters.some(
    (f) => (f.kind === 'tag' || f.kind === 'under') && chipTagId(f.value) === null,
  )
  return compileQueryTextWithTags(expression, namesATag ? await deps.listTags() : [])
}

const DATE_OPS = { Before: '<', OnOrBefore: '<=', On: '', OnOrAfter: '>=', After: '>' } as const

/** The words a leaf would be in the search syntax; none for a leaf the syntax has no token for. */
function leafWords(leaf: FilterPrimitive): string[] {
  switch (leaf.type) {
    case 'Tag': {
      return [`#[${leaf.tag}]`]
    }
    case 'State':
    case 'Priority': {
      const prefix = `${leaf.exclude ? 'not-' : ''}${leaf.type.toLowerCase()}:`
      return [...leaf.values, ...(leaf.is_null ? ['none'] : [])].map((value) => prefix + value)
    }
    case 'HasProperty': {
      const { predicate } = leaf
      const exclude = predicate.type === 'Ne' || predicate.type === 'NotExists'
      const prefix = `${exclude ? 'not-prop' : 'prop'}:${leaf.key}=`
      if (predicate.type === 'Exists' || predicate.type === 'NotExists') return [prefix]
      if (predicate.type !== 'Eq' && predicate.type !== 'Ne') return []
      return [prefix + quoteValueIfNeeded(String(predicate.value.value), prefix)]
    }
    case 'DueDate':
    case 'Scheduled': {
      const { predicate } = leaf
      const prefix = leaf.type === 'DueDate' ? 'due:' : 'scheduled:'
      if (predicate.type === 'IsNull') return [`${prefix}none`]
      return predicate.type === 'Between'
        ? []
        : [prefix + DATE_OPS[predicate.type] + predicate.date]
    }
    case 'BlockType':
    case 'CaseSensitive':
    case 'ChildOf':
    case 'Created':
    case 'HasNoInboundLinks':
    case 'HasParentMatching':
    case 'LastEdited':
    case 'LinkedFrom':
    case 'LinksTo':
    case 'Orphan':
    case 'PathGlob':
    case 'Regex':
    case 'Snippet':
    case 'Space':
    case 'Stub':
    case 'TagOrRef':
    case 'TagUnder':
    case 'WholeWord':
    default: {
      return []
    }
  }
}

/** `expr` with nested nodes of one kind flattened, single children unwrapped and children sorted, so two trees compare whatever order built them. */
function normalisedTree(expr: FilterExpr): string {
  const flat = (e: FilterExpr): FilterExpr => {
    if (e.type === 'Leaf') return e
    if (e.type === 'Not') return { type: 'Not', child: flat(e.child) }
    const children = e.children
      .map(flat)
      .flatMap((c) => (c.type === e.type ? (c as { children: FilterExpr[] }).children : [c]))
      .toSorted((a, b) => canonical(a).localeCompare(canonical(b)))
    return children.length === 1 ? (children[0] as FilterExpr) : { type: e.type, children }
  }
  return canonical(flat(expr))
}

/** The search-syntax words of `expr`, an OR inside an AND parenthesised; `null` for what the syntax cannot say. */
function exprWords(expr: FilterExpr): string | null {
  if (expr.type === 'Leaf') {
    const words = leafWords(expr.primitive)
    return words.length > 0 ? words.join(' ') : null
  }
  if (expr.type === 'Not' || expr.children.length === 0) return null
  const parts: string[] = []
  for (const child of expr.children) {
    const words = exprWords(child)
    if (words === null) return null
    parts.push(expr.type === 'And' && child.type === 'Or' ? `(${words})` : words)
  }
  return parts.join(expr.type === 'And' ? ' ' : ' OR ')
}

/**
 * The search-syntax text the builder saves for `filter`, or `null` when only a
 * `v2:` payload holds it. The words are written node by node and kept only when
 * the block would read them back as the same tree of the same leaves, so a
 * filter the syntax cannot say (a `Not`, a value the reader would retype, text
 * the older reader would claim) is never saved as a text that means something
 * else. A tag is its chip, which follows a rename as the payload's id does.
 */
export function filterToQueryText(filter: FilterExpr): string | null {
  const text = exprWords(filter)
  if (text === null || isLegacyQueryText(text)) return null
  const read = compileQueryTextWithTags(text, [])
  return read.ok && normalisedTree(read.filter) === normalisedTree(filter) ? text : null
}
