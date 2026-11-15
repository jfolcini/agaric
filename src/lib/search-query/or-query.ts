/**
 * The grammar of a query holding the word `OR` (#6742): `OR` between filters,
 * and parentheses to group them. `parse` comes here only for such a query, so
 * every other query keeps the flat reading of `classify`.
 *
 * - The implicit AND binds tighter than OR, as in FTS5:
 *   `state:TODO tag:#a OR tag:#b` is `(TODO AND a) OR b`.
 * - A parenthesis is a `(` that starts a word, a `)` that ends one, or a word
 *   of its own.
 * - Words are one full-text expression with FTS5's own `OR`, AND-ed with the
 *   filters. An `OR` joins two words or two filters, never one of each: a word
 *   inside an OR of filters, or inside a group of them, is an invalid token.
 *   Words in parentheses are the full-text expression when the parentheses
 *   hold every word of the query (`(cats OR dogs) tag:#a`).
 * - `NOT` before a filter or group, an unbalanced parenthesis, an `OR` with
 *   nothing on one side and empty parentheses are invalid tokens.
 *
 * The result keeps `filters` flat, in source order, and adds `expr` when an
 * OR between filters remains.
 */

import { t } from '@/lib/i18n'
import {
  buildFreeText,
  classifyWord,
  flagShadowedDates,
  flagTagBesideUnder,
} from '@/lib/search-query/classify'
import { type RawToken, tokenize } from '@/lib/search-query/tokenize'
import type { FilterNode, FilterToken, SearchQueryAST } from '@/lib/search-query/types'

type Span = [number, number]

type Sym =
  | { t: 'open'; span: Span }
  | { t: 'close'; span: Span }
  | { t: 'or'; span: Span }
  | { t: 'atom'; tok: RawToken }

type Item =
  | { t: 'word'; tok: RawToken }
  | { t: 'filter'; token: FilterToken }
  | { t: 'or'; span: Span }
  | { t: 'group'; open: Span; close: Span; items: Item[] }

/** A tree over the token objects, indexed once every token is known. */
type Node = { kind: 'token'; token: FilterToken } | { kind: 'and' | 'or'; children: Node[] }

interface Ctx {
  input: string
  tokens: FilterToken[]
  consumed: Span[]
  quoted: Span[]
}

/** Split each word's leading `(`s and trailing `)`s off; `OR` becomes an operator. */
function symbols(tokens: RawToken[]): Sym[] {
  const out: Sym[] = []
  for (const tok of tokens) {
    if (tok.kind === 'quoted') {
      out.push({ t: 'atom', tok })
      continue
    }
    const { text } = tok
    const at = tok.span[0]
    let s = 0
    while (text[s] === '(') {
      out.push({ t: 'open', span: [at + s, at + s + 1] })
      s++
    }
    let e = text.length
    while (e > s && text[e - 1] === ')') e--
    const core = text.slice(s, e)
    if (core !== '') out.push(coreSym(core, [at + s, at + e], tok.unclosedQuote === true))
    for (let k = e; k < text.length; k++) out.push({ t: 'close', span: [at + k, at + k + 1] })
  }
  return out
}

function coreSym(core: string, span: Span, unclosedQuote: boolean): Sym {
  if (core.toUpperCase() === 'OR') return { t: 'or', span }
  const [only, ...rest] = tokenize(core, true)
  // `("a b")` peels to a phrase.
  if (rest.length === 0 && only?.kind === 'quoted' && only.text === core) {
    return { t: 'atom', tok: { kind: 'quoted', text: core, span } }
  }
  return unclosedQuote
    ? { t: 'atom', tok: { kind: 'word', text: core, span, unclosedQuote } }
    : { t: 'atom', tok: { kind: 'word', text: core, span } }
}

function invalid(input: string, span: Span, error: string): FilterToken {
  return { kind: 'invalid', source: input.slice(span[0], span[1]), error, span }
}

