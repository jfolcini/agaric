/**
 * Resolve cache: block and tag ULIDs to display titles, preloaded per space
 * and updated as pages and tags change.
 *
 * Keys are `${spaceId}::${ulid}` (`keyFor`), with `GLOBAL_SPACE_ID` when no
 * space is active. There are no live links between spaces: a chip resolved in
 * space A must never be served in space B, and `clearAllForSpace` flushes the
 * previous space on a switch so foreign chips render broken, not stale. A flat
 * composite key keeps that flush a prefix scan.
 */

import { create } from 'zustand'

import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { resolveStoreTitle, unresolvedBlockLabel } from '@/lib/block-title'
import { logger } from '@/lib/logger'
import { requireActiveScope } from '@/lib/space-scope'
import { migrateTagColors } from '@/lib/tag-colors'
import { useSpaceStore } from '@/stores/space'

const MAX_CACHE_SIZE = 10_000

/**
 * The backend's `batch_resolve` cap (`MAX_BATCH_BLOCK_IDS` in
 * `src-tauri/agaric-store/src/pagination/mod.rs`). Past it a targeted preload
 * falls back to the full scan, which is always a superset (#3321).
 */
const TARGETED_PRELOAD_MAX_IDS = 1000

/**
 * Key space when no space is active (boot, test fixtures). Tags are space-scoped
 * like pages and never stored here, so a switch flushes them too.
 */
export const GLOBAL_SPACE_ID = '__global__'

/** Compose the composite cache key for `(spaceId, ulid)`. */
export function keyFor(spaceId: string | null | undefined, id: string): string {
  return `${spaceId ?? GLOBAL_SPACE_ID}::${id}`
}

/** `currentSpaceId`, or the global sentinel before the space store hydrates. */
function activeSpaceId(): string {
  return useSpaceStore.getState().currentSpaceId ?? GLOBAL_SPACE_ID
}

/**
 * Evict least-recently-used entries until `cache.size <= maxSize`. Insertion
 * order is recency: writers and `touch` move an accessed key to the tail.
 */
function evictLeastRecentlyUsed<K, V>(cache: Map<K, V>, maxSize: number): void {
  if (cache.size <= maxSize) return
  let excess = cache.size - maxSize
  // Delete the first `excess` keys straight off the iterator, without copying
  // the keys (#2041); deleting at or before the cursor is safe.
  for (const key of cache.keys()) {
    if (excess <= 0) break
    cache.delete(key)
    excess--
  }
}

/**
 * Move `key` to the tail for LRU recency. Same Map, no `version` bump, so a
 * read triggers no re-render.
 */
function touch<K, V>(cache: Map<K, V>, key: K, value: V): void {
  cache.delete(key)
  cache.set(key, value)
}

/** The entry `fetchAndCacheLinks` writes for a target the backend did not return. */
function unresolvedEntry(id: string): ResolveEntry {
  return { title: unresolvedBlockLabel(id), deleted: true, resolved: false }
}

/**
 * `pageHalfFailed` separates a page-half failure, worth escalating a targeted
 * scan to the full one, from a tag-half failure, which the full scan repeats.
 */
interface PreloadScanResult {
  applied: boolean
  pageHalfFailed: boolean
}

interface ResolveEntry {
  /**
   * What to show for this id. Every seed writer runs it through
   * `resolveStoreTitle`, blank content included, so two writers reaching the
   * same row write the same bytes and the setters' no-op diff holds (#4238).
   */
  title: string
  deleted: boolean
  /**
   * Whether the backend returned a row for this id; the title never doubles as
   * the miss signal (#4238). `false` is written for an id not in the space: an
   * unreturned link target (`fetchAndCacheLinks`), a page that moved out
   * (`markMovedOut`), a cached id a preload no longer gets back (#5289).
   *
   * The setters default it to `true` because a writer that could not resolve
   * an id writes nothing: an absent key already renders the unresolved label.
   * It still reads `'active'` (not asked yet), while `resolved: false` reads
   * `'deleted'` (asked, nothing came back); only a writer parking a sentinel
   * to suppress re-fetches passes `false`. A second such writer should get a
   * named store operation rather than copy the flag.
   *
   * Not foldable into `deleted`: `batch_resolve` returns soft-deleted blocks
   * with their real title.
   */
  resolved: boolean
}

