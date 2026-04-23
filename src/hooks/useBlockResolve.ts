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

import { FileText, Hash, Tag } from 'lucide-react'
import { matchSorter } from 'match-sorter'
import { useCallback, useRef } from 'react'
import { toast } from 'sonner'
import type { PickerItem } from '../editor/SuggestionList'
import { foldForSearch, matchesSearchFolded } from '../lib/fold-for-search'
import { t as translate } from '../lib/i18n'
import { logger } from '../lib/logger'
import {
  createBlock,
  createPageInSpace,
  listBlocks,
  listTagsByPrefix,
  resolvePageByAlias,
  searchBlocks,
} from '../lib/tauri'
import { useResolveStore } from '../stores/resolve'
import { useSpaceStore } from '../stores/space'

function logSlowQuery(fn: string, query: string, t0: number, count: number): void {
  const durationMs = Math.round(performance.now() - t0)
  if (durationMs > 200) {
    logger.warn('useBlockResolve', `${fn} slow`, { query, durationMs, count })
  }
}

export interface UseBlockResolveReturn {
  resolveBlockTitle: (id: string) => string
  resolveBlockStatus: (id: string) => 'active' | 'deleted'
  resolveTagName: (id: string) => string
  resolveTagStatus: (id: string) => 'active' | 'deleted'
  searchTags: (query: string) => Promise<PickerItem[]>
  searchPages: (query: string) => Promise<PickerItem[]>
  searchBlockRefs: (query: string) => Promise<PickerItem[]>
  onCreatePage: (label: string) => Promise<string>
  onCreateTag: (name: string) => Promise<string>
  /** Ref to the pages list cache for search. Updated by the preload effect. */
  pagesListRef: React.RefObject<Array<{ id: string; title: string }>>
}

// ── searchPages strategy helpers ────────────────────────────────────────
//
// Each function below represents a discrete resolution strategy used by
// `searchPages`. They are defined at module scope because they do not close
// over React state — the only mutable state they touch is the `pagesListRef`
// passed in explicitly. Keeping them as free functions (rather than inline
// closures) makes the dispatcher below a linear, low-complexity sequence.

type PagesListRef = React.RefObject<Array<{ id: string; title: string }>>

/** Splits a `parent/child/leaf` title into `{ label: leaf, breadcrumb: 'parent / child' }`. */
function formatNamespacedLabel(title: string): {
  label: string
  breadcrumb: string | undefined
} {
  if (!title.includes('/')) {
    return { label: title, breadcrumb: undefined }
  }
  const parts = title.split('/')
  const leaf = parts.pop() as string
  return { label: leaf, breadcrumb: parts.join(' / ') }
}

function makePagePickerItem(id: string, title: string): PickerItem {
  const { label, breadcrumb } = formatNamespacedLabel(title)
  return { id, label, icon: FileText, breadcrumb }
}

/**
 * Short-query strategy: fuzzy-match against the preloaded pages cache.
 * Lazily falls back to `listBlocks` when the cache is empty, populating
 * `pagesListRef` as a side effect for subsequent calls.
 *
 * FEAT-3 Phase 2 — the lazy `listBlocks` fallback is scoped to the
 * current space via `spaceId`. Cross-space `[[ULID]]` targets that are
 * already in the document continue to resolve via the shared resolve
 * cache, they just don't appear as new suggestions.
 */
async function searchPagesViaCache(q: string, pagesListRef: PagesListRef): Promise<PickerItem[]> {
  let source = pagesListRef.current
  if (source.length === 0) {
    const spaceId = useSpaceStore.getState().currentSpaceId ?? undefined
    const resp = await listBlocks({ blockType: 'page', limit: 500, spaceId })
    source = resp.items.map((p) => ({ id: p.id, title: p.content ?? 'Untitled' }))
    pagesListRef.current = source
  }
  const filtered = q ? matchSorter(source, q, { keys: ['title'] }) : source
  return filtered.slice(0, 20).map((p) => makePagePickerItem(p.id, p.title))
}

