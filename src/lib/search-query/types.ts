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

/**
 * PEND-53 — Date-filter value carried by `due:` / `scheduled:` tokens.
 *
 * Two shapes:
 *
 * - `{ kind: 'named', name: 'today' | 'overdue' | 'this-week' | ... }`
 *   — bucket keyword resolved against today's date in Rust at query
 *   time. The bucket vocabulary is locked: `today`, `yesterday`,
 *   `overdue`, `this-week`, `this-month`, `next-week`, `older`, `none`.
 * - `{ kind: 'op', op: '<' | '<=' | '=' | '>=' | '>', date: string }`
 *   — explicit comparison form, `date` is `YYYY-MM-DD`.
 */
export type DateFilterValue =
  | { kind: 'named'; name: NamedDateRange }
  | { kind: 'op'; op: DateOp; date: string }

export type NamedDateRange =
  | 'today'
  | 'yesterday'
  | 'overdue'
  | 'this-week'
  | 'this-month'
  | 'next-week'
  | 'older'
  | 'none'

export type DateOp = '<' | '<=' | '=' | '>=' | '>'

/**
 * PEND-53 — Property-filter projection shape on the IPC side. Mirrors
 * the Rust `SearchPropertyFilter` struct exactly (camelCase keys after
 * specta's rename, but since the field names are `key` and `value`
 * already-lowercase, the camelCase rename is a no-op).
 */
export interface SearchPropertyFilter {
  key: string
  value: string
}

/** A single recognised filter token in the parsed query. */
export type FilterToken =
  | { kind: 'tag'; value: string; span: [number, number] }
  | { kind: 'pathInclude'; value: string; span: [number, number] }
  | { kind: 'pathExclude'; value: string; span: [number, number] }
  // PEND-53 — `state:` / `not-state:`
  | { kind: 'state'; value: string; span: [number, number] }
  | { kind: 'notState'; value: string; span: [number, number] }
  // PEND-53 — `priority:` / `not-priority:`
  | { kind: 'priority'; value: string; span: [number, number] }
  | { kind: 'notPriority'; value: string; span: [number, number] }
  // PEND-53 — `due:` / `scheduled:`
  | { kind: 'due'; value: DateFilterValue; raw: string; span: [number, number] }
  | { kind: 'scheduled'; value: DateFilterValue; raw: string; span: [number, number] }
  // PEND-53 — `prop:key=value` / `not-prop:key=value`
  | { kind: 'prop'; key: string; value: string; span: [number, number] }
  | { kind: 'notProp'; key: string; value: string; span: [number, number] }
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
  if (t.kind === 'due' || t.kind === 'scheduled') {
    // Date values: use raw text so two distinct named buckets / ops
    // get distinct keys.
    return `${t.kind}:${t.raw}`
  }
  if (t.kind === 'prop' || t.kind === 'notProp') {
    return `${t.kind}:${t.key}=${t.value}`
  }
  return `${t.kind}:${t.value}`
}
