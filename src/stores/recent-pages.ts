/**
 * Recent-pages store: the MRU behind the "Recently visited" strip,
 * SearchPanel, CommandPalette and the PageBrowser sort and grouping, the one
 * source of truth for recent pages (#1149). Visits come from the tabs store's
 * `navigateToPage`; a revisit moves the entry to the front with the new title.
 *
 * Visits are partitioned by space (`recentPagesBySpace`, `__legacy__` for no
 * space); the flat `recentPages` mirrors the active space. On hydration the
 * raw `recent_pages:<spaceId>` keys of the removed `lib/recent-pages.ts` are
 * merged in once and cleared (`migrateRawRecentPagesKeys`).
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import { safePersistStorage } from '@/lib/safe-persist-storage'
import { addDeviceBookmarks } from '@/lib/starred-pages'
import { activeSpaceKey } from '@/stores/active-space'
import { createPerSpaceSlice } from '@/stores/createPerSpaceSlice'
import { LEGACY_SPACE_KEY } from '@/stores/space'

/**
 * A recent-page entry. `visitedAt` (ISO) is stamped by `addRecentPage`;
 * `recordVisit` omits it, as array order is the recency signal.
 */
export interface PageRef {
  pageId: string
  title: string
  visitedAt?: string
}

/** The id-keyed view SearchPanel, CommandPalette and PageBrowser read. */
export interface RecentPage {
  id: string
  title: string
  visitedAt: string
}

/**
 * Visits retained. The strip shows a width-dependent subset, so a deeper list
 * keeps entries from vanishing when the viewport changes.
 */
const MAX_RETAINED = 10

/** Raw-localStorage key prefix of the removed `lib/recent-pages.ts`. */
const RAW_KEY_PREFIX = 'recent_pages'
/** Its single unscoped key, migrated into the `__legacy__` slot. */
const RAW_LEGACY_UNSCOPED_KEY = 'recent_pages'

interface RecentPagesState {
  /**
   * The active space's MRU, mirroring `recentPagesBySpace[currentSpaceId]`. Use
   * `selectRecentPagesForSpace` for per-space reads.
   */
  recentPages: PageRef[]
  /** Per-space MRU lists. Keyed by space id, with `__legacy__` for the no-space slice. */
  recentPagesBySpace: Record<string, PageRef[]>
  /** Persisted guard so the raw-key merge runs once per install. */
  rawKeysMerged: boolean
  recordVisit: (pageRef: PageRef) => void
  /** Add from a search or palette click: stamps `visitedAt`, dedups, caps. */
  addRecentPage: (id: string, title: string) => void
  /**
   * Retitle the active space's entry for `pageId` in place, keeping its
   * position (#3322). The entry is persisted, and a click on it re-stamps its
   * title onto the tab, so a stale one would outlive restarts. Prefer
   * `renamePage` in `@/stores/page-rename`.
   */
  renamePage: (pageId: string, title: string) => void
  /** Remove one entry; whether it was found. */
  removeRecentPage: (id: string) => boolean
  /** Clear the MRU list for the active space (does not affect other spaces). */
  clear: () => void
}

type RecentState = RecentPagesState

/**
 * Stable empty fallback for `selectRecentPagesForSpace`: a fresh `[]` per call
 * fails `Object.is` and re-renders every subscriber, up to "Maximum update
 * depth exceeded". Consumers treat it as read-only, hence the mutable cast.
 */
const EMPTY_PAGE_REFS: readonly PageRef[] = Object.freeze([])

function applyCap(pages: PageRef[]): PageRef[] {
  return pages.slice(0, MAX_RETAINED)
}

/**
 * The MRU for `spaceId`. A null space (pre-bootstrap) reads the flat mirror;
 * a real space with no slice reads empty, since the mirror may still hold
 * another space's list before the switch subscriber runs.
 */
export function selectRecentPagesForSpace(state: RecentState, spaceId: string | null): PageRef[] {
  if (spaceId == null) return state.recentPages
  return state.recentPagesBySpace[spaceId] ?? (EMPTY_PAGE_REFS as PageRef[])
}

/**
 * Non-reactive `RecentPage[]` read of the active space's slice (or
 * `spaceId`'s), for code outside React; components use the store with
 * `selectRecentPagesForSpace`.
 */
export function getRecentPagesForSpace(spaceId?: string | null): RecentPage[] {
  const state = useRecentPagesStore.getState()
  const key = spaceId === undefined ? activeSpaceKey() : (spaceId ?? LEGACY_SPACE_KEY)
  const slice = state.recentPagesBySpace[key] ?? []
  return applyCap(slice).map(toRecentPage)
}

