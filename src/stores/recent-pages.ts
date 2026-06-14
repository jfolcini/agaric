/**
 * Recent-pages store — Zustand state for the desktop-only "Recently visited"
 * strip (FEAT-9) AND the unified recent-pages MRU consumed by SearchPanel,
 * CommandPalette, and the PageBrowser sort/grouping (#1149).
 *
 * Tracks up to `MAX_RETAINED` recent page visits in MRU order. Visits are
 * recorded by `useNavigationStore.navigateToPage`, the single entry point
 * for page navigation. Re-visiting the same pageId moves the existing entry
 * to the front (MRU dedup) and uses the new title, so stored titles always
 * reflect the most recent navigation.
 *
 * FEAT-3 Phase 3 — visits are partitioned by space. `recentPagesBySpace`
 * holds one MRU list per space id (with `__legacy__` for the no-space
 * slice); the flat `recentPages` field mirrors the active-space slice so
 * existing reads (and the `currentSpaceId == null` boot path) keep working
 * without forcing every consumer to thread the space id through.
 *
 * #1149 — this store is now the single source of truth for recent-pages.
 * It used to coexist with `src/lib/recent-pages.ts` (raw-localStorage,
 * sync API) which independently tracked visits under `recent_pages:<spaceId>`
 * keys; a visit recorded in one was invisible to the other's ordering. The
 * lib's superset of features is folded in here:
 *   - pinning (`togglePinRecentPage`, pin-first ordering, pin-exempt cap),
 *   - single-entry removal (`removeRecentPage`), and
 *   - the imperative `addRecentPage(id, title)` entry point used by the
 *     search/palette click handlers.
 * On hydration a one-time migration merges any pre-existing
 * `recent_pages:<spaceId>` raw keys into `recentPagesBySpace` (see
 * `migrateRawRecentPagesKeys`) and clears them so the merge doesn't repeat.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import { activeSpaceKey } from '../lib/active-space'
import { createSpaceSubscriber } from '../lib/createSpaceSubscriber'
import { LEGACY_SPACE_KEY } from './space'

/**
 * A recent-page entry. `pageId` + `title` are always present; `visitedAt`
 * and `pinned` are folded in from the former `lib/recent-pages.ts`
 * `RecentPage` (#1149):
 *   - `visitedAt` (ISO string) is stamped by `addRecentPage`; the
 *     navigation-recorded `recordVisit` path omits it (the MRU array order
 *     is the recency signal those consumers rely on), so it is optional.
 *   - `pinned` entries sort first (in pin order) and are exempt from the
 *     `MAX_RETAINED` eviction. Omitted when false so unpinned entries stay
 *     minimal (and the legacy `recordVisit` round-trip shape is unchanged).
 */
export interface PageRef {
  pageId: string
  title: string
  visitedAt?: string
  pinned?: boolean
}

/**
 * #1149 — the shape the former `lib/recent-pages.ts` exposed to
 * SearchPanel / CommandPalette / PageBrowser. Kept as a thin id-keyed
 * view over the store's `PageRef` so those consumers' `.id` / `.visitedAt`
 * / `.pinned` reads survive the migration without a sweeping rename.
 */
export interface RecentPage {
  id: string
  title: string
  visitedAt: string
  pinned?: boolean
}

/**
 * How many recent visits are retained in the store. The UI renders a
 * responsive subset via CSS grid (`auto-fit` minmax(120px, 180px)) but keeps
 * a deeper list in memory so viewport width changes don't surprise the user
 * with vanished entries.
 *
 * Matches the former `lib/recent-pages.ts` `MAX_RECENT` so the consolidated
 * eviction cap is unchanged (#1149).
 */
const MAX_RETAINED = 10

/** Raw-localStorage key prefix used by the now-removed `lib/recent-pages.ts`. */
const RAW_KEY_PREFIX = 'recent_pages'
/** Pre-FEAT-3 single unscoped raw key (migrated into the `__legacy__` slot). */
const RAW_LEGACY_UNSCOPED_KEY = 'recent_pages'

