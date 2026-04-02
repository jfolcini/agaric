/**
 * useBlockResolve — hook for resolving block/tag ULIDs to display titles.
 *
 * Wraps the global resolve store and provides:
 * - Resolve callbacks (resolveBlockTitle, resolveBlockStatus, resolveTagName, resolveTagStatus)
 * - Picker search callbacks (searchTags, searchPages, onCreatePage)
 *
 * NOTE: The preload effect that fetches pages/tags and scans for uncached
 * ULIDs is intentionally kept in BlockTree (not in this hook) to preserve
 * the original effect ordering: load() must fire before preload.
 */

import { useCallback, useRef } from 'react'
import type { PickerItem } from '../editor/SuggestionList'
import { createBlock, listBlocks, listTagsByPrefix, searchBlocks } from '../lib/tauri'
import { useResolveStore } from '../stores/resolve'

export interface UseBlockResolveReturn {
  resolveBlockTitle: (id: string) => string
  resolveBlockStatus: (id: string) => 'active' | 'deleted'
  resolveTagName: (id: string) => string
  resolveTagStatus: (id: string) => 'active' | 'deleted'
  searchTags: (query: string) => Promise<PickerItem[]>
  searchPages: (query: string) => Promise<PickerItem[]>
  onCreatePage: (label: string) => Promise<string>
  /** Ref to the pages list cache for search. Updated by the preload effect. */
  pagesListRef: React.MutableRefObject<Array<{ id: string; title: string }>>
}

export function useBlockResolve(): UseBlockResolveReturn {
  const version = useResolveStore((s) => s.version)
  const cache = useResolveStore((s) => s.cache)

  // Local ref for pagesListRef used in searchPages caching.
  // This mirrors the old BlockTree behavior where pagesListRef was used
  // for short-query caching. Updated by the preload effect in BlockTree.
  const pagesListRef = useRef<Array<{ id: string; title: string }>>([])

  // biome-ignore lint/correctness/useExhaustiveDependencies: resolveVersion forces re-creation so render picks up cache updates
  const resolveBlockTitle = useCallback(
    (id: string): string => {
      const cached = cache.get(id)
      if (cached) return cached.title
      return `[[${id.slice(0, 8)}...]]`
    },
    [version],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: resolveVersion forces re-creation so render picks up cache updates
  const resolveBlockStatus = useCallback(
    (id: string): 'active' | 'deleted' => {
      const cached = cache.get(id)
      if (cached) return cached.deleted ? 'deleted' : 'active'
      return 'active'
    },
    [version],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: resolveVersion forces re-creation so render picks up cache updates
  const resolveTagName = useCallback(
    (id: string): string => {
      const cached = cache.get(id)
      if (cached) return cached.title
      return `#${id.slice(0, 8)}...`
    },
    [version],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: resolveVersion forces re-creation so render picks up cache updates
  const resolveTagStatus = useCallback(
    (id: string): 'active' | 'deleted' => {
      const cached = cache.get(id)
      if (cached) return cached.deleted ? 'deleted' : 'active'
      return 'active'
    },
    [version],
  )

  // ── Picker callbacks ────────────────────────────────────────────────
  const searchTags = useCallback(async (query: string): Promise<PickerItem[]> => {
    const tags = await listTagsByPrefix({ prefix: query })
    // Populate the resolve cache so tag_ref nodes can resolve the name
    // after the block is saved (serialized as #[ULID]) and reloaded.
    if (tags.length > 0) {
      useResolveStore
        .getState()
        .batchSet(tags.map((t) => ({ id: t.tag_id, title: t.name, deleted: false })))
    }
    return tags.map((tag) => ({
      id: tag.tag_id,
      label: tag.name,
    }))
  }, [])

  const searchPages = useCallback(async (query: string): Promise<PickerItem[]> => {
    const q = query.toLowerCase().trim()

    // For short/empty queries, use the preloaded pages cache for instant results.
    // For longer queries, use FTS5 server-side search for relevance-ranked results.
    let matches: PickerItem[]

    if (q.length <= 2) {
      // Short query — use cache (substring match)
      let source = pagesListRef.current
      if (source.length === 0) {
        const resp = await listBlocks({ blockType: 'page', limit: 500 })
        source = resp.items.map((p) => ({ id: p.id, title: p.content ?? 'Untitled' }))
        pagesListRef.current = source
      }
      matches = source
        .filter((p) => !q || p.title.toLowerCase().includes(q))
        .slice(0, 20)
        .map((p) => ({ id: p.id, label: p.title }))
    } else {
      // Longer query — use FTS5 search, filter to pages
      const resp = await searchBlocks({ query: q, limit: 20 })
      matches = resp.items
        .filter((b) => b.block_type === 'page')
        .map((b) => ({ id: b.id, label: b.content ?? 'Untitled' }))

      // If FTS returns few results, supplement from cache
      if (matches.length < 5 && pagesListRef.current.length > 0) {
        const ftsIds = new Set(matches.map((m) => m.id))
        const cacheMatches = pagesListRef.current
          .filter((p) => p.title.toLowerCase().includes(q) && !ftsIds.has(p.id))
          .slice(0, 10)
          .map((p) => ({ id: p.id, label: p.title }))
        matches = [...matches, ...cacheMatches].slice(0, 20)
      }
    }

    // Populate resolve cache so page links show titles instead of raw ULIDs
    if (matches.length > 0) {
      useResolveStore
        .getState()
        .batchSet(
          matches
            .filter((m) => !m.isCreate)
            .map((m) => ({ id: m.id, title: m.label, deleted: false })),
        )
    }

    // Append a "Create new" option when the query doesn't exactly match an existing page
    if (q.length > 0) {
      const allSource = pagesListRef.current.length > 0 ? pagesListRef.current : matches
      const exactMatch = allSource.some(
        (p) => ('title' in p ? p.title : p.label).toLowerCase() === q,
      )
      if (!exactMatch) {
        matches.push({ id: '__create__', label: query.trim(), isCreate: true })
      }
    }
    return matches
  }, [])

  const onCreatePage = useCallback(async (label: string): Promise<string> => {
    const block = await createBlock({ blockType: 'page', content: label })
    // Populate resolve cache so the link chip shows the title immediately
    useResolveStore.getState().set(block.id, label, false)
    pagesListRef.current = [...pagesListRef.current, { id: block.id, title: label }]
    return block.id
  }, [])

  return {
    resolveBlockTitle,
    resolveBlockStatus,
    resolveTagName,
    resolveTagStatus,
    searchTags,
    searchPages,
    onCreatePage,
    pagesListRef,
  }
}
