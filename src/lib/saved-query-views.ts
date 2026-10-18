/**
 * Advanced Query saved views (#5738): named query specs kept per space on this
 * device, in `PREFERENCES.savedQueryViews`. Each writer is one
 * read-modify-write; `writePreference` broadcasts it, so a mounted
 * `usePreference` of the same space re-reads.
 */

import {
  PREFERENCES,
  readPreference,
  type SavedQueryView,
  writePreference,
} from '@/lib/preferences'

/** Save `spec` (the JSON of a `SavedQuerySpec`) as a new view named `name`. */
export function saveQueryView(spaceId: string, name: string, spec: string): SavedQueryView {
  const view: SavedQueryView = { id: crypto.randomUUID(), name, spec }
  const views = readPreference(PREFERENCES.savedQueryViews, spaceId)
  writePreference(PREFERENCES.savedQueryViews, [...views, view], spaceId)
  return view
}

export function renameSavedQueryView(spaceId: string, id: string, name: string): void {
  // `readPreference` parses a fresh list, so renaming in place is safe.
  const views = readPreference(PREFERENCES.savedQueryViews, spaceId)
  const view = views.find((v) => v.id === id)
  if (view) view.name = name
  writePreference(PREFERENCES.savedQueryViews, views, spaceId)
}

export function deleteSavedQueryView(spaceId: string, id: string): void {
  const views = readPreference(PREFERENCES.savedQueryViews, spaceId)
  writePreference(
    PREFERENCES.savedQueryViews,
    views.filter((v) => v.id !== id),
    spaceId,
  )
}