interface RecentPagesState {
  /**
   * Active-space MRU list — mirrors `recentPagesBySpace[currentSpaceId]`
   * after every `recordVisit`. Kept top-level so legacy reads work without
   * threading the space id; use `selectRecentPagesForSpace` for per-space
   * reads.
   */
  recentPages: PageRef[]
  /** Per-space MRU lists. Keyed by space id, with `__legacy__` for the no-space slice. */
  recentPagesBySpace: Record<string, PageRef[]>
  /**
   * #1149 — one-time guard so the `recent_pages:<spaceId>` raw-key merge
   * (`migrateRawRecentPagesKeys`) runs at most once across the store's
   * persisted lifetime. Persisted alongside the MRU so a second session
   * doesn't re-merge already-cleared keys.
   */
  rawKeysMerged: boolean
  recordVisit: (pageRef: PageRef) => void
  /**
   * #1149 — imperative add (search-result / palette click). Stamps a fresh
   * `visitedAt`, dedups by id, preserves an existing entry's pinned flag,
   * and applies the pin-exempt MAX_RETAINED cap.
   */
  addRecentPage: (id: string, title: string) => void
  /**
   * #1149 — remove a single entry (any partition). Pin status does not block
   * removal. Returns true if the id was found and removed.
   */
  removeRecentPage: (id: string) => boolean
  /**
   * #1149 — toggle pinned state. Pinning preserves `visitedAt`; unpinning
   * re-stamps it to now so the entry's MRU position reflects the unpin
   * moment. Returns the new pinned state, or null if the id was not found.
   */
  togglePinRecentPage: (id: string) => boolean | null
  /** Clear the MRU list for the active space (does not affect other spaces). */
  clear: () => void
}

type RecentState = RecentPagesState

/**
 * Stable empty fallback used by `selectRecentPagesForSpace`. Returning a
 * fresh `[]` from a zustand selector each call retriggers every
 * `useSyncExternalStore` consumer (Object.is equality), which compounded
 * into a `Maximum update depth exceeded` in App-level tests. Keep the
 * reference stable so the selector is idempotent.
 *
 * Cast to mutable `PageRef[]` at the consumer boundary is safe — the
 * selector contract is read-only; every consumer treats the returned
 * array as immutable. We don't widen the public return type to
 * `readonly PageRef[]` to avoid a TS ripple across every consumer
 * (`QuickAccessBar`, `App.tsx`, tests).
 */
const EMPTY_PAGE_REFS: readonly PageRef[] = Object.freeze([])

/**
 * Pin-first ordering + pin-exempt MAX_RETAINED cap (folded in from the
 * former `lib/recent-pages.ts` `writeRecentPages`). Pinned entries are kept
 * first in their stored order and are never evicted; the unpinned partition
 * is MRU-ordered and capped at `MAX_RETAINED`.
 */
function applyPinFirstCap(pages: PageRef[]): PageRef[] {
  const pinned = pages.filter((p) => p.pinned === true)
  const unpinned = pages.filter((p) => p.pinned !== true).slice(0, MAX_RETAINED)
  return [...pinned, ...unpinned]
}

/**
 * Per-space MRU selector. Pass `currentSpaceId` from `useSpaceStore`.
 *
 * Reads the per-space slice keyed by `spaceId`. When `spaceId` is null
 * (pre-bootstrap), falls back to the flat `recentPages` mirror so the
 * boot path still renders something. For a real space with no slice
 * yet, returns the shared empty array — the flat field may still hold
 * a different space's mirror if the space-switch subscriber hasn't run,
 * so falling back to it would leak cross-space entries into the strip.
 */
export function selectRecentPagesForSpace(state: RecentState, spaceId: string | null): PageRef[] {
  if (spaceId == null) return state.recentPages
  return state.recentPagesBySpace[spaceId] ?? (EMPTY_PAGE_REFS as PageRef[])
}

