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

/** Render a single token back to its canonical source form. */
export function tokenSource(t: FilterToken): string {
  switch (t.kind) {
    case 'tag':
      return `tag:#${t.value}`
    case 'pathInclude':
      return `path:${t.value}`
    case 'pathExclude':
      return `not-path:${t.value}`
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
