/**
 * Saved Pages views — localStorage-backed named snapshots of the Pages
 * view's `{ sort, density, filters }` tuple (#2003 piece 1).
 *
 * Mirrors `starred-pages.ts`: a thin pure adapter over the `PREFERENCES`
 * registry (`PREFERENCES.savedPagesViews`, see `src/lib/preferences.ts`),
 * with a bulk-safe single-write pattern for list mutation. All the
 * SSR-guard / try-catch / cross-tab broadcast machinery lives in the
 * registry (`readPreference`/`writePreference`, `broadcastPreferenceChange`
 * — a synthetic `StorageEvent`, the app-wide same-tab convention since
 * #2666) — this module stays pure I/O plumbing plus the domain-specific
 * bits the registry can't own: id/timestamp generation, structural
 * equality for "does this view match the current tuple", and the
 * schema-mismatch recovery signal below.
 */

import type { FilterPrimitive } from '@/lib/bindings'
import {
  PREFERENCES,
  peekPreferenceSchemaMismatch,
  readPreference,
  type SavedPagesView,
  writePreference,
} from '@/lib/preferences'

/** The `{ sort, density, filters }` tuple a saved view captures / restores. */
export interface PagesViewTuple {
  sort: SavedPagesView['sort']
  density: SavedPagesView['density']
  filters: FilterPrimitive[]
}

/** Read every saved view, in creation order. */
export function getSavedPagesViews(): SavedPagesView[] {
  return readPreference(PREFERENCES.savedPagesViews).views
}

/**
 * Save a new view under `name`, capturing `tuple` verbatim. Returns the
 * created view (its generated `id` is what callers pass to
 * {@link deleteSavedPagesView}). Single read-modify-write, like
 * `setStarred`'s bulk pattern.
 */
export function savePagesView(name: string, tuple: PagesViewTuple): SavedPagesView {
  const views = getSavedPagesViews()
  const view: SavedPagesView = {
    id: crypto.randomUUID(),
    name,
    createdAt: new Date().toISOString(),
    sort: tuple.sort,
    density: tuple.density,
    filters: tuple.filters,
  }
  writePreference(PREFERENCES.savedPagesViews, {
    schemaVersion: PREFERENCES.savedPagesViews.defaultValue.schemaVersion,
    views: [...views, view],
  })
  return view
}

/** Delete a saved view by id. No-op (still rewrites the unchanged array) if `id` isn't found. */
export function deleteSavedPagesView(id: string): void {
  const views = getSavedPagesViews()
  writePreference(PREFERENCES.savedPagesViews, {
    schemaVersion: PREFERENCES.savedPagesViews.defaultValue.schemaVersion,
    views: views.filter((v) => v.id !== id),
  })
}

/** Structural equality for two filter arrays — order-sensitive, `_addId`-stripped by the caller. */
function filtersEqual(a: FilterPrimitive[], b: FilterPrimitive[]): boolean {
  if (a.length !== b.length) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Structural equality between a saved view and a live `{ sort, density, filters }` tuple. */
export function viewMatchesTuple(view: SavedPagesView, tuple: PagesViewTuple): boolean {
  return (
    view.sort === tuple.sort &&
    view.density === tuple.density &&
    filtersEqual(view.filters, tuple.filters)
  )
}

/**
 * Find the saved view (if any) whose captured tuple structurally matches
 * `tuple`. Returns `null` when no saved view matches — this is the "no
 * active saved view" state, not an error.
 */
export function findMatchingSavedPagesView(
  views: SavedPagesView[],
  tuple: PagesViewTuple,
): SavedPagesView | null {
  return views.find((v) => viewMatchesTuple(v, tuple)) ?? null
}

/**
 * One-shot recovery signal: true when the raw `agaric:pages:savedViews:v1`
 * localStorage value exists AND parses as JSON AND carries a
 * `schemaVersion` that doesn't match the current registry entry — i.e. the
 * user had saved views from a future/incompatible app version that
 * `PREFERENCES.savedPagesViews.parse` silently discarded back to the empty
 * envelope.
 *
 * `parse`'s own "invalid data → defaultValue" failure discipline (see
 * `preferences.ts`'s module docstring) can't distinguish "discarded a
 * mismatched schema" from "nothing was ever stored" — both read back as the
 * empty envelope. This function reads the raw string independently
 * (bypassing `readPreference`/`parse`) to recover exactly that distinction.
 *
 * Callers MUST invoke this from a `useState` lazy initializer (i.e. during
 * the render phase), not from a `useEffect`: `useLocalStoragePreference`'s
 * own mount-effect write-back re-persists the parsed (now-empty) value in
 * the current schema, which would overwrite the mismatched raw value before
 * an effect-timed read could observe it. Render-phase lazy-init runs before
 * any effect in the tree, so the raw mismatched value is still on disk when
 * this reads it.
 *
 * A raw value that is simply missing, or present but not valid JSON, or
 * valid JSON with no `schemaVersion` field at all (pre-this-feature — can't
 * happen since this is a brand-new key, but handled defensively) is NOT a
 * mismatch — only a well-formed envelope whose `schemaVersion` disagrees
 * counts.
 */
export function peekSavedPagesViewsSchemaMismatch(): boolean {
  return peekPreferenceSchemaMismatch(
    PREFERENCES.savedPagesViews,
    PREFERENCES.savedPagesViews.defaultValue.schemaVersion,
  )
}
