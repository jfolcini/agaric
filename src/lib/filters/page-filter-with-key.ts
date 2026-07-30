/**
 * `PageFilterWithKey` — a `FilterPrimitive` (the Pages-browser /
 * advanced-query wire shape, `@/lib/bindings`) stamped with a stable
 * per-chip `_addId` React key.
 *
 * Lives in `lib/` (not the `PageBrowserFilterRow` component that
 * originally declared it) because it is consumed by the `stores/` tier
 * (`advancedQuery.ts`, `pageBrowserFilters.ts`) — a store depending on a
 * component type would mean UI-layer types are reachable from global
 * state, backwards from the intended `lib < stores < hooks < components`
 * flow (#3121 step 2). The shape itself is pure data (no rendering
 * concern), so `lib/` is the correct home; `PageBrowserFilterRow` imports
 * it from here like any other consumer.
 */

import type { FilterPrimitive } from '@/lib/bindings'

/** A filter primitive stamped with a stable per-chip React key. */
export type PageFilterWithKey = FilterPrimitive & { _addId: number }
