/**
 * Saved views — each one a page in its space carrying the internal
 * `saved_view` property (#6544), so views sync between devices and a deleted
 * one waits in the Trash.
 *
 * The page title is the view's name. The property's `value_text` is `v1:`
 * followed by the base64url JSON of the payload: the Pages view's `{ sort,
 * filters }`, or an Advanced Query `SavedQuerySpec` (validated by
 * `parseQuerySpec` when the view loads, because `lib/` may not import a
 * store). Base64url keeps the value one plain token in exported front matter.
 * The page body stays empty.
 *
 * A view's name is refused when a live page or another view of the space holds
 * it: `create_page_in_space` answers an existing title with that page, which
 * the save would then stamp.
 *
 * Both lists (the Pages view's, Advanced Query's) read one TanStack query per
 * space. Every write here re-reads it; a change that arrives some other way (a
 * sync, an undo, a restore from the Trash) re-reads it through
 * `invalidateNameCaches`, which `invalidateDerivedCaches` calls.
 *
 * Saved views used to be per-device localStorage lists;
 * `migrateDeviceSavedViews` moves them into pages once.
 */

import { unwrap, validationCode } from '@/lib/app-error'
import { base64UrlToUtf8, utf8ToBase64Url } from '@/lib/base64url'
import { commands, type FilterPrimitive } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { subscribeToNameChanges } from '@/lib/name-change-bus'
import { nameKey } from '@/lib/name-tokens'
import { loadPagesWithProperty } from '@/lib/pages-with-property'
import {
  isFilterPrimitiveLike,
  PREFERENCES,
  readPreference,
  readSort,
  removePreference,
  type SortOption,
} from '@/lib/preferences'
import { queryClient } from '@/lib/query-client'
import { dropOtherSpacesTagChips } from '@/lib/saved-pages-views'
import { ValidationCode } from '@/lib/search-query/validation-codes'
import { requireActiveScope } from '@/lib/space-scope'

const SAVED_VIEW_PROPERTY_KEY = 'saved_view'
const PAYLOAD_PREFIX = 'v1:'

export type SavedViewPayload =
  | { kind: 'pages'; sort: SortOption; filters: FilterPrimitive[] }
  | { kind: 'query'; spec: unknown }

export interface SavedView {
  /** The view page's id. */
  id: string
  name: string
  payload: SavedViewPayload
}

const SAVED_VIEWS_QUERY_ROOT = 'savedViews'

export function savedViewsQueryKey(spaceId: string): readonly [string, string] {
  return [SAVED_VIEWS_QUERY_ROOT, spaceId]
}

function invalidateSavedViews(): void {
  void queryClient.invalidateQueries({ queryKey: [SAVED_VIEWS_QUERY_ROOT] })
}

subscribeToNameChanges((change) => {
  if (change.kind === 'invalidated') invalidateSavedViews()
})

export function encodeSavedView(payload: SavedViewPayload): string {
  return PAYLOAD_PREFIX + utf8ToBase64Url(JSON.stringify(payload))
}