/** The items up to the `)` closing this level, or the end of the input. */
function parseItems(
  syms: Sym[],
  from: number,
  depth: number,
  input: string,
): { items: Item[]; next: number; close: Span | null } {
  const items: Item[] = []
  let pos = from
  while (pos < syms.length) {
    const sym = syms[pos] as Sym
    if (sym.t === 'open') {
      const inner = parseItems(syms, pos + 1, depth + 1, input)
      if (inner.close) {
        items.push({ t: 'group', open: sym.span, close: inner.close, items: inner.items })
      } else {
        // Unclosed: the `(` alone is flagged; what follows stays at this level.
        items.push({
          t: 'filter',
          token: invalid(input, sym.span, t('searchQuery.unbalancedParen')),
        })
        items.push(...inner.items)
      }
      pos = inner.next
    } else if (sym.t === 'close') {
      if (depth > 0) return { items, next: pos + 1, close: sym.span }
      items.push({ t: 'filter', token: invalid(input, sym.span, t('searchQuery.unbalancedParen')) })
      pos++
    } else if (sym.t === 'or') {
      items.push({ t: 'or', span: sym.span })
      pos++
    } else {
      const token = sym.tok.kind === 'word' ? classifyWord(sym.tok) : null
      items.push(token ? { t: 'filter', token } : { t: 'word', tok: sym.tok })
      pos++
    }
  }
  return { items, next: pos, close: null }
}

const hasFilterOrGroup = (items: Item[]): boolean =>
  items.some((item) => item.t === 'filter' || item.t === 'group')

const isWordGroup = (item: Item): boolean =>
  item.t === 'group' &&
  item.items.length > 0 &&
  item.items.every((inner) => inner.t === 'word' || inner.t === 'or')

function tokenNode(ctx: Ctx, token: FilterToken): Node {
  ctx.tokens.push(token)
  ctx.consumed.push(token.span)
  return { kind: 'token', token }
}

function freeWord(ctx: Ctx, item: Extract<Item, { t: 'word' }>): void {
  if (item.tok.kind === 'quoted') ctx.quoted.push(item.tok.span)
}

/** Whether the `OR` at `i` has an operand on each side. */
function orJoins(items: Item[], i: number): boolean {
  const prev = items[i - 1]
  const next = items[i + 1]
  return prev !== undefined && next !== undefined && prev.t !== 'or' && next.t !== 'or'
}

/**
 * Why a group cannot run, or `null`. Such a group is one invalid token: its
 * flaw depends on what is around it, so flattened into its parent it would
 * read differently.
 */
function groupFlaw(group: Extract<Item, { t: 'group' }>, atTop: boolean): string | null {
  const { items } = group
  if (items.length === 0) return t('searchQuery.emptyGroup')
  if (atTop && isWordGroup(group)) return t('searchQuery.wordGroupNotAlone')
  if (items.some((item) => item.t === 'word')) return t('searchQuery.textBesideFilterOr')
  if (items.some((item, i) => item.t === 'or' && !orJoins(items, i))) {
    return t('searchQuery.orMissingSide')
  }
  return null
}

/** A group; `atTop` beside the free text of the top level, where words in parentheses can be the full-text expression. */
function groupNode(ctx: Ctx, group: Extract<Item, { t: 'group' }>, atTop = false): Node | null {
  const flaw = groupFlaw(group, atTop)
  if (flaw !== null) {
    return tokenNode(ctx, invalid(ctx.input, [group.open[0], group.close[1]], flaw))
  }
  ctx.consumed.push(group.open, group.close)
  return filterLevel(ctx, group.items)
}

/** A level whose `OR`s join filters: the AND runs between them. A word there is invalid. */
function filterLevel(ctx: Ctx, items: Item[]): Node | null {
  const runs: Node[][] = [[]]
  items.forEach((item, i) => {
    const run = runs.at(-1) as Node[]
    if (item.t === 'or') {
      if (orJoins(items, i)) {
        ctx.consumed.push(item.span)
        runs.push([])
      } else {
        run.push(tokenNode(ctx, invalid(ctx.input, item.span, t('searchQuery.orMissingSide'))))
      }
      return
    }
    const node =
      item.t === 'group'
        ? groupNode(ctx, item)
        : item.t === 'filter'
          ? tokenNode(ctx, item.token)
          : tokenNode(ctx, invalid(ctx.input, item.tok.span, t('searchQuery.textBesideFilterOr')))
    if (node) run.push(node)
  })
  const conjunctions = runs.map((children): Node => ({ kind: 'and', children }))
  return conjunctions.length === 1
    ? (conjunctions[0] as Node)
    : { kind: 'or', children: conjunctions }
}

