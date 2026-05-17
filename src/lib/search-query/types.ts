/**
 * PEND-54 — AST types for the inline search filter syntax.
 *
 * The query string is the canonical source of truth. Every "chip" the
 * UI renders is a projection of one `FilterToken` in this AST; every
 * IPC field on `SearchFilter` is a projection of the same AST through
 * `astToSearchFilter`.
 *
 * `span` is `[startColumn, endColumn)` over the original input string,
 * measured in **code units** (`string.length`-compatible). Used by:
 *   - the chip-row tooltip ("invalid token at col 17"),
 *   - the autocomplete anchor (caret column → active filter prefix),
 *   - the test invariants (round-trip serialise must preserve text).
 *
 * The recogniser registry (see `./registry.ts`) accepts new
 * `FilterToken` kinds via the `extend` API; PEND-53 will append
 * `state`, `priority`, `due`, `scheduled`, `prop`, `notProp` without
 * touching the core parser. Surfaces that need to enumerate the live
 * vocabulary read it from `getRegisteredTokenKinds()` rather than
 * importing this union directly — keeps the surface in sync.
 */

/** A single recognised filter token in the parsed query. */
export type FilterToken =
  | { kind: 'tag'; value: string; span: [number, number] }
  | { kind: 'pathInclude'; value: string; span: [number, number] }
  | { kind: 'pathExclude'; value: string; span: [number, number] }
  | { kind: 'invalid'; source: string; error: string; span: [number, number] }

/** Concrete filter kinds — every shape except `invalid`. */
export type FilterKind = Exclude<FilterToken['kind'], 'invalid'>

/** Parsed result of a full query string. */
export interface SearchQueryAST {
  /** Recognised structured filters (one chip per entry). */
  filters: FilterToken[]
  /** Everything that wasn't a structured filter — passed verbatim to FTS5. */
  freeText: string
}

/** Stable React key for a token (kind + value, immune to re-order). */
export function tokenKey(t: FilterToken): string {
  if (t.kind === 'invalid') return `invalid:${t.source}:${t.span[0]}`
  return `${t.kind}:${t.value}`
}
