/**
 * searchFilterReducer — applied-filter state for SearchPanel.
 *
 * PEND-30 D-3 — extracted from `SearchPanel.tsx` (4 parallel `useState`
 * calls collapsed into one `useReducer`). Owns the *applied* page-filter
 * + tag-filter state surfaced to the search query. Popover-internal
 * state (open / query / suggestions / loading) lives in
 * `usePopoverEntity` instead — these are independent state machines
 * that happen to feed into the same chip bar.
 *
 * Action shape mirrors the original handlers in `SearchPanel.tsx` so
 * the diff is mechanical: every `setFilter*(value)` call site becomes
 * a `dispatch({ type: '...' , value })` call site with no behavioural
 * change.
 */
export interface SearchFilterState {
  /** Currently-applied page filter id (`null` when none). */
  filterPageId: string | null
  /** Display title for the applied page filter; mirrors `filterPageId`. */
  filterPageTitle: string | null
  /** Currently-applied tag-filter ids (parallel array with `filterTagNames`). */
  filterTagIds: string[]
  /** Display names for the applied tag filters (parallel array with `filterTagIds`). */
  filterTagNames: string[]
}

export const INITIAL_SEARCH_FILTER_STATE: SearchFilterState = {
  filterPageId: null,
  filterPageTitle: null,
  filterTagIds: [],
  filterTagNames: [],
}

/**
 * Discriminated union of mutations that `SearchPanel` performs on the
 * applied-filter state. The reducer is pure — every action produces a
 * fresh object (no in-place mutation) so React shallow-equality picks
 * up changes for memo'd children.
 */
export type SearchFilterAction =
  /** Apply a page filter (replaces any existing page filter). */
  | { type: 'set-page-filter'; pageId: string; pageTitle: string }
  /** Drop the applied page filter. */
  | { type: 'clear-page-filter' }
  /**
   * Append a tag to the active filter set. Idempotent: if `tagId` is
   * already applied the action is a no-op (mirrors the
   * `if (filterTagIds.includes(tag.tag_id)) return` early-return in
   * the original handler).
   */
  | { type: 'add-tag-filter'; tagId: string; tagName: string }
  /** Remove the tag at `index` from the applied set. */
  | { type: 'remove-tag-filter'; index: number }
  /** Drop every applied filter — page and tags. */
  | { type: 'clear-all' }

export function searchFilterReducer(
  state: SearchFilterState,
  action: SearchFilterAction,
): SearchFilterState {
  switch (action.type) {
    case 'set-page-filter':
      return {
        ...state,
        filterPageId: action.pageId,
        filterPageTitle: action.pageTitle,
      }
    case 'clear-page-filter':
      return {
        ...state,
        filterPageId: null,
        filterPageTitle: null,
      }
    case 'add-tag-filter': {
      // Idempotency guard — preserves the original
      // `if (filterTagIds.includes(...)) return` behaviour.
      if (state.filterTagIds.includes(action.tagId)) return state
      return {
        ...state,
        filterTagIds: [...state.filterTagIds, action.tagId],
        filterTagNames: [...state.filterTagNames, action.tagName],
      }
    }
    case 'remove-tag-filter':
      return {
        ...state,
        filterTagIds: state.filterTagIds.filter((_, i) => i !== action.index),
        filterTagNames: state.filterTagNames.filter((_, i) => i !== action.index),
      }
    case 'clear-all':
      return INITIAL_SEARCH_FILTER_STATE
  }
}

/** Convenience: derive `hasFilters` from a `SearchFilterState`. */
export function hasActiveFilters(state: SearchFilterState): boolean {
  return state.filterPageId !== null || state.filterTagIds.length > 0
}
