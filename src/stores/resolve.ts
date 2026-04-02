/**
 * Global resolve cache store — Zustand state for block/tag title resolution.
 *
 * Replaces the per-component ref-based cache that was in BlockTree.
 * Single source of truth for resolving block/tag ULIDs to display titles.
 * Preloaded once on app boot; updated incrementally as pages/tags are created.
 */

import { create } from 'zustand'
import { listBlocks, listTagsByPrefix } from '../lib/tauri'

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

  /** Fetch all pages + tags into cache. Call once on boot. */
  preload: () => Promise<void>
  /** Add/update a single entry */
  set: (id: string, title: string, deleted: boolean) => void
  /** Batch-add from resolved blocks */
  batchSet: (entries: Array<{ id: string; title: string; deleted: boolean }>) => void
  /** Resolve title, with fallback */
  resolveTitle: (id: string) => string
  /** Resolve deleted status */
  resolveStatus: (id: string) => 'active' | 'deleted'
}

export const useResolveStore = create<ResolveStore>((set, get) => ({
  cache: new Map(),
  pagesList: [],
  version: 0,
  _preloaded: false,

  preload: async () => {
    try {
      // Fetch all pages
      const pagesResp = await listBlocks({ blockType: 'page', limit: 1000 })
      const pagesList: Array<{ id: string; title: string }> = []
      const fetchedPages = new Map<string, ResolveEntry>()
      for (const p of pagesResp.items) {
        const title = p.content ?? 'Untitled'
        fetchedPages.set(p.id, { title, deleted: p.deleted_at !== null })
        pagesList.push({ id: p.id, title })
      }

      // Fetch all tags
      const tags = await listTagsByPrefix({ prefix: '' })
      const fetchedTags = new Map<string, ResolveEntry>()
      for (const t of tags) {
        fetchedTags.set(t.tag_id, { title: t.name, deleted: false })
      }

      // Merge: fetched data fills gaps, but concurrent set() calls win
      // (state.cache is current at commit time thanks to the updater pattern)
      set((state) => {
        const cache = new Map([...fetchedPages, ...fetchedTags, ...state.cache])
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
    } catch {
      // Preload failed — resolve callbacks will use fallbacks
      set({ _preloaded: true })
    }
  },

  set: (id, title, deleted) => {
    set((state) => {
      const cache = new Map(state.cache)
      cache.set(id, { title, deleted })
      // Also update pagesList if it's a new non-deleted entry
      // (pages created via onCreatePage should appear in picker)
      const existsInPagesList = state.pagesList.some((p) => p.id === id)
      const pagesList = existsInPagesList ? state.pagesList : [...state.pagesList, { id, title }]
      return { cache, pagesList, version: state.version + 1 }
    })
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
}))
