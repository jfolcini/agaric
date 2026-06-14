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
import { listBlocks, listBlocksLimit, listTagsByPrefix } from '../lib/tauri'
import { useSpaceStore } from './space'

const MAX_CACHE_SIZE = 10_000

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

/**
 * Delete oldest entries (first N entries in Map iteration order) until
 * `cache.size <= maxSize`. Mutates `cache` in place. No-op when already
 * within budget. Pure helper — only touches the passed Map.
 */
function evictOldest<K, V>(cache: Map<K, V>, maxSize: number): void {
  if (cache.size <= maxSize) return
  const excess = cache.size - maxSize
  const toEvict = Array.from(cache.keys()).slice(0, excess)
  for (const key of toEvict) cache.delete(key)
}

interface ResolveEntry {
  title: string
  deleted: boolean
}

interface ResolveStore {
  /** Composite key (`${spaceId}::${ulid}`) → { title, deleted } */
  cache: Map<string, ResolveEntry>
  /** Bumped on cache updates to trigger re-renders */
  version: number
  /** Whether preload has been called at least once */
  _preloaded: boolean

  /**
   * Fetch all pages (in `spaceId`) + tags into the cache. Call once on
   * boot and again after sync.
   *
   * `spaceId` (FEAT-3p7) — narrows the page fetch to the active space
   * so only current-space pages enter the cache. FE-H-22 — passing
   * `null`/`undefined` is now a silent no-op: callers must wait for
   * the space store to hydrate before invoking preload, otherwise
   * the IPC is skipped entirely (fail closed on cross-space leaks).
   *
   * `forceRefresh` distinguishes callsite intent (post-sync vs initial
   * boot) AND drives the in-flight coalescing policy (#753): concurrent
   * preloads for the same space join the in-flight scan; a `forceRefresh`
   * call additionally schedules exactly ONE trailing re-scan after the
   * in-flight one settles (the in-flight snapshot may predate the data
   * the force caller — e.g. `sync:complete` — wants picked up). Fetched
   * data always wins over stale cache entries regardless of the flag.
   */
  preload: (spaceId?: string | null | undefined, forceRefresh?: boolean) => Promise<void>
  /** Add/update a single entry under the active space. */
  set: (id: string, title: string, deleted: boolean) => void
  /**
   * Batch-add entries under the active space. Entries already cached
   * with an identical `{ title, deleted }` are skipped; when EVERY
   * entry is unchanged the call is a no-op — no Map clone, no
   * `version` bump (#753: batchSet fires per picker keystroke with
   * mostly-cached rows, and an unconditional bump re-renders every
   * version-subscribed block row).
   */
  batchSet: (entries: Array<{ id: string; title: string; deleted: boolean }>) => void
  /** Resolve title under the active space, with fallback. */
  resolveTitle: (id: string) => string
  /** Resolve deleted status under the active space. */
  resolveStatus: (id: string) => 'active' | 'deleted'
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
  /**
   * #753 — in-flight preload coalescing. Boot (`useAppSpaceLifecycle`)
   * and `sync:complete` (`useSyncEvents`) can both fire `preload` for
   * the same space within the same tick window; without coalescing each
   * call runs its own full pages+tags scan. Keyed by `spaceId` so a
   * space-switch preload never joins the previous space's scan.
   * `trailingForce` records that at least one `forceRefresh` caller
   * arrived while a scan was in flight — exactly one re-scan runs after
   * the current one settles, so post-sync data is still picked up.
   */
  const inflightPreloads = new Map<string, { promise: Promise<void>; trailingForce: boolean }>()

  /** One full pages+tags scan for `spaceId`. Never rejects (logs instead). */
  async function runPreloadScan(spaceId: string): Promise<void> {
    try {
      // Fetch all pages with cursor-based pagination, scoped to the
      // active space (FEAT-3p7).
      const fetchedPages = new Map<string, ResolveEntry>()
      let cursor: string | undefined
      let hasMore = true
      while (hasMore) {
        const pagesResp = await listBlocks({
          blockType: 'page',
          limit: listBlocksLimit(100),
          cursor,
          spaceId,
        })
        for (const p of pagesResp.items) {
          fetchedPages.set(keyFor(spaceId, p.id), {
            title: p.content ?? 'Untitled',
            deleted: p.deleted_at !== null,
          })
        }
        hasMore = pagesResp.has_more
        cursor = pagesResp.next_cursor ?? undefined
      }

      // Fetch all tags. Tags are not space-scoped on the wire (the
      // tag table is global), but we key them under `spaceId` so a
      // `clearAllForSpace` flush wipes them too — the next preload
      // re-fetches them under the new space's prefix.
      const tags = await listTagsByPrefix({ prefix: '' })
      const fetchedTags = new Map<string, ResolveEntry>()
      for (const t of tags) {
        fetchedTags.set(keyFor(spaceId, t.tag_id), {
          title: t.name,
          deleted: false,
        })
      }

      // Merge: fetched data always wins over stale cache entries.
      set((state) => ({
        cache: new Map([...state.cache, ...fetchedPages, ...fetchedTags]),
        version: state.version + 1,
        _preloaded: true,
      }))
    } catch (err) {
      logger.warn('ResolveStore', 'preload failed, using fallback', {}, err)
    }
  }

