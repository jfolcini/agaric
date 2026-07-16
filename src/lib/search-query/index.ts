/**
 * Inline filter syntax framework.
 *
 * The query string is the canonical source of truth for the search
 * surface. `parse()` produces a `SearchQueryAST`; chips and IPC
 * projections are derived state.
 */

export type { AutocompleteAnchor } from '@/lib/search-query/autocomplete'
export {
  applyAutocompleteReplacement,
  detectAutocompleteAnchor,
} from '@/lib/search-query/autocomplete'
export { classify, parse } from '@/lib/search-query/classify'
export { EXPANSION_CAP, expandBraces, validateGlob } from '@/lib/search-query/glob-validate'
export { ensureRegistered } from '@/lib/search-query/register'
export { looksLikeUnknownPrefix, recognise, registerTokenPrefix } from '@/lib/search-query/registry'
export { addFilter, removeFilterAt, serialize, tokenSource } from '@/lib/search-query/serialize'
export type { AstFilterProjection } from '@/lib/search-query/to-search-filter'
export { astToFilterProjection } from '@/lib/search-query/to-search-filter'
export type { RawToken } from '@/lib/search-query/tokenize'
export { tokenize } from '@/lib/search-query/tokenize'
export type {
  DateFilterValue,
  DateOp,
  FilterToken,
  NamedDateRange,
  SearchPropertyFilter,
  SearchQueryAST,
} from '@/lib/search-query/types'
export { tokenKey } from '@/lib/search-query/types'