/** Adapt a store `PageRef` to the id-keyed `RecentPage` view. */
export function toRecentPage(ref: PageRef): RecentPage {
  return {
    id: ref.pageId,
    title: ref.title,
    visitedAt: ref.visitedAt ?? '',
  }
}

/**
 * Merge the raw `recent_pages:<spaceId>` keys of the removed
 * `lib/recent-pages.ts` into `recentPagesBySpace` without losing either list
 * (#1149): the store's order wins for shared ids, raw-only ids follow, the
 * newer `visitedAt` is kept, and the unscoped key goes to `__legacy__`. The raw
 * keys are removed afterwards; `rawKeysMerged` guards a second run.
 */
export function migrateRawRecentPagesKeys(bySpace: Record<string, PageRef[]>): {
  bySpace: Record<string, PageRef[]>
  changed: boolean
} {
  let storage: Storage
  try {
    storage = localStorage
  } catch {
    // localStorage unavailable — nothing to migrate.
    return { bySpace, changed: false }
  }

  const rawKeys: string[] = []
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i)
      if (k == null) continue
      // `recent_pages:<spaceId>` per-space keys, or the bare unscoped key.
      if (k === RAW_LEGACY_UNSCOPED_KEY || k.startsWith(`${RAW_KEY_PREFIX}:`)) {
        rawKeys.push(k)
      }
    }
  } catch {
    return { bySpace, changed: false }
  }
  if (rawKeys.length === 0) return { bySpace, changed: false }

  const next: Record<string, PageRef[]> = { ...bySpace }
  let changed = false

  for (const rawKey of rawKeys) {
    const spaceKey =
      rawKey === RAW_LEGACY_UNSCOPED_KEY
        ? LEGACY_SPACE_KEY
        : rawKey.slice(RAW_KEY_PREFIX.length + 1)
    const rawEntries = parseRawRecentPages(storage.getItem(rawKey))
    if (rawEntries.length > 0) {
      next[spaceKey] = mergeSlices(next[spaceKey] ?? [], rawEntries)
      changed = true
    }
    try {
      storage.removeItem(rawKey)
    } catch {
      // Best-effort cleanup; the `rawKeysMerged` guard prevents a re-merge.
    }
  }

  return { bySpace: next, changed }
}

/**
 * Merge raw entries into a store slice: the store's order wins for shared ids,
 * raw-only ids follow, the newer `visitedAt` is kept.
 */
function mergeSlices(storeSlice: PageRef[], rawEntries: RawRecentPage[]): PageRef[] {
  const rawById = new Map(rawEntries.map((r) => [r.id, r]))
  const merged: PageRef[] = []
  const seen = new Set<string>()

  for (const ref of storeSlice) {
    const raw = rawById.get(ref.pageId)
    merged.push(mergeOne(ref, raw))
    seen.add(ref.pageId)
  }
  for (const raw of rawEntries) {
    if (seen.has(raw.id)) continue
    merged.push(rawToPageRef(raw))
    seen.add(raw.id)
  }
  return applyCap(merged)
}

/** A store entry with its optional raw twin; the newer `visitedAt` wins. */
function mergeOne(ref: PageRef, raw: RawRecentPage | undefined): PageRef {
  if (raw == null) return ref
  const visitedAt =
    ref.visitedAt != null && raw.visitedAt != null
      ? ref.visitedAt > raw.visitedAt
        ? ref.visitedAt
        : raw.visitedAt
      : (ref.visitedAt ?? raw.visitedAt)
  return {
    pageId: ref.pageId,
    title: ref.title,
    ...(visitedAt != null && { visitedAt }),
  }
}

function rawToPageRef(raw: RawRecentPage): PageRef {
  return {
    pageId: raw.id,
    title: raw.title,
    visitedAt: raw.visitedAt,
  }
}

/** The on-disk shape of the removed `lib/recent-pages.ts` entries. */
interface RawRecentPage {
  id: string
  title: string
  visitedAt: string
}

function isRawRecentPage(item: unknown): item is RawRecentPage {
  if (item === null || typeof item !== 'object') return false
  const r = item as Record<string, unknown>
  return (
    typeof r['id'] === 'string' &&
    typeof r['title'] === 'string' &&
    typeof r['visitedAt'] === 'string'
  )
}

function parseRawRecentPages(raw: string | null): RawRecentPage[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isRawRecentPage)
  } catch {
    return []
  }
}

/**
 * Coerce a persisted value into a valid `PageRef`, or `null`: `localStorage`
 * can hold anything, and a bare cast lets a malformed blob crash the reducers.
 * A `visitedAt` of the wrong type is dropped.
 */
function coercePageRef(raw: unknown): PageRef | null {
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as Record<string, unknown>
  if (typeof obj['pageId'] !== 'string' || typeof obj['title'] !== 'string') return null
  return {
    pageId: obj['pageId'],
    title: obj['title'],
    ...(typeof obj['visitedAt'] === 'string' && { visitedAt: obj['visitedAt'] }),
  }
}

