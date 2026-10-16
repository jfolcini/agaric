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

import { tokenize } from '@/lib/search-query/tokenize'
import type { FilterToken, SearchQueryAST } from '@/lib/search-query/types'

/**
 * #152 / #718 — emit a filter value bare when the tokeniser reads it back
 * as one self-contained word, else wrap it in `"..."`. Used by `prop:` /
 * `not-prop:` (#152), `path:` / `not-path:` (#718) and `tag:#`, and by the
 * autocomplete insertion path (`applyAutocompleteReplacement`) so all
 * emitters share one predicate.
 *
 * Bare fails for a value with whitespace, for a `"`-surrounded value (the
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
  const glued = prefix + v
  const [word, ...rest] = tokenize(glued)
  const bare =
    rest.length === 0 && word?.text === glued && word.kind === 'word' && !word.unclosedQuote
  return bare ? v : `"${v}"`
}

/** Render a single token back to its canonical source form. */
export function tokenSource(t: FilterToken): string {
  switch (t.kind) {
    case 'tag': {
      return `tag:#${quoteValueIfNeeded(t.value)}`
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

/** Canonical serialisation of an AST. */
export function serialize(ast: SearchQueryAST): string {
  const parts: string[] = []
  for (const f of ast.filters) parts.push(tokenSource(f))
  if (ast.freeText) parts.push(ast.freeText)
  return parts.join(' ')
}

/** Drop the filter at `index` and return a fresh AST. */
export function removeFilterAt(ast: SearchQueryAST, index: number): SearchQueryAST {
  return {
    ...ast,
    filters: ast.filters.filter((_, i) => i !== index),
  }
}

/** Append a freshly-constructed filter to the end of `ast.filters`. */
export function addFilter(ast: SearchQueryAST, token: FilterToken): SearchQueryAST {
  return { ...ast, filters: [...ast.filters, token] }
}