/**
 * #1149 — non-reactive snapshot read for the `RecentPage`-shaped consumers
 * (PageBrowser sort/grouping, and the SearchPanel/CommandPalette mount-time
 * seed). Returns the active-space slice (or the slice for `spaceId` when
 * given) as `RecentPage[]`, pin-first sorted. Reads `getState()` so it works
 * outside React (plain comparator helpers) as well as inside hooks.
 *
 * Prefer the reactive `useRecentPagesStore` + `selectRecentPagesForSpace`
 * in components; this is for code paths that need a one-shot read.
 */
export function getRecentPagesForSpace(spaceId?: string | null): RecentPage[] {
  const state = useRecentPagesStore.getState()
  const key = spaceId === undefined ? activeSpaceKey() : (spaceId ?? LEGACY_SPACE_KEY)
  const slice = state.recentPagesBySpace[key] ?? []
  return applyPinFirstCap(slice).map(toRecentPage)
}

/** Adapt a store `PageRef` to the id-keyed `RecentPage` view. */
export function toRecentPage(ref: PageRef): RecentPage {
  return {
    id: ref.pageId,
    title: ref.title,
    visitedAt: ref.visitedAt ?? '',
    ...(ref.pinned === true && { pinned: true }),
  }
}

/**
 * #1149 — one-time merge of the pre-#1149 raw `recent_pages:<spaceId>`
 * localStorage keys (written by the removed `lib/recent-pages.ts`) into the
 * store's `recentPagesBySpace`, merging WITHOUT losing either MRU set:
 *
 *  - Entries present only in the raw key are appended after the store's
 *    existing slice (the store's recency wins for shared ids).
 *  - A shared id keeps the store entry but inherits `pinned: true` if it
 *    was pinned in EITHER source, and keeps the newer `visitedAt`.
 *  - The merged slice is pin-first sorted and pin-exempt capped.
 *
 * The pre-FEAT-3 unscoped `recent_pages` key (if present) is folded into the
 * `__legacy__` slot. After a successful merge the raw keys are removed so a
 * later hydrate can't re-merge stale data; the persisted `rawKeysMerged`
 * guard is the belt-and-braces second line of defence.
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

  // Collect raw keys first so we don't mutate the store under iteration.
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
 * Merge a raw `RecentPage[]` (id-keyed) into a store `PageRef[]` slice
 * (pageId-keyed), preserving recency order + pins. The store slice's order
 * wins for shared ids (it is the canonical recency signal); raw-only ids are
 * appended after. Pins union; the newer `visitedAt` is kept.
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
  return applyPinFirstCap(merged)
}

/** Combine a store entry with its optional raw twin (pins union, newer visitedAt wins). */
function mergeOne(ref: PageRef, raw: RawRecentPage | undefined): PageRef {
  if (raw == null) return ref
  const pinned = ref.pinned === true || raw.pinned === true
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
    ...(pinned && { pinned: true }),
  }
}

function rawToPageRef(raw: RawRecentPage): PageRef {
  return {
    pageId: raw.id,
    title: raw.title,
    visitedAt: raw.visitedAt,
    ...(raw.pinned === true && { pinned: true }),
  }
}

/** The on-disk shape of the removed `lib/recent-pages.ts` entries. */
interface RawRecentPage {
  id: string
  title: string
  visitedAt: string
  pinned?: boolean
}

