/**
 * PEND-54 — Serialiser: `SearchQueryAST` → canonical query string.
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

import type { FilterToken, SearchQueryAST } from './types'

/**
 * #152 / #718 — wrap a filter value in `"..."` when it contains any
 * whitespace; otherwise emit it bare. Used by `prop:` / `not-prop:`
 * (#152) and `path:` / `not-path:` (#718) so values with spaces
 * survive the whitespace-splitting tokeniser, and by the autocomplete
 * insertion path (`applyAutocompleteReplacement`) so all emitters share
 * one predicate.
 *
 * A value that is itself `"`-surrounded (e.g. `"a"`, parsed from
 * `path:""a""`) is also quoted: emitting it bare would make the next
 * parse strip the literal quotes as if they were syntax, silently
 * mutating the value on every serialise→parse cycle.
 *
 * There is NO escape syntax for `"` inside the quotes. The helper-form
 * doors reject literal `"` outright (PropFilterForm #152,
 * FilterHelperPopover's path form #718), so every UI-built value
 * round-trips. A hand-typed value combining `"` with whitespace (e.g.
 * `path:a" b"`) follows the tokeniser's literal-quote rules and may not
 * survive a re-serialise cycle — accepted limitation, documented in
 * docs/SEARCH.md.
 */
export function quoteValueIfNeeded(v: string): string {
  const quoteSurrounded = v.length >= 2 && v.startsWith('"') && v.endsWith('"')
  return /\s/.test(v) || quoteSurrounded ? `"${v}"` : v
}

/** Render a single token back to its canonical source form. */
export function tokenSource(t: FilterToken): string {
  switch (t.kind) {
    case 'tag':
      return `tag:#${t.value}`
    case 'pathInclude':
      return `path:${quoteValueIfNeeded(t.value)}`
    case 'pathExclude':
      return `not-path:${quoteValueIfNeeded(t.value)}`
    case 'state':
      return `state:${t.value}`
    case 'notState':
      return `not-state:${t.value}`
    case 'priority':
      return `priority:${t.value}`
    case 'notPriority':
      return `not-priority:${t.value}`
    case 'due':
      return `due:${t.raw}`
    case 'scheduled':
      return `scheduled:${t.raw}`
    case 'prop':
      return `prop:${t.key}=${quoteValueIfNeeded(t.value)}`
    case 'notProp':
      return `not-prop:${t.key}=${quoteValueIfNeeded(t.value)}`
    case 'invalid':
      return t.source
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
