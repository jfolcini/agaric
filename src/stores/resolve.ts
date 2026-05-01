/**
 * Global resolve cache store — Zustand state for block/tag title resolution.
 *
 * Replaces the per-component ref-based cache that was in BlockTree.
 * Single source of truth for resolving block/tag ULIDs to display titles.
 * Preloaded once on app boot; updated incrementally as pages/tags are created.
 *
 * # FEAT-3p7 — Cache key encoding (cross-space link enforcement)
 *
 * The cache `Map` is keyed by **flat composite strings**:
 *
 *     `${spaceId}::${ulid}`
 *
 * where `spaceId` is the active space's ULID at write time, or the
 * `__GLOBAL_SPACE_ID` sentinel (`'__global__'`) when no space is active
 * (e.g. boot before `useSpaceStore` resolves, or test fixtures that
 * don't set up the space store).
 *
 * Why composite keys (instead of nested `Map<spaceId, Map<ulid, ...>>`)?
 *
 *   - `cache.get` / `cache.set` consumer ergonomics: callers compose the
 *     key with `keyFor(spaceId, ulid)` and use a single Map lookup.
 *   - `clearAllForSpace(prevSpaceId)` is a single linear scan that
 *     deletes any key with prefix `${prevSpaceId}::` — no nested-map
 *     bookkeeping.
 *
 * The locked-in policy (FEAT-3p7) is **no live links between spaces,
 * ever**. With ULID-only keys, a chip resolved in space A could be
 * served from cache when the user is in space B → silent cross-space
 * leak. Composite keys make that impossible at the cache layer; the
 * `clearAllForSpace` action complements that by flushing the previous
 * space's entries on switch so foreign chips render broken instead of
 * stale-resolving.
 */

import { create } from 'zustand'
import { logger } from '../lib/logger'
import { listBlocks, listTagsByPrefix } from '../lib/tauri'
import { useSpaceStore } from './space'

const MAX_CACHE_SIZE = 10_000
const MAX_PAGES_LIST_SIZE = 5_000

/**
 * Sentinel used when no current space is active (boot, test fixtures).
 * Tags are deliberately NOT stored under this sentinel — the spec
 * treats them as space-scoped just like pages, so a switch flushes
 * tag entries too and the next `preload(spaceId)` re-fetches them.
 */
export const GLOBAL_SPACE_ID = '__global__'

/** Compose the composite cache key for `(spaceId, ulid)`. */
export function keyFor(spaceId: string | null | undefined, id: string): string {
  return `${spaceId ?? GLOBAL_SPACE_ID}::${id}`
}

/** Read `currentSpaceId` from the space store, falling back to the
 *  global sentinel when the space store hasn't hydrated yet. */
function activeSpaceId(): string {
  return useSpaceStore.getState().currentSpaceId ?? GLOBAL_SPACE_ID
}

interface ResolveEntry {
  title: string
  deleted: boolean
}

interface ResolveStore {
  /** Composite key (`${spaceId}::${ulid}`) → { title, deleted } */
  cache: Map<string, ResolveEntry>
  /** Preloaded pages list for the [[ picker (current-space scoped). */
  pagesList: Array<{ id: string; title: string }>
  /** Bumped on cache updates to trigger re-renders */
  version: number
  /** Whether preload has been called at least once */
  _preloaded: boolean

  /**
   * Fetch all pages (in `spaceId`) + tags into the cache. Call once on
   * boot and again after sync.
   *
   * `spaceId` (FEAT-3p7) — narrows the page fetch to the active space
   * so only current-space pages enter the cache. Pass `null`/
   * `undefined` to skip the space filter (legacy behaviour). Tags are
   * fetched globally either way (the picker is space-scoped, but tag
   * resolution is not).
   *
   * `forceRefresh` is a semantic flag — fetched data always wins over
   * stale cache entries regardless. Kept for callsite intent
   * (post-sync vs initial boot).
   */
  preload: (spaceId?: string | null | undefined, forceRefresh?: boolean) => Promise<void>
  /** Add/update a single entry under the active space. */
  set: (id: string, title: string, deleted: boolean) => void
  /** Batch-add entries under the active space. */
  batchSet: (entries: Array<{ id: string; title: string; deleted: boolean }>) => void
  /** Resolve title under the active space, with fallback. */
  resolveTitle: (id: string) => string
  /** Resolve deleted status under the active space. */
  resolveStatus: (id: string) => 'active' | 'deleted'
  /**
   * Clear the short-query page-title search cache (`pagesList`) on
   * space switch so the link picker's `searchPagesViaCache` path can
   * no longer surface pages from the previous space. The composite
   * `cache` map is intentionally not touched here — that's
   * `clearAllForSpace`'s responsibility.
   * `version` is bumped so any memoised reads recompute.
   */
  clearPagesList: () => void
  /**
   * FEAT-3p7 — flush every cache entry whose composite key starts with
   * `${prevSpaceId}::`. Other spaces' entries (and the
   * `__global__::*` namespace, if anything ever lands there) survive.
   * Called from the App-level space-switch subscriber so foreign-space
   * chips fall through to the `[[ULID]]` fallback (which renders the
   * broken-link UX) instead of stale-resolving from the cache.
   */
  clearAllForSpace: (prevSpaceId: string) => void
}

