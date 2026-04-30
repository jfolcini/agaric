/**
 * useRichContentCallbacks — lightweight hook providing resolve callbacks
 * for renderRichContent() across list view components.
 *
 * This is the thin, rendering-focused subset of useBlockResolve.
 * Use this in components that only need to display resolved content
 * (BlockListItem, ResultCard, HistoryPanel, DiffDisplay, etc.)
 * rather than the full picker/search/create API from useBlockResolve.
 */

import { useCallback, useRef } from 'react'
import { keyFor, useResolveStore } from '../stores/resolve'
import { useSpaceStore } from '../stores/space'
import { useTabsStore } from '../stores/tabs'

export interface RichContentCallbacks {
  resolveBlockTitle: (id: string) => string | undefined
  resolveBlockStatus: (id: string) => 'active' | 'deleted'
  resolveTagName: (id: string) => string | undefined
  resolveTagStatus: (id: string) => 'active' | 'deleted'
}

export function useRichContentCallbacks(): RichContentCallbacks {
  // Subscribe to version so the component re-renders when the cache updates,
  // keeping cacheRef.current fresh for the stable callbacks below.
  useResolveStore((s) => s.version)
  const cache = useResolveStore((s) => s.cache)

  const cacheRef = useRef(cache)
  cacheRef.current = cache

  // FEAT-3p7 — cache is keyed by composite `${spaceId}::${ulid}`. Read
  // the active space at lookup time so a switch immediately routes
  // resolves to the new space's slice.
  const resolveBlockTitle = useCallback((id: string): string | undefined => {
    const spaceId = useSpaceStore.getState().currentSpaceId
    const cached = cacheRef.current.get(keyFor(spaceId, id))
    if (cached) return cached.title
    return undefined
  }, [])

  const resolveBlockStatus = useCallback((id: string): 'active' | 'deleted' => {
    const spaceId = useSpaceStore.getState().currentSpaceId
    const cached = cacheRef.current.get(keyFor(spaceId, id))
    if (cached) return cached.deleted ? 'deleted' : 'active'
    return 'active'
  }, [])

  const resolveTagName = useCallback((id: string): string | undefined => {
    const spaceId = useSpaceStore.getState().currentSpaceId
    const cached = cacheRef.current.get(keyFor(spaceId, id))
    if (cached) return cached.title
    return undefined
  }, [])

  const resolveTagStatus = useCallback((id: string): 'active' | 'deleted' => {
    const spaceId = useSpaceStore.getState().currentSpaceId
    const cached = cacheRef.current.get(keyFor(spaceId, id))
    if (cached) return cached.deleted ? 'deleted' : 'active'
    return 'active'
  }, [])

  return {
    resolveBlockTitle,
    resolveBlockStatus,
    resolveTagName,
    resolveTagStatus,
  }
}

/**
 * useTagClickHandler — returns a stable `(tagId: string) => void` callback that
 * resolves the tag name via the resolve cache and routes to
 * `navigateToPage(tagId, tagName)` on the navigation store.
 *
 * Every rich-content surface that wants clickable tag chips wires this hook's
 * return value into `renderRichContent({ onTagClick })` or
 * `TagRef.configure({ onClick })`. Matches the tag-click semantics used by
 * `TagList` (src/App.tsx) — a single source of truth for tag navigation.
 *
 * The resolved name falls back to `'Tag'` when the resolve cache has no entry;
 * the navigation store will replace the label as soon as the real title is
 * cached.
 */
export function useTagClickHandler(): (tagId: string) => void {
  // Subscribe to version so the ref stays fresh for the stable callback below.
  useResolveStore((s) => s.version)
  const cache = useResolveStore((s) => s.cache)
  const navigateToPage = useTabsStore((s) => s.navigateToPage)

  const cacheRef = useRef(cache)
  cacheRef.current = cache

  return useCallback(
    (tagId: string) => {
      // FEAT-3p7 — composite-key cache; resolve under the active space.
      const spaceId = useSpaceStore.getState().currentSpaceId
      const cached = cacheRef.current.get(keyFor(spaceId, tagId))
      const name = cached?.title ?? 'Tag'
      navigateToPage(tagId, name)
    },
    [navigateToPage],
  )
}