function readPayload(value: unknown): SavedViewPayload | null {
  if (value === null || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (v['kind'] === 'query') {
    const spec = v['spec']
    return spec !== null && typeof spec === 'object' ? { kind: 'query', spec } : null
  }
  if (v['kind'] !== 'pages') return null
  const sort = readSort(v['sort'])
  const filters = v['filters']
  if (sort === undefined || !Array.isArray(filters) || !filters.every(isFilterPrimitiveLike)) {
    return null
  }
  return { kind: 'pages', sort, filters }
}

/** The payload a `saved_view` value holds; `null` for a value this version cannot read. */
export function decodeSavedView(value: string | null): SavedViewPayload | null {
  if (value === null || !value.startsWith(PAYLOAD_PREFIX)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(base64UrlToUtf8(value.slice(PAYLOAD_PREFIX.length), { fatal: true }))
  } catch {
    // Not base64url, not UTF-8 or not JSON: an unreadable value, like a wrong shape.
    return null
  }
  return readPayload(parsed)
}

/** The live saved views of `spaceId`, oldest first. A view whose value cannot be read is left out. */
export async function loadSavedViews(spaceId: string): Promise<SavedView[]> {
  const views: SavedView[] = []
  for (const { id, title, row } of await loadPagesWithProperty(spaceId, SAVED_VIEW_PROPERTY_KEY)) {
    const payload = decodeSavedView(row.value_text)
    if (payload === null) {
      logger.warn('saved-views', 'skipped a saved view whose value cannot be read', { id })
      continue
    }
    views.push({ id, name: title, payload })
  }
  return views
}

/** The name keys the live pages and views of `spaceId` hold, but `exceptId`'s. */
async function takenNames(spaceId: string, exceptId: string | null): Promise<Set<string>> {
  const pages = unwrap(await commands.listAllPagesInSpace(requireActiveScope(spaceId), null))
  const views = await loadSavedViews(spaceId)
  const names = [
    ...pages.map((page) => ({ id: page.id, name: page.content })),
    ...views.map((view) => ({ id: view.id, name: view.name })),
  ]
  return new Set(
    names.flatMap(({ id, name }) => (id === exceptId || name === null ? [] : [nameKey(name)])),
  )
}

async function createViewPage(
  spaceId: string,
  name: string,
  payload: SavedViewPayload,
): Promise<SavedView> {
  const id = unwrap(await commands.createPageInSpace(null, name, spaceId))
  try {
    unwrap(
      await commands.setProperty(id, SAVED_VIEW_PROPERTY_KEY, {
        value_text: encodeSavedView(payload),
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
      }),
    )
  } catch (err) {
    // Without its property the page would be a plain empty page in every list.
    unwrap(await commands.deleteBlock(id))
    throw err
  }
  return { id, name, payload }
}

/** Save `payload` as a view named `name` in `spaceId`; `null` when the name is taken there. */
export async function saveView(
  spaceId: string,
  name: string,
  payload: SavedViewPayload,
): Promise<SavedView | null> {
  if ((await takenNames(spaceId, null)).has(nameKey(name))) return null
  const view = await createViewPage(spaceId, name, payload)
  invalidateSavedViews()
  return view
}

/** Rename view `id` of `spaceId`; `false` when the name is taken there. */
export async function renameSavedView(spaceId: string, id: string, name: string): Promise<boolean> {
  if ((await takenNames(spaceId, id)).has(nameKey(name))) return false
  try {
    unwrap(await commands.editBlock(id, name))
  } catch (err) {
    // An alias another page holds, or a title that arrived since the check.
    if (validationCode(err) === ValidationCode.DuplicatePageTitle) return false
    throw err
  }
  invalidateSavedViews()
  return true
}

/** Move view `id` to the Trash; resolves to the stamp {@link restoreSavedView} takes. */
export async function deleteSavedView(id: string): Promise<number> {
  const { deleted_at } = unwrap(await commands.deleteBlock(id))
  invalidateSavedViews()
  return deleted_at
}

export async function restoreSavedView(id: string, deletedAt: number): Promise<void> {
  unwrap(await commands.restoreBlock(id, deletedAt))
  invalidateSavedViews()
}

/** `name`, or `name (2)`, `name (3)`, … whichever `taken` does not hold. */
function freeName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(nameKey(name))) return name
  for (let n = 2; ; n++) {
    const candidate = `${name} (${n})`
    if (!taken.has(nameKey(candidate))) return candidate
  }
}

/**
 * Land `views` in `spaceId`, skipping a view whose payload a view of the space
 * already carries (a retry, or the same view from a device that moved first)
 * and suffixing a name another page or view holds.
 */
async function landViews(
  spaceId: string,
  views: ReadonlyArray<{ name: string; payload: SavedViewPayload }>,
): Promise<void> {
  const taken = await takenNames(spaceId, null)
  const landed = new Set((await loadSavedViews(spaceId)).map((v) => encodeSavedView(v.payload)))
  for (const { name, payload } of views) {
    const encoded = encodeSavedView(payload)
    if (landed.has(encoded)) continue
    const free = freeName(name, taken)
    await createViewPage(spaceId, free, payload)
    taken.add(nameKey(free))
    landed.add(encoded)
  }
}

/** A legacy spec JSON as a payload; `null` for one that never parsed, which never loaded either. */
function queryPayload(spec: string): SavedViewPayload | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(spec)
  } catch {
    return null
  }
  return readPayload({ kind: 'query', spec: parsed })
}

/**
 * Move this device's localStorage saved views into view pages, once. The
 * Pages-view list was one for every space, so each live space gets a copy, less
 * the tag chips of other spaces; each space's Advanced Query list goes to that
 * space. Lists of deleted spaces stay behind. A key is removed once all its
 * views have landed; a failure keeps it, so the next boot retries without
 * duplicates.
 */
export async function migrateDeviceSavedViews(spaceIds: readonly string[]): Promise<void> {
  const pagesViews = readPreference(PREFERENCES.savedPagesViews).views
  if (pagesViews.length > 0) {
    try {
      for (const spaceId of spaceIds) {
        const views = []
        for (const view of pagesViews) {
          const filters = await dropOtherSpacesTagChips(view.filters, spaceId)
          views.push({
            name: view.name,
            payload: { kind: 'pages' as const, sort: view.sort, filters },
          })
        }
        await landViews(spaceId, views)
      }
      removePreference(PREFERENCES.savedPagesViews)
    } catch (err) {
      logger.warn(
        'saved-views',
        'moving the Pages saved views failed; retrying next boot',
        undefined,
        err,
      )
    }
  }
  for (const spaceId of spaceIds) {
    const queryViews = readPreference(PREFERENCES.savedQueryViews, spaceId)
    if (queryViews.length === 0) continue
    try {
      await landViews(
        spaceId,
        queryViews.flatMap((view) => {
          const payload = queryPayload(view.spec)
          if (payload !== null) return [{ name: view.name, payload }]
          logger.warn('saved-views', 'dropped a saved query that never parsed', { spaceId })
          return []
        }),
      )
      removePreference(PREFERENCES.savedQueryViews, spaceId)
    } catch (err) {
      logger.warn(
        'saved-views',
        'moving the Advanced Query saved views failed; retrying next boot',
        { spaceId },
        err,
      )
    }
  }
  invalidateSavedViews()
}