/** A `NOT` right before a filter or group, which it cannot negate. */
function negatesFilter(item: Item, next: Item | undefined): boolean {
  return (
    item.t === 'word' &&
    item.tok.kind === 'word' &&
    item.tok.text.toUpperCase() === 'NOT' &&
    (next?.t === 'filter' || next?.t === 'group')
  )
}

/** The top level: free text beside filters, unless an `OR` there joins filters. */
function topLevel(ctx: Ctx, items: Item[]): Node | null {
  if (!hasFilterOrGroup(items)) {
    // Words alone, `OR`s among them FTS5's: free text, as without `OR`.
    for (const item of items) if (item.t === 'word') freeWord(ctx, item)
    return null
  }
  if (items.some((item) => item.t === 'or')) return filterLevel(ctx, items)
  const wordGroups = items.filter(isWordGroup)
  const freeWords = items.filter(
    (item, i) => item.t === 'word' && !negatesFilter(item, items[i + 1]),
  )
  const textGroup = wordGroups.length === 1 && freeWords.length === 0 ? wordGroups[0] : null
  const children: Node[] = []
  items.forEach((item, i) => {
    if (item.t === 'group') {
      if (item === textGroup) {
        ctx.consumed.push(item.open, item.close)
        for (const inner of item.items) if (inner.t === 'word') freeWord(ctx, inner)
        return
      }
      const node = groupNode(ctx, item, true)
      if (node) children.push(node)
    } else if (item.t === 'filter') {
      children.push(tokenNode(ctx, item.token))
    } else if (item.t === 'word') {
      if (negatesFilter(item, items[i + 1])) {
        children.push(
          tokenNode(ctx, invalid(ctx.input, item.tok.span, t('searchQuery.notBeforeFilter'))),
        )
      } else {
        freeWord(ctx, item)
      }
    }
  })
  return { kind: 'and', children }
}

/** Flatten nested nodes of one kind, drop empty ones, and unwrap a single child. */
function normalise(node: FilterNode): FilterNode | null {
  if (node.kind === 'token') return node
  const children: FilterNode[] = []
  for (const child of node.children) {
    const c = normalise(child)
    if (c === null) continue
    if (c.kind === node.kind) children.push(...(c as { children: FilterNode[] }).children)
    else children.push(c)
  }
  if (children.length === 0) return null
  if (children.length === 1) return children[0] as FilterNode
  return { kind: node.kind, children }
}

function hasOr(node: FilterNode): boolean {
  return node.kind === 'or' || (node.kind === 'and' && node.children.some(hasOr))
}

/** Each AND run's direct filters, as one list of indices per run. */
function andRuns(node: FilterNode, out: number[][]): number[][] {
  if (node.kind === 'token') return out
  if (node.kind === 'and') {
    out.push(node.children.flatMap((c) => (c.kind === 'token' ? [c.index] : [])))
  }
  for (const child of node.children) andRuns(child, out)
  return out
}

/** Classify the tokens of a query holding `OR` (tokenised with `parenClose`). */
export function classifyOr(tokens: RawToken[], input: string): SearchQueryAST {
  const ctx: Ctx = { input, tokens: [], consumed: [], quoted: [] }
  const { items } = parseItems(symbols(tokens), 0, 0, input)
  const root = topLevel(ctx, items)

  const filters = ctx.tokens.toSorted((a, b) => a.span[0] - b.span[0])
  const indexOf = new Map(filters.map((token, i) => [token, i]))
  const toFilterNode = (node: Node): FilterNode =>
    node.kind === 'token'
      ? { kind: 'token', index: indexOf.get(node.token) as number }
      : { kind: node.kind, children: node.children.map(toFilterNode) }
  const expr = root ? normalise(toFilterNode(root)) : null

  const freeText = buildFreeText(input, ctx.consumed, ctx.quoted)
  if (expr && hasOr(expr)) {
    for (const run of andRuns(expr, [])) flagShadowedDates(filters, input, run)
    return { filters, freeText, expr }
  }
  // No OR between filters: the filters AND, read as a flat query reads them.
  flagShadowedDates(filters, input, filters.keys())
  flagTagBesideUnder(filters, input)
  return { filters, freeText }
}
