/**
 * Serialiser: `SearchQueryAST` → canonical query string.
 *
 * Round-trip invariant (documented in AGENTS.md):
 *   `parse(serialize(parse(s))) === parse(s)`   for any `s`
 *   `serialize(parse(s)) === s`                  for canonical `s`
 *
 * Canonical form: every filter token rendered with its prefix
 * (`tag:#`, `path:`, `not-path:`), single-space separated, free-text
 * appended at the end.
 *
 * `removeFilter` is the only mutation primitive UI components need;
 * chip-click handlers call it and re-serialise.
 */

import { isOrWord } from '@/lib/search-query/classify-word'
import { tokenize } from '@/lib/search-query/tokenize'
import type { FilterNode, FilterToken, SearchQueryAST } from '@/lib/search-query/types'

/**
 * #152 / #718 — emit a filter value bare when the tokeniser reads it back
 * as one self-contained word, else wrap it in `"..."`. Used by `prop:` /
 * `not-prop:` (#152), `path:` / `not-path:` (#718) and `tag:#`, and by the
 * autocomplete insertion path (`applyAutocompleteReplacement`) so all
 * emitters share one predicate.
 *
 * Bare fails for a value with whitespace, for a value ending in `)`, for a
 * `"`-surrounded value (the
 * recognisers strip one pair, so `"a"` must go out as `""a""`), and for a
 * value whose `"` would stay unclosed (`a"b` from `path:"a"b"`): an
 * unclosed quote makes the word free text. Bare wins when it survives,
 * because quoting `a" b"` would close at its first `" `.
 *
 * `prefix` is the text the value is glued to; the `x` default stands in for
 * a quote-free one such as `path:`. Only `prop:` passes it, since its key
 * may hold a `"` that the value has to close.
 *
 * There is NO escape syntax for `"` inside the quotes. The helper-form
 * doors reject literal `"` outright (PropFilterForm #152,
 * FilterHelperPopover's path form #718).
 */
export function quoteValueIfNeeded(v: string, prefix = 'x'): string {
  const quoteSurrounded = v.length >= 2 && v.startsWith('"') && v.endsWith('"')
  if (quoteSurrounded) return `"${v}"`
  // In a query holding `OR` a trailing `)` closes a group.
  if (v.endsWith(')')) return `"${v}"`
  const glued = prefix + v
  const [word, ...rest] = tokenize(glued)
  const bare =
    rest.length === 0 && word?.text === glued && word.kind === 'word' && !word.unclosedQuote
  return bare ? v : `"${v}"`
}

/** Render a single token back to its canonical source form. */
export function tokenSource(t: FilterToken): string {
  switch (t.kind) {
    case 'tag':
    case 'under': {
      return `${t.kind}:#${quoteValueIfNeeded(t.value)}`
    }
    case 'pathInclude': {
      return `path:${quoteValueIfNeeded(t.value)}`
    }
    case 'pathExclude': {
      return `not-path:${quoteValueIfNeeded(t.value)}`
    }
    case 'state': {
      return `state:${t.value}`
    }
    case 'notState': {
      return `not-state:${t.value}`
    }
    case 'priority': {
      return `priority:${t.value}`
    }
    case 'notPriority': {
      return `not-priority:${t.value}`
    }
    case 'due': {
      return `due:${t.raw}`
    }
    case 'scheduled': {
      return `scheduled:${t.raw}`
    }
    case 'prop':
    case 'notProp': {
      const prefix = `${t.kind === 'prop' ? 'prop' : 'not-prop'}:${t.key}=`
      return prefix + quoteValueIfNeeded(t.value, prefix)
    }
    case 'invalid': {
      return t.source
    }
  }
}

/** `node` in source form: an OR inside an AND is parenthesised, an AND inside an OR is not. */
function nodeSource(filters: FilterToken[], node: FilterNode): string {
  if (node.kind === 'token') return tokenSource(filters[node.index] as FilterToken)
  if (node.kind === 'or') return node.children.map((c) => nodeSource(filters, c)).join(' OR ')
  return node.children
    .map((c) => (c.kind === 'or' ? `(${nodeSource(filters, c)})` : nodeSource(filters, c)))
    .join(' ')
}

/**
 * Canonical serialisation of an AST: the filters (as their tree when they
 * have one), then the free text. Free text holding `OR` beside filters is
 * parenthesised, and so is a tree whose top is an OR beside free text, so
 * neither reads as one operand of the other's `OR`.
 */
export function serialize(ast: SearchQueryAST): string {
  const parts: string[] = []
  if (ast.expr) {
    const source = nodeSource(ast.filters, ast.expr)
    parts.push(ast.expr.kind === 'or' && ast.freeText ? `(${source})` : source)
  } else {
    for (const f of ast.filters) parts.push(tokenSource(f))
  }
  if (ast.freeText) {
    const holdsOr = tokenize(ast.freeText, true).some(isOrWord)
    parts.push(holdsOr && parts.length > 0 ? `(${ast.freeText})` : ast.freeText)
  }
  return parts.join(' ')
}

/** `node` without the filter at `index`, later indices shifted down; `null` once empty. */
function withoutIndex(node: FilterNode, index: number): FilterNode | null {
  if (node.kind === 'token') {
    if (node.index === index) return null
    return node.index > index ? { kind: 'token', index: node.index - 1 } : node
  }
  const children = node.children.flatMap((c) => withoutIndex(c, index) ?? [])
  if (children.length === 0) return null
  return children.length === 1 ? (children[0] as FilterNode) : { kind: node.kind, children }
}

const holdsOr = (node: FilterNode): boolean =>
  node.kind === 'or' || (node.kind === 'and' && node.children.some(holdsOr))

/** Drop the filter at `index` and return a fresh AST. */
export function removeFilterAt(ast: SearchQueryAST, index: number): SearchQueryAST {
  const filters = ast.filters.filter((_, i) => i !== index)
  const expr = ast.expr ? withoutIndex(ast.expr, index) : null
  return expr && holdsOr(expr)
    ? { filters, freeText: ast.freeText, expr }
    : { filters, freeText: ast.freeText }
}

/** Append a freshly-constructed filter to the end of `ast.filters`, AND-ed with the rest. */
export function addFilter(ast: SearchQueryAST, token: FilterToken): SearchQueryAST {
  const filters = [...ast.filters, token]
  if (!ast.expr) return { ...ast, filters }
  const added: FilterNode = { kind: 'token', index: ast.filters.length }
  const expr: FilterNode =
    ast.expr.kind === 'and'
      ? { kind: 'and', children: [...ast.expr.children, added] }
      : { kind: 'and', children: [ast.expr, added] }
  return { ...ast, filters, expr }
}
