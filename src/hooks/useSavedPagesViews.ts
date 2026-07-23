/**
 * useSavedPagesViews — localStorage-backed named Pages-view snapshots with
 * cross-instance sync (#2003 piece 1).
 *
 * The localStorage shape is owned by `src/lib/saved-pages-views.ts` (a JSON
 * envelope under the `agaric:pages:savedViews:v1` key, registered as
 * `PREFERENCES.savedPagesViews`). Mirrors `useStarredPages`: a thin
 * subscriber over the shared `usePreference` primitive (#2666) — every
 * registry write (this hook's own `saveView`/`deleteView`, which delegate
 * to the lib writers, or any other `writePreference` caller for this key)
 * broadcasts the change, so every mounted hook instance re-reads.
 *
 * Returned `views` is referentially stable across renders while the
 * persisted contents have not changed (the primitive caches the parsed
 * snapshot against the raw stored string).
 */
import { useCallback, useState } from 'react'

import { PREFERENCES, type SavedPagesView, usePreference } from '@/lib/preferences'
import {
  deleteSavedPagesView,
  findMatchingSavedPagesView,
  type PagesViewTuple,
  peekSavedPagesViewsSchemaMismatch,
  savePagesView,
} from '@/lib/saved-pages-views'

export interface UseSavedPagesViewsReturn {
  /** Every saved view, in creation order. Reference-stable while contents are unchanged. */
  views: SavedPagesView[]
  /**
   * The saved view (if any) whose captured tuple structurally matches
   * `currentTuple`, or `null` when the current sort/density/filters combo
   * doesn't match any saved view. `null` when `currentTuple` was omitted.
   */
  activeView: SavedPagesView | null
  /** Save a new view under `name`, capturing `tuple` verbatim. Returns the created view. */
  saveView: (name: string, tuple: PagesViewTuple) => SavedPagesView
  /** Delete a saved view by id and broadcast the change. */
  deleteView: (id: string) => void
  /**
   * True once, on mount, if a saved-views payload written by an
   * incompatible (future) schema version was found on disk and silently
   * discarded back to empty. Callers should surface this once (e.g. via
   * `notify.warning`) then call {@link clearSchemaMismatch} to acknowledge
   * it — the flag does not re-arm itself.
   */
  schemaMismatchDetected: boolean
  /** Acknowledge the schema-mismatch notice so it isn't shown again this session. */
  clearSchemaMismatch: () => void
}

export function useSavedPagesViews(currentTuple?: PagesViewTuple): UseSavedPagesViewsReturn {
  const [payload] = usePreference(PREFERENCES.savedPagesViews)
  const views = payload.views

  // Render-phase lazy init: must run before `useLocalStoragePreference`'s
  // mount-effect write-back re-persists the (now-empty) parsed value in the
  // current schema, which would erase the raw evidence an effect-timed read
  // could otherwise never observe. See `peekSavedPagesViewsSchemaMismatch`'s
  // docstring in `saved-pages-views.ts`.
  const [schemaMismatchDetected, setSchemaMismatchDetected] = useState<boolean>(() =>
    peekSavedPagesViewsSchemaMismatch(),
  )

  // A primitive `SavedPagesView | null` result — no memoization footgun
  // (unlike an array/object return, a changed reference here always
  // reflects a genuine content change, not spurious render churn).
  const activeView = currentTuple ? findMatchingSavedPagesView(views, currentTuple) : null

  const saveView = useCallback(
    (name: string, tuple: PagesViewTuple) => savePagesView(name, tuple),
    [],
  )

  const deleteView = useCallback((id: string) => deleteSavedPagesView(id), [])

  const clearSchemaMismatch = useCallback(() => setSchemaMismatchDetected(false), [])

  return { views, activeView, saveView, deleteView, schemaMismatchDetected, clearSchemaMismatch }
}
