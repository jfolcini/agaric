/**
 * #4006 — moved down from `@/stores/navigation` (which re-exports it
 * unchanged) so `lib/`-tier consumers (`nav-items.ts`) can depend on the
 * view-id literal without importing `stores/`, which the lib-layering guard
 * (#3121) forbids. Pure data — no Zustand dependency.
 */
export type View =
  | 'journal'
  | 'search'
  | 'pages'
  | 'tags'
  | 'trash'
  | 'status'
  | 'history'
  | 'templates'
  | 'settings'
  | 'graph'
  | 'query'
  | 'page-editor'