  return {
    cache: new Map(),
    version: 0,
    _preloaded: false,

    preload: (spaceId, forceRefresh = false) => {
      // FE-H-22 — fail closed during pre-bootstrap. Earlier we forwarded
      // `spaceId ?? ''` to `listBlocks` and relied on the backend
      // treating `''` as a no-match SQL filter. That contract is
      // unwritten; a backend change to interpret `''` as wildcard would
      // silently leak cross-space pages through the resolve cache. The
      // cross-space barrier is the most-protected invariant — skip the
      // fetch entirely until the space store hydrates and a real
      // `spaceId` is threaded through.
      if (spaceId == null) return Promise.resolve()

      // #753 — coalesce concurrent preloads of the same space. A plain
      // call joins the in-flight scan; a forceRefresh call additionally
      // schedules ONE trailing re-scan (see `inflightPreloads` doc).
      const inflight = inflightPreloads.get(spaceId)
      if (inflight) {
        if (forceRefresh) inflight.trailingForce = true
        return inflight.promise
      }

      const entry = { promise: Promise.resolve(), trailingForce: false }
      entry.promise = (async () => {
        try {
          await runPreloadScan(spaceId)
          while (entry.trailingForce) {
            entry.trailingForce = false
            await runPreloadScan(spaceId)
          }
        } finally {
          // Runs synchronously with the body's completion — before any
          // joiner's `await` continuation — so a late caller can never
          // observe (and mark trailingForce on) a finished entry.
          if (inflightPreloads.get(spaceId) === entry) inflightPreloads.delete(spaceId)
        }
      })()
      inflightPreloads.set(spaceId, entry)
      return entry.promise
    },

    // FE-H-21 — `set` and `batchSet` both bump `version` inline so the
    // re-render policy is symmetric across single and batch writers.
    // (Earlier behaviour debounced `set` via a microtask + closure flag,
    // which left an asymmetric contract — `batchSet` always bumped, `set`
    // sometimes coalesced. Inline is simpler and consistent.)
    set: (id, title, deleted) => {
      const spaceId = activeSpaceId()
      const compositeKey = keyFor(spaceId, id)
      // #1073 — diff before cloning, mirroring batchSet's #753 guard. `set`
      // fires on tag create/delete/rename (TagList) and trash restore
      // (TrashView); idempotent restores/renames re-write the identical
      // `{ title, deleted }` for a key already in the cache. Cloning the
      // full Map and bumping `version` for a no-op change re-renders every
      // version-subscribed block row for zero gain. Skip when unchanged.
      const cached = get().cache.get(compositeKey)
      if (cached && cached.title === title && cached.deleted === deleted) return
      set((state) => {
        const cache = new Map(state.cache)
        cache.set(compositeKey, { title, deleted })
        evictOldest(cache, MAX_CACHE_SIZE)
        return { cache, version: state.version + 1 }
      })
    },

    batchSet: (entries) => {
      if (entries.length === 0) return
      const spaceId = activeSpaceId()
      // #753 — diff before cloning. batchSet fires per picker keystroke
      // (BlockTree batchResolve) with mostly already-cached rows; when
      // nothing actually changed, cloning the full 10k-entry Map and
      // bumping `version` re-renders every version-subscribed block row
      // for zero gain. Only the changed subset is written.
      const current = get().cache
      const changed = entries.filter((e) => {
        const cached = current.get(keyFor(spaceId, e.id))
        return !cached || cached.title !== e.title || cached.deleted !== e.deleted
      })
      if (changed.length === 0) return
      set((state) => {
        const cache = new Map(state.cache)
        for (const e of changed) {
          cache.set(keyFor(spaceId, e.id), {
            title: e.title,
            deleted: e.deleted,
          })
        }
        evictOldest(cache, MAX_CACHE_SIZE)
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
