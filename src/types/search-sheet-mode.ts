/**
 * #4006 — moved down from `@/stores/useSearchSheetStore` (which re-exports
 * it unchanged) so `lib/`-tier consumers (`pinned-search-scope.ts`) can
 * depend on the mode literal without importing `stores/`, which the
 * lib-layering guard (#3121) forbids. Pure data — no Zustand dependency.
 */
export type SearchSheetMode = 'in-page' | 'all-pages'