function isRawRecentPage(item: unknown): item is RawRecentPage {
  if (item === null || typeof item !== 'object') return false
  const r = item as Record<string, unknown>
  if (
    typeof r['id'] !== 'string' ||
    typeof r['title'] !== 'string' ||
    typeof r['visitedAt'] !== 'string'
  ) {
    return false
  }
  return r['pinned'] === undefined || typeof r['pinned'] === 'boolean'
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

export const useRecentPagesStore = create<RecentPagesState>()(
  persist(
    (set, get) => ({
      recentPages: [],
      recentPagesBySpace: {},
      rawKeysMerged: false,
      recordVisit: (ref) => {
        const state = get()
        const key = activeSpaceKey()
        // PEND-78: build the next MRU from the active space's OWN slice — the
        // single source of truth. Reading the flat mirror here was the
        // write-time corruption path: a stale flat field (another space's
        // list, e.g. after rehydrate) would be copied into this space's slice
        // and durably persisted.
        const current = state.recentPagesBySpace[key] ?? []
        const existing = current.find((p) => p.pageId === ref.pageId)
        const filtered = current.filter((p) => p.pageId !== ref.pageId)
        // #1149 — re-visiting a pinned page keeps it pinned (mirrors the
        // former lib's `addRecentPage` pinned-preservation). The
        // navigation-recorded path stores only `{pageId, title}` (+ pinned
        // when carried) — no `visitedAt`, since the array order is the
        // recency signal these consumers read.
        const nextEntry: PageRef = {
          pageId: ref.pageId,
          title: ref.title,
          ...(ref.visitedAt != null && { visitedAt: ref.visitedAt }),
          ...((ref.pinned === true || existing?.pinned === true) && { pinned: true }),
        }
        const next = applyPinFirstCap([nextEntry, ...filtered])
        set({
          recentPages: next,
          recentPagesBySpace: { ...state.recentPagesBySpace, [key]: next },
        })
      },
      addRecentPage: (id, title) => {
        const state = get()
        const key = activeSpaceKey()
        const current = state.recentPagesBySpace[key] ?? []
        const existing = current.find((p) => p.pageId === id)
        const filtered = current.filter((p) => p.pageId !== id)
        const nextEntry: PageRef = {
          pageId: id,
          title,
          visitedAt: new Date().toISOString(),
          ...(existing?.pinned === true && { pinned: true }),
        }
        const next = applyPinFirstCap([nextEntry, ...filtered])
        set({
          recentPages: next,
          recentPagesBySpace: { ...state.recentPagesBySpace, [key]: next },
        })
      },
      removeRecentPage: (id) => {
        const state = get()
        const key = activeSpaceKey()
        const current = state.recentPagesBySpace[key] ?? []
        const next = current.filter((p) => p.pageId !== id)
        if (next.length === current.length) return false
        set({
          recentPages: next,
          recentPagesBySpace: { ...state.recentPagesBySpace, [key]: next },
        })
        return true
      },
      togglePinRecentPage: (id) => {
        const state = get()
        const key = activeSpaceKey()
        const current = state.recentPagesBySpace[key] ?? []
        const idx = current.findIndex((p) => p.pageId === id)
        if (idx < 0) return null
        const entry = current[idx]
        if (entry == null) return null
        const wasPinned = entry.pinned === true
        // Pinning preserves `visitedAt`; unpinning re-stamps to now so the
        // entry slots at the top of the unpinned partition (mirrors the
        // former lib's `togglePinRecentPage`).
        const nextVisitedAt = wasPinned ? new Date().toISOString() : entry.visitedAt
        const updated: PageRef = {
          pageId: entry.pageId,
          title: entry.title,
          ...(nextVisitedAt != null && { visitedAt: nextVisitedAt }),
          ...(!wasPinned && { pinned: true }),
        }
        const reordered = [...current.slice(0, idx), updated, ...current.slice(idx + 1)]
        const next = applyPinFirstCap(reordered)
        set({
          recentPages: next,
          recentPagesBySpace: { ...state.recentPagesBySpace, [key]: next },
        })
        return !wasPinned
      },
      clear: () => {
        const state = get()
        const key = activeSpaceKey()
        set({
          recentPages: [],
          recentPagesBySpace: { ...state.recentPagesBySpace, [key]: [] },
        })
      },
    }),
    {
      name: 'agaric:recent-pages',
      version: 1,
      partialize: (state) => ({
        recentPages: state.recentPages,
        recentPagesBySpace: state.recentPagesBySpace,
        rawKeysMerged: state.rawKeysMerged,
      }),
      migrate: (persisted: unknown, version: number) => {
        // v0 → v1: pre-FEAT-3p3 stored only `recentPages`. Carry that flat
        // list into the `__legacy__` per-space slot so consumers that pass
        // `currentSpaceId = null` still see the user's history and the
        // per-space map gains a non-empty seed.
        if (version >= 1) return persisted as RecentState
        if (persisted == null || typeof persisted !== 'object') return persisted as RecentState
        const old = persisted as Partial<RecentState> & { recentPages?: PageRef[] }
        const recentPages = Array.isArray(old.recentPages) ? old.recentPages : []
        return {
          ...old,
          recentPages,
          recentPagesBySpace: old.recentPagesBySpace ?? { [LEGACY_SPACE_KEY]: recentPages },
        } as RecentState
      },
      // #1149 — after rehydrate, one-time merge the raw `recent_pages:*`
      // localStorage keys (written by the removed `lib/recent-pages.ts`) into
      // `recentPagesBySpace`, then clear them. Guarded by `rawKeysMerged` so
      // it runs at most once across the persisted lifetime.
      onRehydrateStorage: () => (state) => {
        if (state == null || state.rawKeysMerged) return
        const { bySpace, changed } = migrateRawRecentPagesKeys(state.recentPagesBySpace)
        const effectiveBySpace = changed ? bySpace : state.recentPagesBySpace
        const activeKey = activeSpaceKey()
        useRecentPagesStore.setState({
          recentPagesBySpace: effectiveBySpace,
          // Reconcile the flat mirror to the active space's (possibly merged)
          // slice so the boot read reflects the merge.
          recentPages: effectiveBySpace[activeKey] ?? state.recentPages,
          rawKeysMerged: true,
        })
      },
    },
  ),
)

/**
 * Flush the outgoing space's slice and pull the incoming space's slice into
 * the flat `recentPages` mirror on a space change. On first fire
 * (`prevKey === newKey`) it (a) seeds the legacy slot from the rehydrated
 * flat list for the v0→v1 path, then (b) reconciles the flat mirror to the
 * active space's slice — PEND-78 Defect 2: on rehydrate the flat field may
 * hold a *different* space's list (whichever was active when persistence
 * last ran), and leaving it stale leaks that list through the flat-field
 * read paths.
 *
 * MAINT-122: subscription mechanics + diff detection live in
 * `createSpaceSubscriber`; this callback owns only the recent-pages
 * flush/pull/reconcile. Exported because the module-level subscriber fires
 * its first-fire (seed) path once at import, so that path is otherwise
 * unreachable from the test runtime.
 */
export function reconcileRecentPagesOnSpaceChange(prevKey: string, newKey: string): void {
  const recentState = useRecentPagesStore.getState()
  if (prevKey === newKey) {
    if (
      newKey === LEGACY_SPACE_KEY &&
      recentState.recentPagesBySpace[newKey] === undefined &&
      recentState.recentPages.length > 0
    ) {
      useRecentPagesStore.setState({
        recentPagesBySpace: {
          ...recentState.recentPagesBySpace,
          [newKey]: recentState.recentPages,
        },
      })
      return
    }
    const slice = recentState.recentPagesBySpace[newKey] ?? []
    if (slice !== recentState.recentPages) {
      useRecentPagesStore.setState({ recentPages: slice })
    }
    return
  }
  const flushedBySpace = {
    ...recentState.recentPagesBySpace,
    [prevKey]: recentState.recentPages,
  }
  const next = recentState.recentPagesBySpace[newKey] ?? []
  useRecentPagesStore.setState({
    recentPages: next,
    recentPagesBySpace: flushedBySpace,
  })
}

createSpaceSubscriber(reconcileRecentPagesOnSpaceChange)