/**
 * Long-query strategy: FTS5 search filtered to pages. When FTS returns fewer
 * than 5 results and the preloaded cache is non-empty, supplements the result
 * set from cache (deduped, capped at 20 total).
 *
 * FEAT-3 Phase 2 — the FTS call is scoped to the current space.
 */
async function searchPagesViaFts(q: string, pagesListRef: PagesListRef): Promise<PickerItem[]> {
  const spaceId = useSpaceStore.getState().currentSpaceId ?? undefined
  const resp = await searchBlocks({ query: q, limit: 20, spaceId })
  const matches = resp.items
    .filter((b) => b.block_type === 'page')
    .map((b) => makePagePickerItem(b.id, b.content ?? 'Untitled'))

  if (matches.length >= 5 || pagesListRef.current.length === 0) {
    return matches
  }
  const ftsIds = new Set(matches.map((m) => m.id))
  // UX-248 — Unicode-aware fold.  `matchesSearchFolded`'s ASCII fast
  // path keeps this hot cache-lookup cheap when the query is ASCII.
  const cacheMatches = pagesListRef.current
    .filter((p) => matchesSearchFolded(p.title, q) && !ftsIds.has(p.id))
    .slice(0, 10)
    .map((p) => makePagePickerItem(p.id, p.title))
  return [...matches, ...cacheMatches].slice(0, 20)
}

/** Populates the resolve cache so page links show titles instead of raw ULIDs. */
function populatePageResolveCache(matches: PickerItem[]): void {
  if (matches.length === 0) return
  useResolveStore
    .getState()
    .batchSet(
      matches.filter((m) => !m.isCreate).map((m) => ({ id: m.id, title: m.label, deleted: false })),
    )
}

/**
 * Alias-resolution strategy: looks up the query against the page-alias table
 * and, if a match exists that isn't already in `matches`, prepends it so the
 * alias becomes the top suggestion. Rejection is logged at warn level — an
 * alias-service failure must never abort the picker (see H-10 / H-11).
 */
async function tryPrependAliasMatch(matches: PickerItem[], q: string): Promise<void> {
  if (q.length === 0) return
  try {
    const aliasMatch = await resolvePageByAlias(q)
    if (!aliasMatch) return
    const [pageId, title] = aliasMatch
    if (matches.some((m) => m.id === pageId)) return
    matches.unshift({
      id: pageId,
      label: `${title ?? 'Untitled'} (alias: ${q})`,
      isAlias: true,
    })
  } catch (err) {
    logger.warn('useBlockResolve', 'alias lookup failed', { query: q }, err)
  }
}

/**
 * Appends (not prepends) a "Create new page" option when the query doesn't
 * exactly match an existing page. Pages keep Create at the end — F-26 only
 * moved Create to the top for tags.
 */
function appendCreatePageOptionIfNeeded(
  matches: PickerItem[],
  query: string,
  q: string,
  pagesListRef: PagesListRef,
): void {
  if (q.length === 0) return
  const allSource = pagesListRef.current.length > 0 ? pagesListRef.current : matches
  // UX-248 — fold both sides so the "exact match exists" check folds
  // Turkish / German / accented inputs the same way `matchesSearchFolded`
  // does in the filter above.  Without this, a page titled `İstanbul`
  // when queried as `istanbul` would appear as "no exact match" and the
  // "Create new page" option would be appended, even though the page
  // does exist.
  const qFolded = foldForSearch(q)
  const exactMatch = allSource.some(
    (p) => foldForSearch('title' in p ? p.title : p.label) === qFolded,
  )
  if (exactMatch) return
  matches.push({
    id: '__create__',
    label: query.replace(/\]+$/, '').trim(),
    isCreate: true,
  })
}