export const useResolveStore = create<ResolveStore>((set, get) => {
  let pendingVersionBump = false

  return {
    cache: new Map(),
    pagesList: [],
    version: 0,
    _preloaded: false,

    preload: async (spaceId, _forceRefresh = false) => {
      const writeSpaceId = spaceId ?? GLOBAL_SPACE_ID
      try {
        // Fetch all pages with cursor-based pagination, scoped to the
        // active space when one was passed (FEAT-3p7).
        const pagesList: Array<{ id: string; title: string }> = []
        const fetchedPages = new Map<string, ResolveEntry>()
        let cursor: string | undefined
        let hasMore = true
        while (hasMore) {
          // FEAT-3 Phase 4 — `listBlocks` requires `spaceId`. The `?? ''`
          // fallback is intentional pre-bootstrap behaviour: empty
          // string forces a no-match SQL filter rather than a runtime
          // null deref.
          const pagesResp = await listBlocks({
            blockType: 'page',
            limit: 1000,
            cursor,
            spaceId: spaceId ?? '',
          })
          for (const p of pagesResp.items) {
            const title = p.content ?? 'Untitled'
            fetchedPages.set(keyFor(writeSpaceId, p.id), {
              title,
              deleted: p.deleted_at !== null,
            })
            pagesList.push({ id: p.id, title })
          }
          hasMore = pagesResp.has_more
          cursor = pagesResp.next_cursor ?? undefined
        }

        // Fetch all tags. Tags are not space-scoped on the wire (the
        // tag table is global), but we key them under `writeSpaceId`
        // so a `clearAllForSpace` flush wipes them too — the next
        // preload re-fetches them under the new space's prefix.
        const tags = await listTagsByPrefix({ prefix: '' })
        const fetchedTags = new Map<string, ResolveEntry>()
        for (const t of tags) {
          fetchedTags.set(keyFor(writeSpaceId, t.tag_id), {
            title: t.name,
            deleted: false,
          })
        }

        // Merge: fetched data always wins over stale cache entries.
        // Both branches use the same order — forceRefresh is a semantic
        // flag for callers, not a behavioral switch.
        set((state) => {
          const cache = new Map([...state.cache, ...fetchedPages, ...fetchedTags])
          const fetchedIds = new Set(pagesList.map((p) => p.id))
          const mergedPagesList = [
            ...pagesList,
            ...state.pagesList.filter((p) => !fetchedIds.has(p.id)),
          ]
          return {
            cache,
            pagesList: mergedPagesList,
            version: state.version + 1,
            _preloaded: true,
          }
        })
      } catch (err) {
        logger.warn('ResolveStore', 'preload failed, using fallback', {}, err)
        set({ _preloaded: true })
      }
    },

    set: (id, title, deleted) => {
      const spaceId = activeSpaceId()
      const compositeKey = keyFor(spaceId, id)
      set((state) => {
        const cache = new Map(state.cache)
        cache.set(compositeKey, { title, deleted })
        if (cache.size > MAX_CACHE_SIZE) {
          // Delete oldest entries (first N entries in Map iteration order)
          const excess = cache.size - MAX_CACHE_SIZE
          const keys = cache.keys()
          for (let i = 0; i < excess; i++) {
            const { value } = keys.next()
            if (value) cache.delete(value)
          }
        }
        // Also update pagesList if it's a new non-deleted entry
        // (pages created via onCreatePage should appear in picker).
        // pagesList is keyed by raw ULID — only one space's pages
        // should be present at a time (cleared on switch via
        // `clearPagesList`).
        const existsInPagesList = state.pagesList.some((p) => p.id === id)
        let pagesList = existsInPagesList ? state.pagesList : [...state.pagesList, { id, title }]
        if (pagesList.length > MAX_PAGES_LIST_SIZE) {
          pagesList = pagesList.slice(-MAX_PAGES_LIST_SIZE)
        }
        return { cache, pagesList }
      })
      // Debounce version bump via microtask to avoid re-render storms
      if (!pendingVersionBump) {
        pendingVersionBump = true
        queueMicrotask(() => {
          set((s) => ({ version: s.version + 1 }))
          pendingVersionBump = false
        })
      }
    },

    batchSet: (entries) => {
      if (entries.length === 0) return
      const spaceId = activeSpaceId()
      set((state) => {
        const cache = new Map(state.cache)
        for (const e of entries) {
          cache.set(keyFor(spaceId, e.id), {
            title: e.title,
            deleted: e.deleted,
          })
        }
        if (cache.size > MAX_CACHE_SIZE) {
          // Delete oldest entries (first N entries in Map iteration order)
          const excess = cache.size - MAX_CACHE_SIZE
          const keys = cache.keys()
          for (let i = 0; i < excess; i++) {
            const { value } = keys.next()
            if (value) cache.delete(value)
          }
        }
        return { cache, version: state.version + 1 }
      })
    },

    resolveTitle: (id) => {
      const cached = get().cache.get(keyFor(activeSpaceId(), id))
      if (cached) return cached.title
      return `[[${id.slice(0, 8)}...]]`
    },

    resolveStatus: (id) => {
      const cached = get().cache.get(keyFor(activeSpaceId(), id))
      if (cached) return cached.deleted ? 'deleted' : 'active'
      return 'active'
    },

    clearPagesList: () => set((state) => ({ pagesList: [], version: state.version + 1 })),

    clearAllForSpace: (prevSpaceId) =>
      set((state) => {
        const prefix = `${prevSpaceId}::`
        const cache = new Map(state.cache)
        for (const key of cache.keys()) {
          if (key.startsWith(prefix)) cache.delete(key)
        }
        return { cache, version: state.version + 1 }
      }),
  }
})