interface ResolveStore {
  /** Composite key (`${spaceId}::${ulid}`) to entry. */
  cache: Map<string, ResolveEntry>
  /** Bumped on cache updates; consumers re-render off it, not the Map reference. */
  version: number
  /** Whether preload has been called at least once */
  _preloaded: boolean
  /**
   * Tag id → the tag's synced `color` property (#6544), re-read on every
   * preload. A tag chip paints this, else its localStorage colour.
   */
  tagColors: Readonly<Record<string, string>>
  /** Record a `color` property write that committed; `null` after a delete. */
  setSyncedTagColor: (tagId: string, color: string | null) => void

  /**
   * Fetch the space's pages and tags into the cache, on boot and after sync.
   * A null `spaceId` is a no-op: fail closed before the space store hydrates.
   *
   * Concurrent preloads of one space join the scan in flight (#753); a
   * `forceRefresh` caller also schedules one trailing re-scan, since the scan
   * in flight may predate its data. `changedPageIds` (#3321) narrows the page
   * half to one `batchResolve` of those ids plus the cached blocks no full scan
   * named (#5245); the tag half always runs, as tags carry no changed-id
   * signal. Absent, empty or oversize sets take the full scan.
   */
  preload: (
    spaceId?: string | null,
    forceRefresh?: boolean,
    changedPageIds?: ReadonlySet<string>,
  ) => Promise<void>
  /**
   * Add or update one entry under the active space. `resolved` defaults to
   * `true`: a caller holds a title, and one without a row writes nothing
   * (see {@link ResolveEntry.resolved}).
   */
  set: (id: string, title: string, deleted: boolean, resolved?: boolean) => void
  /**
   * Batch-add entries under the active space, skipping unchanged ones; when
   * nothing changed there is no `version` bump, as it fires per picker
   * keystroke (#753). `resolved` defaults to `true`.
   */
  batchSet: (
    entries: Array<{ id: string; title: string; deleted: boolean; resolved?: boolean }>,
  ) => void
  /**
   * The display title under the active space; a `resolved: false` entry gets
   * {@link unresolvedBlockLabel}, as an absent key does.
   */
  resolveTitle: (id: string) => string
  /**
   * `'deleted'` when the entry is soft-deleted or `resolved: false` (a broken
   * target, #4515); `'active'` otherwise, an absent key included, since its
   * real title is about to land.
   */
  resolveStatus: (id: string) => 'active' | 'deleted'
  /**
   * Whether an entry for `id` exists under the active space, a sentinel
   * included; a pure probe (no LRU touch, no re-render). Lets a consumer apply
   * its own fallback without writing it into the shared cache (#2635).
   */
  has: (id: string) => boolean
  /**
   * Whether `id` has a real resolution (`resolved: true`): the display
   * question, where {@link ResolveStore.has} answers whether to re-fetch.
   */
  isResolved: (id: string) => boolean
  /**
   * Flush every entry keyed under `prevSpaceId`, so foreign-space chips fall
   * through to the broken-link fallback instead of stale-resolving.
   */
  clearAllForSpace: (prevSpaceId: string) => void
  /**
   * Flag the cached entries of `ids` under `spaceId` deleted after a delete
   * commits (#5246); uncached ids read the backend's verdict on first resolve.
   */
  markDeleted: (spaceId: string | null, ids: readonly string[]) => void
  /**
   * After pages move out of `spaceId`, make their cached entries unresolved,
   * as for any other-space target, so chips render broken rather than
   * "(deleted)" under the old title (#5248). Uncached ids are skipped.
   */
  markMovedOut: (spaceId: string | null, ids: readonly string[]) => void
  /**
   * Re-title, and mark live, the cached entries of blocks the caller holds
   * loaded, so a chip follows its target's edits and undeletes (#5245).
   */
  refreshCachedBlocks: (
    blocks: ReadonlyArray<{ id: string; block_type: string; content: string | null }>,
  ) => void
  /**
   * Re-resolve every entry cached as deleted under `spaceId`, after a restore
   * whose full cohort the caller cannot name (#5246). Never rejects.
   */
  refreshDeleted: (spaceId: string | null) => Promise<void>
}

/**
 * One in-flight preload scan and the one trailing re-scan it may owe.
 * `trailingIds` is the re-scan's page-id set, or `null` for a full scan;
 * meaningful only while `trailingForce`.
 */
interface PreloadEntry {
  promise: Promise<void>
  currentFull: boolean
  trailingForce: boolean
  trailingIds: Set<string> | null
}