export function useBlockResolve(): UseBlockResolveReturn {
  // Subscribe to version so the component re-renders when the cache updates,
  // keeping cacheRef.current fresh for the stable callbacks below.
  useResolveStore((s) => s.version)
  const cache = useResolveStore((s) => s.cache)

  const cacheRef = useRef(cache)
  cacheRef.current = cache

  // Local ref for pagesListRef used in searchPages caching.
  // This mirrors the old BlockTree behavior where pagesListRef was used
  // for short-query caching. Updated by the preload effect in BlockTree.
  const pagesListRef = useRef<Array<{ id: string; title: string }>>([])

  const resolveBlockTitle = useCallback((id: string): string => {
    const cached = cacheRef.current.get(id)
    if (cached) return cached.title
    return `[[${id.slice(0, 8)}...]]`
  }, [])

  const resolveBlockStatus = useCallback((id: string): 'active' | 'deleted' => {
    const cached = cacheRef.current.get(id)
    if (cached) return cached.deleted ? 'deleted' : 'active'
    return 'active'
  }, [])

  const resolveTagName = useCallback((id: string): string => {
    const cached = cacheRef.current.get(id)
    if (cached) return cached.title
    return `#${id.slice(0, 8)}...`
  }, [])

  const resolveTagStatus = useCallback((id: string): 'active' | 'deleted' => {
    const cached = cacheRef.current.get(id)
    if (cached) return cached.deleted ? 'deleted' : 'active'
    return 'active'
  }, [])

  // ── Picker callbacks ────────────────────────────────────────────────
  const searchTags = useCallback(async (query: string): Promise<PickerItem[]> => {
    const t0 = performance.now()
    try {
      // Strip trailing ] so @tag] resolves to "tag", not "tag]"
      const q = query.replace(/\]+$/, '').toLowerCase().trim()

      const tags = await listTagsByPrefix({ prefix: q })
      // Populate the resolve cache so tag_ref nodes can resolve the name
      // after the block is saved (serialized as #[ULID]) and reloaded.
      if (tags.length > 0) {
        useResolveStore
          .getState()
          .batchSet(tags.map((t) => ({ id: t.tag_id, title: t.name, deleted: false })))
      }
      const sorted = q ? matchSorter(tags, q, { keys: ['name'] }) : tags
      const result: PickerItem[] = sorted.map((tag) => ({
        id: tag.tag_id,
        label: tag.name,
        icon: Tag,
      }))

      // Prepend a "Create new tag" option when the query doesn't exactly match
      // an existing tag — this makes it the default selection so pressing Enter
      // auto-creates the tag (F-26).
      if (q.length > 0) {
        // UX-248 — fold both sides so Turkish / German / accented tag
        // names match their ASCII-typed queries the same way as pages do.
        const qFolded = foldForSearch(q)
        const exactMatch = tags.some((t) => foldForSearch(t.name) === qFolded)
        if (!exactMatch) {
          result.unshift({
            id: '__create__',
            label: query.replace(/\]+$/, '').trim(),
            isCreate: true,
          })
        }
      }
      logSlowQuery('searchTags', q, t0, result.length)
      return result
    } catch (err) {
      // Never reject — the TipTap Suggestion plugin has no error handling
      // for async items callbacks.  A rejection silently prevents the popup
      // from opening (H-10 / H-11).
      const durationMs = Math.round(performance.now() - t0)
      logger.error('useBlockResolve', 'searchTags failed', { query, durationMs }, err)
      return []
    }
  }, [])

  /**
   * Dispatcher: picks the right resolution strategy based on query length,
   * then applies cache population, alias disambiguation, and the create-new
   * affordance in priority order.
   *
   * Priority (low → high in the result list):
   *   1. Alias match (prepended first — highest relevance)
   *   2. FTS / cache matches (ordered by strategy)
   *   3. "Create new page" (appended last)
   */
  const searchPages = useCallback(async (query: string): Promise<PickerItem[]> => {
    const t0 = performance.now()
    try {
      // Strip trailing ]] so [[text]] resolves to "text", not "text]]"
      const q = query.replace(/\]+$/, '').toLowerCase().trim()

      // For short/empty queries, use the preloaded pages cache for instant
      // results. For longer queries, use FTS5 server-side search for
      // relevance-ranked results.
      const matches =
        q.length <= 2
          ? await searchPagesViaCache(q, pagesListRef)
          : await searchPagesViaFts(q, pagesListRef)

      populatePageResolveCache(matches)
      await tryPrependAliasMatch(matches, q)
      appendCreatePageOptionIfNeeded(matches, query, q, pagesListRef)

      logSlowQuery('searchPages', q, t0, matches.length)
      return matches
    } catch (err) {
      // Never reject — the TipTap Suggestion plugin has no error handling
      // for async items callbacks.  A rejection silently prevents the popup
      // from opening (H-10 / H-11).
      const durationMs = Math.round(performance.now() - t0)
      logger.error('useBlockResolve', 'searchPages failed', { query, durationMs }, err)
      return []
    }
  }, [])

  const searchBlockRefs = useCallback(async (query: string): Promise<PickerItem[]> => {
    const t0 = performance.now()
    try {
      const q = query.replace(/\)+$/, '').trim()
      if (q.length < 2) return []

      const resp = await searchBlocks({ query: q, limit: 20 })
      const results: PickerItem[] = resp.items
        .filter((b) => b.deleted_at === null)
        .map((b) => {
          const content = b.content ?? 'Untitled'
          const firstLine = content.split('\n')[0] as string
          const label = firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine
          // Show parent page title as breadcrumb when available
          const parentTitle = b.parent_id ? cacheRef.current.get(b.parent_id)?.title : undefined
          return { id: b.id, label, icon: Hash, breadcrumb: parentTitle }
        })

      // Populate resolve cache
      if (results.length > 0) {
        useResolveStore.getState().batchSet(
          results.map((r) => {
            const block = resp.items.find((b) => b.id === r.id)
            return { id: r.id, title: block?.content ?? 'Untitled', deleted: false }
          }),
        )
      }
      logSlowQuery('searchBlockRefs', q, t0, results.length)
      return results
    } catch (err) {
      const durationMs = Math.round(performance.now() - t0)
      logger.error('useBlockResolve', 'searchBlockRefs failed', { query, durationMs }, err)
      return []
    }
  }, [])

  const onCreatePage = useCallback(async (label: string): Promise<string> => {
    // FEAT-3 Phase 2 — every page must belong to a space. Route the
    // creation through the atomic `createPageInSpace` Tauri command so
    // CreateBlock + SetProperty('space') are committed together.
    // The `!isReady` branch is defensive — the roving editor doesn't
    // render until `BlockTree` has mounted, which happens after boot's
    // `refreshAvailableSpaces()` resolves, so in practice this guard
    // almost never fires.
    const { currentSpaceId, isReady } = useSpaceStore.getState()
    if (!isReady || currentSpaceId == null) {
      logger.warn(
        'useBlockResolve',
        'onCreatePage called before space hydrated; refusing to create',
        { label },
      )
      toast.error(translate('space.notReady'))
      throw new Error('Space store is not ready')
    }
    try {
      const newId = await createPageInSpace({ content: label, spaceId: currentSpaceId })
      // Populate resolve cache so the link chip shows the title immediately
      useResolveStore.getState().set(newId, label, false)
      pagesListRef.current = [...pagesListRef.current, { id: newId, title: label }]
      return newId
    } catch (err) {
      logger.error('useBlockResolve', 'onCreatePage failed', { label }, err)
      throw err
    }
  }, [])

  const onCreateTag = useCallback(async (name: string): Promise<string> => {
    try {
      const block = await createBlock({ blockType: 'tag', content: name })
      // Populate resolve cache so the tag chip shows the name immediately
      useResolveStore.getState().set(block.id, name, false)
      return block.id
    } catch (err) {
      logger.error('useBlockResolve', 'onCreateTag failed', { name }, err)
      throw err
    }
  }, [])

  return {
    resolveBlockTitle,
    resolveBlockStatus,
    resolveTagName,
    resolveTagStatus,
    searchTags,
    searchPages,
    searchBlockRefs,
    onCreatePage,
    onCreateTag,
    pagesListRef,
  }
}
