/**
 * PEND-54 — Project a parsed `SearchQueryAST` onto IPC-side
 * `SearchFilter` fields.
 *
 * The AST is the canonical model on the frontend; this adapter is the
 * single point where it crosses into the wire shape. Keep the
 * projection small and additive — PEND-53 will append `state_filter`,
 * `priority_filter`, … to this same adapter as the registry grows.
 *
 * Unknown / invalid tokens are intentionally dropped from the IPC
 * projection (they still render as red chips in the UI). The plan's
 * "Mixing `path:` and `not-path:`" edge case is handled by the
 * backend's SQL composition (both clauses AND-joined).
 */

import type { SearchQueryAST } from './types'

export interface AstFilterProjection {
  tagNames: string[]
  includePageGlobs: string[]
  excludePageGlobs: string[]
}

export function astToFilterProjection(ast: SearchQueryAST): AstFilterProjection {
  const tagNames: string[] = []
  const includePageGlobs: string[] = []
  const excludePageGlobs: string[] = []
  for (const f of ast.filters) {
    switch (f.kind) {
      case 'tag':
        if (!tagNames.includes(f.value)) tagNames.push(f.value)
        break
      case 'pathInclude':
        // Comma-separated values inside one path: token expand into
        // multiple include entries (the plan's "Multiple `path:`
        // tokens → equivalent to comma-separating them" rule).
        for (const v of splitCommas(f.value)) includePageGlobs.push(v)
        break
      case 'pathExclude':
        for (const v of splitCommas(f.value)) excludePageGlobs.push(v)
        break
      case 'invalid':
        // Don't ship invalid tokens to the backend.
        break
    }
  }
  return { tagNames, includePageGlobs, excludePageGlobs }
}

function splitCommas(value: string): string[] {
  // Top-level comma split — commas inside a `{...}` group belong to
  // brace alternatives and must not break the entry into separate
  // globs. Mirrors the Rust `split_top_level_commas` helper.
  const parts: string[] = []
  let depth = 0
  let last = 0
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (ch === '{') depth++
    else if (ch === '}') depth = Math.max(0, depth - 1)
    else if (ch === ',' && depth === 0) {
      parts.push(value.slice(last, i))
      last = i + 1
    }
  }
  parts.push(value.slice(last))
  return parts.map((s) => s.trim()).filter((s) => s.length > 0)
}