/** The ids for a targeted rescan, or `null` for the full scan (absent, empty, oversize). */
function narrowToTargetedIds(changedPageIds: ReadonlySet<string> | undefined): string[] | null {
  if (changedPageIds === undefined || changedPageIds.size === 0) return null
  if (changedPageIds.size > TARGETED_PRELOAD_MAX_IDS) return null
  return [...changedPageIds]
}

/**
 * Fold a mid-scan caller's demand into the one trailing re-scan. Widening only:
 * targeted sets merge, and any full demand makes it full for good, so a
 * targeted scan never swallows a broader request (#3321).
 */
function foldIntoTrailing(
  entry: PreloadEntry,
  changedPageIds: ReadonlySet<string> | undefined,
): void {
  const wantsFull = changedPageIds === undefined || changedPageIds.size === 0
  if (!entry.trailingForce) {
    entry.trailingForce = true
    entry.trailingIds = wantsFull ? null : new Set(changedPageIds)
    return
  }
  if (entry.trailingIds === null) return // already full; it subsumes any set
  if (wantsFull) {
    entry.trailingIds = null
    return
  }
  for (const id of changedPageIds) entry.trailingIds.add(id)
}

export const useResolveStore = create<ResolveStore>((set, get) => {
  /**
   * In-flight preload per space (#753): boot and `sync:complete` can both
   * preload one space in the same tick. Keyed by space so a switch never
   * joins the previous space's scan.
   */
  const inflightPreloads = new Map<string, PreloadEntry>()

  /**
   * Per space, the page ids the last full scan listed plus the tag ids the
   * last tag list returned (#5245). Any other cached entry (a content block, a
   * trashed page) is one a page-id rescan cannot name, so scans re-resolve
   * those alongside (#5289).
   */
  const namedIds = new Map<string, Set<string>>()

  /** Per space, the tag ids the last tag list returned (#5289). */
  const listedTagIds = new Map<string, Set<string>>()

  /** Ids cached under `spaceId` that `keep` accepts, most recently written last, at most `max`. */
  function cachedIds(
    spaceId: string,
    max: number,
    keep: (id: string, entry: ResolveEntry) => boolean,
  ): string[] {
    const prefix = `${spaceId}::`
    const ids: string[] = []
    for (const [key, entry] of get().cache) {
      if (!key.startsWith(prefix)) continue
      const id = key.slice(prefix.length)
      if (keep(id, entry)) ids.push(id)
    }
    return max > 0 ? ids.slice(-max) : []
  }

  /**
   * `batchResolve` `ids` into `into`. An id cached as resolved that does not
   * come back (purged, moved out) gets the unresolved entry, so its chip
   * renders broken instead of live (#5289).
   */
  async function batchResolveInto(
    spaceId: string,
    ids: string[],
    into: Map<string, ResolveEntry>,
  ): Promise<void> {
    const returned = new Set<string>()
    for (const resolved of unwrap(
      await commands.batchResolve(ids, { kind: 'active', space_id: spaceId }),
    )) {
      returned.add(resolved.id)
      into.set(keyFor(spaceId, resolved.id), {
        // Keyed on the row's own type: the batch also carries cached content
        // blocks, whose chips show a first line.
        title: resolveStoreTitle(resolved.block_type, resolved.title),
        deleted: resolved.deleted,
        resolved: true,
      })
    }
    const cache = get().cache
    for (const id of ids) {
      if (returned.has(id) || cache.get(keyFor(spaceId, id))?.resolved !== true) continue
      into.set(keyFor(spaceId, id), unresolvedEntry(id))
    }
  }

  /**
   * The page half of a scan, into `into`: `targetedIds` re-resolves those ids
   * plus the cached entries no full scan named; null lists the whole space.
   */
  async function scanPages(
    spaceId: string,
    targetedIds: string[] | null,
    into: Map<string, ResolveEntry>,
  ): Promise<void> {
    if (targetedIds) {
      // `batch_resolve` is space-scoped like the listing and returns
      // soft-deleted rows as deleted, so a remotely trashed page shows deleted.
      const targeted = new Set(targetedIds)
      const known = namedIds.get(spaceId)
      const cachedBlockIds = cachedIds(
        spaceId,
        TARGETED_PRELOAD_MAX_IDS - targetedIds.length,
        (id, entry) => entry.resolved && !targeted.has(id) && known?.has(id) !== true,
      )
      await batchResolveInto(spaceId, [...targetedIds, ...cachedBlockIds], into)
      return
    }
    const pages = unwrap(await commands.listAllPagesInSpace(requireActiveScope(spaceId), null))
    for (const p of pages) {
      into.set(keyFor(spaceId, p.id), {
        // The listing returns live pages only.
        title: resolveStoreTitle('page', p.content),
        deleted: false,
        resolved: true,
      })
    }
    namedIds.set(spaceId, new Set(pages.map((p) => p.id)))
  }

  /** Replace `tagColors` with the `color` properties of `tagIds`; a failed read keeps the last. */
  async function refreshTagColors(spaceId: string, tagIds: string[]): Promise<void> {
    const colors: Record<string, string> = {}
    try {
      for (let i = 0; i < tagIds.length; i += TARGETED_PRELOAD_MAX_IDS) {
        const chunk = tagIds.slice(i, i + TARGETED_PRELOAD_MAX_IDS)
        const props = unwrap(await commands.getBatchProperties(chunk))
        for (const [tagId, rows] of Object.entries(props)) {
          const color = rows.find((r) => r.key === 'color')?.value_text
          if (color) colors[tagId] = color
        }
      }
    } catch (err) {
      logger.warn('ResolveStore', 'failed to read tag colours', { spaceId }, err)
      return
    }
    const next = migrateTagColors(colors).colors
    const prev = get().tagColors
    const same =
      Object.keys(prev).length === Object.keys(next).length &&
      Object.entries(next).every(([id, color]) => prev[id] === color)
    if (!same) set({ tagColors: next })
  }

  /**
   * One pages-and-tags scan for `spaceId`; `targetedIds` as in `scanPages`.
   * Never rejects; `applied: false` when it threw and applied nothing.
   */
  async function runPreloadScan(
    spaceId: string,
    targetedIds: string[] | null,
  ): Promise<PreloadScanResult> {
    let pageHalfSucceeded = false
    try {
      const fetchedPages = new Map<string, ResolveEntry>()
      // `listAllTagsInSpace` is the no-limit IPC (#1343). Tags are keyed under
      // the space so a `clearAllForSpace` flush wipes them too.
      const [pageHalf, tagHalf] = await Promise.allSettled([
        scanPages(spaceId, targetedIds, fetchedPages),
        commands.listAllTagsInSpace(requireActiveScope(spaceId)).then(unwrap),
      ])
      // Each half settles on its own, so the escalation below knows which
      // failed; either failure aborts the scan.
      if (pageHalf.status === 'rejected') throw pageHalf.reason
      pageHalfSucceeded = true
      if (tagHalf.status === 'rejected') throw tagHalf.reason
      const tags = tagHalf.value
      await refreshTagColors(
        spaceId,
        tags.map((t) => t.tag_id),
      )

      const fetchedTags = new Map<string, ResolveEntry>()
      const named = namedIds.get(spaceId) ?? new Set<string>()
      namedIds.set(spaceId, named)
      for (const t of tags) {
        named.add(t.tag_id)
        fetchedTags.set(keyFor(spaceId, t.tag_id), {
          title: resolveStoreTitle('tag', t.name),
          deleted: false,
          resolved: true,
        })
      }

      // The lists name live rows only, so a cached entry they no longer name
      // (trashed, purged or moved out, or a content block) is re-resolved
      // (#5289). A targeted scan lists no pages, so for it that is the tags
      // that dropped out of the list.
      const freshTagIds = new Set(tags.map((t) => t.tag_id))
      const droppedTagIds = new Set(
        [...(listedTagIds.get(spaceId) ?? [])].filter((id) => !freshTagIds.has(id)),
      )
      listedTagIds.set(spaceId, freshTagIds)
      for (const id of droppedTagIds) named.delete(id)
      const stale = cachedIds(
        spaceId,
        TARGETED_PRELOAD_MAX_IDS,
        targetedIds === null
          ? (id, entry) => entry.resolved && !named.has(id)
          : (id, entry) => entry.resolved && droppedTagIds.has(id),
      )
      if (stale.length > 0) await batchResolveInto(spaceId, stale, fetchedPages)

      // Fetched data wins. Mutate the Map in place (#2267): consumers re-render
      // off `version`, not the Map reference. Diff first (#3321): this runs on
      // every sync and MCP change, most of which change no title, and a
      // `version` bump re-parses every mounted row's markdown.
      const cache = get().cache
      let mutated = false
      const mergeFetched = (key: string, value: ResolveEntry): void => {
        const cached = cache.get(key)
        if (
          cached !== undefined &&
          cached.title === value.title &&
          cached.deleted === value.deleted &&
          cached.resolved === value.resolved
        )
          return
        cache.set(key, value)
        mutated = true
      }
      for (const [k, v] of fetchedPages) mergeFetched(k, v)
      for (const [k, v] of fetchedTags) mergeFetched(k, v)
      // Only a full scan may claim `_preloaded`: a targeted one says nothing
      // about the rest of the space.
      const fullScan = targetedIds === null
      if (!mutated) {
        // Still flip `_preloaded`, or an empty space would retry forever.
        if (fullScan && !get()._preloaded) set({ _preloaded: true })
        return { applied: true, pageHalfFailed: false }
      }
      // Evicted entries are re-resolved on demand.
      evictLeastRecentlyUsed(cache, MAX_CACHE_SIZE)
      set((state) => ({
        cache,
        version: state.version + 1,
        _preloaded: state._preloaded || fullScan,
      }))
      return { applied: true, pageHalfFailed: false }
    } catch (err) {
      logger.warn('ResolveStore', 'preload failed, using fallback', {}, err)
      return { applied: false, pageHalfFailed: !pageHalfSucceeded }
    }
  }

  return {
    cache: new Map(),
    version: 0,
    _preloaded: false,
    tagColors: {},

    setSyncedTagColor: (tagId, color) =>
      set((state) => {
        const tagColors = { ...state.tagColors }
        if (color === null) delete tagColors[tagId]
        else tagColors[tagId] = color
        return { tagColors }
      }),

    preload: (spaceId, forceRefresh = false, changedPageIds) => {
      // Fail closed before the space store hydrates: the cross-space barrier
      // must not rest on how the backend reads an empty id.
      if (spaceId == null) return Promise.resolve()

      const inflight = inflightPreloads.get(spaceId)
      if (inflight) {
        if (forceRefresh) {
          foldIntoTrailing(inflight, changedPageIds)
        } else if (!inflight.currentFull) {
          // A plain caller wants the whole space warmed, not a targeted scan.
          foldIntoTrailing(inflight, undefined)
        }
        return inflight.promise
      }

      const leadingIds = narrowToTargetedIds(changedPageIds)
      const entry: PreloadEntry = {
        promise: Promise.resolve(),
        currentFull: leadingIds === null,
        trailingForce: false,
        trailingIds: null,
      }
      entry.promise = (async () => {
        try {
          // A targeted scan's ids are the only thing that would re-resolve
          // those pages, so one that throws escalates to one full scan; a
          // failing full scan does not escalate again (#3321).
          let scanIds = leadingIds
          let result = await runPreloadScan(spaceId, scanIds)
          // Only a page-half failure escalates; the full scan would repeat a
          // tag failure.
          if (result.pageHalfFailed && scanIds !== null) foldIntoTrailing(entry, undefined)
          while (entry.trailingForce) {
            scanIds = narrowToTargetedIds(entry.trailingIds ?? undefined)
            entry.currentFull = scanIds === null
            entry.trailingForce = false
            entry.trailingIds = null
            result = await runPreloadScan(spaceId, scanIds)
            if (result.pageHalfFailed && scanIds !== null) foldIntoTrailing(entry, undefined)
          }
        } finally {
          // `finally` runs before any joiner's continuation, so a late caller
          // cannot mark `trailingForce` on a finished entry.
          if (inflightPreloads.get(spaceId) === entry) inflightPreloads.delete(spaceId)
        }
      })()
      inflightPreloads.set(spaceId, entry)
      return entry.promise
    },

    set: (id, title, deleted, resolved = true) => {
      const spaceId = activeSpaceId()
      const compositeKey = keyFor(spaceId, id)
      // A no-op write (idempotent restore or rename) must not bump `version`
      // and re-render every row (#1073).
      const cached = get().cache.get(compositeKey)
      if (
        cached &&
        cached.title === title &&
        cached.deleted === deleted &&
        cached.resolved === resolved
      )
        return
      // In place, as `runPreloadScan` merges (#2267).
      set((state) => {
        const cache = state.cache
        touch(cache, compositeKey, { title, deleted, resolved })
        evictLeastRecentlyUsed(cache, MAX_CACHE_SIZE)
        return { cache, version: state.version + 1 }
      })
    },

    batchSet: (entries) => {
      if (entries.length === 0) return
      const spaceId = activeSpaceId()
      // Fires per picker keystroke with mostly cached rows: write only the
      // changed subset, and nothing at all when none changed (#753).
      const current = get().cache
      const changed = entries.filter((e) => {
        const cached = current.get(keyFor(spaceId, e.id))
        return (
          !cached ||
          cached.title !== e.title ||
          cached.deleted !== e.deleted ||
          cached.resolved !== (e.resolved ?? true)
        )
      })
      if (changed.length === 0) return
      set((state) => {
        const cache = state.cache
        for (const e of changed) {
          touch(cache, keyFor(spaceId, e.id), {
            title: e.title,
            deleted: e.deleted,
            resolved: e.resolved ?? true,
          })
        }
        evictLeastRecentlyUsed(cache, MAX_CACHE_SIZE)
        return { cache, version: state.version + 1 }
      })
    },

    resolveTitle: (id) => {
      const cache = get().cache
      const key = keyFor(activeSpaceId(), id)
      const cached = cache.get(key)
      if (cached) {
        // Touch for LRU only at capacity; below it nothing can be evicted.
        if (cache.size >= MAX_CACHE_SIZE) touch(cache, key, cached)
        // The flag decides, not the bytes (#4238).
        if (cached.resolved) return cached.title
      }
      return unresolvedBlockLabel(id)
    },

    resolveStatus: (id) => {
      const cache = get().cache
      const key = keyFor(activeSpaceId(), id)
      const cached = cache.get(key)
      if (cached) {
        // LRU touch only at capacity, as in `resolveTitle`.
        if (cache.size >= MAX_CACHE_SIZE) touch(cache, key, cached)
        // An unreturned entry is a broken target (#4515).
        return cached.deleted || !cached.resolved ? 'deleted' : 'active'
      }
      return 'active'
    },

    has: (id) => get().cache.has(keyFor(activeSpaceId(), id)),

    isResolved: (id) => get().cache.get(keyFor(activeSpaceId(), id))?.resolved === true,

    clearAllForSpace: (prevSpaceId) =>
      set((state) => {
        const prefix = `${prevSpaceId}::`
        const cache = new Map(state.cache)
        for (const key of cache.keys()) {
          if (key.startsWith(prefix)) cache.delete(key)
        }
        return { cache, version: state.version + 1 }
      }),

    markDeleted: (spaceId, ids) => {
      const cache = get().cache
      let changed = false
      for (const id of ids) {
        const key = keyFor(spaceId, id)
        const cached = cache.get(key)
        if (!cached || cached.deleted) continue
        cache.set(key, { ...cached, deleted: true })
        changed = true
      }
      if (changed) set((state) => ({ cache: state.cache, version: state.version + 1 }))
    },

    markMovedOut: (spaceId, ids) => {
      const cache = get().cache
      let changed = false
      for (const id of ids) {
        const key = keyFor(spaceId, id)
        if (cache.get(key)?.resolved !== true) continue
        cache.set(key, unresolvedEntry(id))
        changed = true
      }
      if (changed) set((state) => ({ cache: state.cache, version: state.version + 1 }))
    },

    refreshCachedBlocks: (blocks) => {
      const { batchSet, has } = get()
      batchSet(
        blocks
          .filter((b) => has(b.id))
          .map((b) => ({
            id: b.id,
            title: resolveStoreTitle(b.block_type, b.content),
            deleted: false,
          })),
      )
    },

    refreshDeleted: async (spaceId) => {
      if (spaceId == null) return
      const ids = cachedIds(
        spaceId,
        TARGETED_PRELOAD_MAX_IDS,
        (_id, entry) => entry.deleted && entry.resolved,
      )
      if (ids.length === 0) return
      try {
        const rows = unwrap(await commands.batchResolve(ids, { kind: 'active', space_id: spaceId }))
        // `batchSet` writes under the active space; a switch mid-IPC flushed this one.
        if (activeSpaceId() !== spaceId) return
        get().batchSet(
          rows.map((r) => ({
            id: r.id,
            title: resolveStoreTitle(r.block_type, r.title),
            deleted: r.deleted,
          })),
        )
      } catch (err) {
        logger.warn('ResolveStore', 'refresh of trashed entries failed', { spaceId }, err)
      }
    },
  }
})
