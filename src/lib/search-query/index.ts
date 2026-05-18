/**
 * PEND-54 — Inline filter syntax framework.
 *
 * The query string is the canonical source of truth for the search
 * surface. `parse()` produces a `SearchQueryAST`; chips and IPC
 * projections are derived state.
 */

export type { AutocompleteAnchor } from './autocomplete'
export {
  applyAutocompleteReplacement,
  detectAutocompleteAnchor,
} from './autocomplete'
export { classify, parse } from './classify'
export { EXPANSION_CAP, expandBraces, validateGlob } from './glob-validate'
export { ensureRegistered } from './register'
export {
  _resetRegistryForTests,
  getRegisteredPrefixes,
  looksLikeUnknownPrefix,
  recognise,
  registerTokenPrefix,
} from './registry'
export {
  addFilter,
  removeFilterAt,
  serialize,
  tokenSource,
} from './serialize'
export type { AstFilterProjection } from './to-search-filter'
export { astToFilterProjection } from './to-search-filter'
export type { RawToken } from './tokenize'
export { tokenize } from './tokenize'
export type {
  DateFilterValue,
  DateOp,
  FilterKind,
  FilterToken,
  NamedDateRange,
  SearchPropertyFilter,
  SearchQueryAST,
} from './types'
export { tokenKey } from './types'
