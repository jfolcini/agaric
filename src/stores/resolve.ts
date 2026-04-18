/**
 * Global resolve cache store — Zustand state for block/tag title resolution.
 *
 * Replaces the per-component ref-based cache that was in BlockTree.
 * Single source of truth for resolving block/tag ULIDs to display titles.
 * Preloaded once on app boot; updated incrementally as pages/tags are created.
 */

import { create } from 'zustand'
import { logger } from '../lib/logger'
import { listBlocks, listTagsByPrefix } from '../lib/tauri'

const MAX_CACHE_SIZE = 10_000
const MAX_PAGES_LIST_SIZE = 5_000

interface ResolveEntry {
  title: string
  deleted: boolean
}

interface ResolveStore {
  /** block/tag ULID -> { title, deleted } */
  cache: Map<string, ResolveEntry>
  /** Preloaded pages list for the [[ picker */
  pagesList: Array<{ id: string; title: string }>
  /** Bumped on cache updates to trigger re-renders */
  version: number
  /** Whether preload has been called at least once */
  _preloaded: boolean

  /** Fetch all pages + tags into cache. Call once on boot.
   *  Pass forceRefresh=true after sync so fetched data overwrites stale cache. */
  preload: (forceRefresh?: boolean) => Promise<void>
  /** Add/update a single entry */
  set: (id: string, title: string, deleted: boolean) => void
  /** Batch-add from resolved blocks */
  batchSet: (entries: Array<{ id: string; title: string; deleted: boolean }>) => void
  /** Resolve title, with fallback */
  resolveTitle: (id: string) => string
  /** Resolve deleted status */
  resolveStatus: (id: string) => 'active' | 'deleted'
}

export const useResolveStore = create<ResolveStore>((set, get) => {
  let pendingVersionBump = false

  return {
    cache: new Map(),
    pagesList: [],
    version: 0,
    _preloaded: false,

    preload: async (_forceRefresh = false) => {
      try {
        // Fetch all pages with cursor-based pagination
        const pagesList: Array<{ id: string; title: string }> = []
        const fetchedPages = new Map<string, ResolveEntry>()
        let cursor: string | undefined
        let hasMore = true
        while (hasMore) {
          const pagesResp = await listBlocks({ blockType: 'page', limit: 1000, cursor })
          for (const p of pagesResp.items) {
            const title = p.content ?? 'Untitled'
            fetchedPages.set(p.id, { title, deleted: p.deleted_at !== null })
            pagesList.push({ id: p.id, title })
          }
          hasMore = pagesResp.has_more
          cursor = pagesResp.next_cursor ?? undefined
        }

        // Fetch all tags
        const tags = await listTagsByPrefix({ prefix: '' })
        const fetchedTags = new Map<string, ResolveEntry>()
        for (const t of tags) {
          fetchedTags.set(t.tag_id, { title: t.name, deleted: false })
        }

        // Merge: fetched data always wins over stale cache entries.
        // Both branches use the same order — forceRefresh is a semantic flag for callers,
        // not a behavioral switch. Fresh titles must propagate after sync or rename.
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
      set((state) => {
        const cache = new Map(state.cache)
        cache.set(id, { title, deleted })
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
        // (pages created via onCreatePage should appear in picker)
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
      set((state) => {
        const cache = new Map(state.cache)
        for (const e of entries) {
          cache.set(e.id, {
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
      const cached = get().cache.get(id)
      if (cached) return cached.title
      return `[[${id.slice(0, 8)}...]]`
    },

    resolveStatus: (id) => {
      const cached = get().cache.get(id)
      if (cached) return cached.deleted ? 'deleted' : 'active'
      return 'active'
    },
  }
})