/** Coerce a persisted value into a `PageRef[]`, dropping invalid entries. */
function coercePageRefList(raw: unknown): PageRef[] {
  if (!Array.isArray(raw)) return []
  const out: PageRef[] = []
  for (const item of raw) {
    const ref = coercePageRef(item)
    if (ref) out.push(ref)
  }
  return out
}

/** Coerce a persisted value into a `Record<string, PageRef[]>`, dropping malformed slices and entries. */
function coerceRecentPagesBySpace(raw: unknown): Record<string, PageRef[]> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, PageRef[]> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue
    out[key] = coercePageRefList(value)
  }
  return out
}

/**
 * The contents of every raw `recent_pages*` key still on this device, read
 * through a local `Storage` binding: foreign legacy keys, not app preferences
 * for the registry.
 */
function rawRecentPageLists(): unknown[][] {
  let storage: Storage
  try {
    storage = localStorage
  } catch {
    // localStorage unavailable — nothing to scan.
    return []
  }
  const out: unknown[][] = []
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)
      if (key == null) continue
      if (key !== RAW_LEGACY_UNSCOPED_KEY && !key.startsWith(`${RAW_KEY_PREFIX}:`)) continue
      const raw = storage.getItem(key)
      if (raw == null) continue
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) out.push(parsed)
    }
  } catch {
    // A corrupt entry or a throwing read: keep what was collected.
  }
  return out
}

/**
 * Fold legacy `pinned` recent-page rows into the device's old `starred-pages`
 * list, which `migrateDeviceBookmarks` moves onto the pages' `bookmark`
 * property once the spaces load. Coercion drops the flag, so without this an
 * upgrade loses every palette bookmark. Scans the store blob (`pageId`) and the
 * raw keys (`id`); adds only ids not already listed; a no-op once the flag is gone.
 */
function rescuePinnedAsBookmarks(persisted: unknown): boolean {
  const lists: unknown[] = []
  if (persisted != null && typeof persisted === 'object') {
    const blob = persisted as Record<string, unknown>
    lists.push(blob['recentPages'])
    const bySpace = blob['recentPagesBySpace']
    if (bySpace != null && typeof bySpace === 'object') {
      lists.push(...Object.values(bySpace as Record<string, unknown>))
    }
  }
  lists.push(...rawRecentPageLists())
  const pinned: string[] = []
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    for (const row of list) {
      if (row == null || typeof row !== 'object') continue
      const r = row as Record<string, unknown>
      if (r['pinned'] !== true) continue
      // The store blob keys the id `pageId`; the raw keys spell it `id`.
      const id = typeof r['pageId'] === 'string' ? r['pageId'] : r['id']
      if (typeof id === 'string') pinned.push(id)
    }
  }
  if (pinned.length === 0) return false
  addDeviceBookmarks(pinned)
  return true
}

/**
 * Handoff from `merge`/`migrate` to `onRehydrateStorage`, the only hook that
 * can force the write that strips the rescued flags from storage.
 */
let pinnedRescueNeedsPersist = false

/**
 * Coerce a whole persisted blob field by field (#1578). Both `migrate` and
 * `merge` call it: zustand runs `migrate` only on a version mismatch, so a
 * corrupt blob with the current version reaches `merge` raw. Idempotent. A v0
 * blob with only `recentPages` carries it into the `__legacy__` slot.
 */
function coercePersistedRecentPages(
  persisted: unknown,
): Pick<RecentState, 'recentPages' | 'recentPagesBySpace' | 'rawKeysMerged'> {
  const blob = (persisted != null && typeof persisted === 'object' ? persisted : {}) as Record<
    string,
    unknown
  >
  const recentPages = coercePageRefList(blob['recentPages'])
  const recentPagesBySpace =
    blob['recentPagesBySpace'] === undefined
      ? { [LEGACY_SPACE_KEY]: recentPages }
      : coerceRecentPagesBySpace(blob['recentPagesBySpace'])
  return {
    recentPages,
    recentPagesBySpace,
    rawKeysMerged: blob['rawKeysMerged'] === true,
  }
}

/**
 * Per-space slice of the MRU. A fresh space starts empty and is not seeded,
 * and only `__legacy__` seeds on first fire: after a rehydrate the flat mirror
 * may hold another space's list, so a real space's slice must never be seeded
 * from it.
 */
const recentPagesSlice = createPerSpaceSlice<RecentState, PageRef[]>({
  readMirror: (state) => state.recentPages,
  writeMirror: (value) => ({ recentPages: value }),
  getSlice: (state, key) => state.recentPagesBySpace[key],
  setSlice: (state, key, value) => ({
    recentPagesBySpace: { ...state.recentPagesBySpace, [key]: value },
  }),
  fallback: () => [],
  seedOnFirstFire: (key) => key === LEGACY_SPACE_KEY,
})

export const useRecentPagesStore = create<RecentPagesState>()(
  persist(
    (set, get) => ({
      recentPages: [],
      recentPagesBySpace: {},
      rawKeysMerged: false,
      recordVisit: (ref) => {
        const state = get()
        const key = activeSpaceKey()
        // Build from the space's own slice, never the flat mirror, which may
        // hold another space's list after a rehydrate.
        const current = state.recentPagesBySpace[key] ?? []
        const filtered = current.filter((p) => p.pageId !== ref.pageId)
        const nextEntry: PageRef = {
          pageId: ref.pageId,
          title: ref.title,
          ...(ref.visitedAt != null && { visitedAt: ref.visitedAt }),
        }
        const next = applyCap([nextEntry, ...filtered])
        set(recentPagesSlice.applyActive(state, next))
      },
      addRecentPage: (id, title) => {
        const state = get()
        const key = activeSpaceKey()
        const current = state.recentPagesBySpace[key] ?? []
        const filtered = current.filter((p) => p.pageId !== id)
        const nextEntry: PageRef = {
          pageId: id,
          title,
          visitedAt: new Date().toISOString(),
        }
        const next = applyCap([nextEntry, ...filtered])
        set(recentPagesSlice.applyActive(state, next))
      },
      renamePage: (pageId, title) => {
        const state = get()
        const key = activeSpaceKey()
        const current = state.recentPagesBySpace[key] ?? []
        // No-op unless the entry holds a stale title; never reorder.
        const idx = current.findIndex((p) => p.pageId === pageId)
        const entry = idx < 0 ? undefined : current[idx]
        if (entry === undefined || entry.title === title) return
        const updated: PageRef = { ...entry, title }
        const next = [...current.slice(0, idx), updated, ...current.slice(idx + 1)]
        set(recentPagesSlice.applyActive(state, next))
      },
      removeRecentPage: (id) => {
        const state = get()
        const key = activeSpaceKey()
        const current = state.recentPagesBySpace[key] ?? []
        const next = current.filter((p) => p.pageId !== id)
        if (next.length === current.length) return false
        set(recentPagesSlice.applyActive(state, next))
        return true
      },
      clear: () => {
        const state = get()
        set(recentPagesSlice.applyActive(state, []))
      },
    }),
    {
      name: 'agaric:recent-pages',
      version: 1,
      storage: safePersistStorage,
      partialize: (state) => ({
        recentPages: state.recentPages,
        recentPagesBySpace: state.recentPagesBySpace,
        rawKeysMerged: state.rawKeysMerged,
      }),
      // Both coerce: zustand calls `migrate` only on a version mismatch and
      // hands a same-version blob straight to `merge` (#1578).
      migrate: (persisted: unknown, _version: number) => {
        pinnedRescueNeedsPersist = rescuePinnedAsBookmarks(persisted) || pinnedRescueNeedsPersist
        return coercePersistedRecentPages(persisted)
      },
      merge: (persisted, current) => {
        pinnedRescueNeedsPersist = rescuePinnedAsBookmarks(persisted) || pinnedRescueNeedsPersist
        return { ...current, ...coercePersistedRecentPages(persisted) }
      },
      // Merge the raw keys once after rehydrate (#1149).
      onRehydrateStorage: () => (state) => {
        // Force one write after a rescue, before the raw-key early return,
        // which those same devices take: it persists the coerced rows without
        // the flag, so the rescue cannot resurrect a bookmark later removed.
        if (pinnedRescueNeedsPersist) {
          pinnedRescueNeedsPersist = false
          // Deferred: with synchronous storage this runs inside `create()`,
          // before `useRecentPagesStore` exists, and zustand swallows the
          // ReferenceError, so the rescue would repeat every boot.
          queueMicrotask(() => {
            useRecentPagesStore.setState({})
          })
        }
        if (state == null || state.rawKeysMerged) return
        const { bySpace, changed } = migrateRawRecentPagesKeys(state.recentPagesBySpace)
        const effectiveBySpace = changed ? bySpace : state.recentPagesBySpace
        const activeKey = activeSpaceKey()
        useRecentPagesStore.setState({
          recentPagesBySpace: effectiveBySpace,
          recentPages: effectiveBySpace[activeKey] ?? state.recentPages,
          rawKeysMerged: true,
        })
      },
    },
  ),
)

/**
 * The space-change reconcile, exported because its first-fire seed path runs
 * once at import and is otherwise unreachable from tests.
 */
export const reconcileRecentPagesOnSpaceChange = recentPagesSlice.attach(useRecentPagesStore)
