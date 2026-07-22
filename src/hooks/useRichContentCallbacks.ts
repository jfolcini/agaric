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

import { t as translate } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { getBlock } from '@/lib/tauri'
import { keyFor, useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'
import { useTabsStore } from '@/stores/tabs'

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

  // Cache is keyed by composite `${spaceId}::${ulid}`. Read
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
      // Composite-key cache; resolve under the active space.
      const spaceId = useSpaceStore.getState().currentSpaceId
      const cached = cacheRef.current.get(keyFor(spaceId, tagId))

      // Fast path: a resolved, non-deleted tag navigates immediately (no IPC).
      if (cached && !cached.deleted) {
        navigateToPage(tagId, cached.title)
        return
      }

      // #2996 — guard against navigating to a tag that doesn't exist. A tag
      // pill can reference a tag that was never persisted (e.g. an orphan whose
      // creation failed), or one that was since deleted; navigating there lands
      // on a random/incorrect destination. Mirror the `[[` block-link path
      // (`useBlockNavigateToLink`), which verifies the target via `getBlock`
      // and surfaces `blockTree.linkTargetNotFound` instead of routing to a
      // nonexistent page. Verify existence before navigating; on a
      // missing/deleted target, notify instead. Fire-and-forget so the handler
      // keeps its synchronous `(tagId) => void` signature.
      void (async () => {
        try {
          const block = await getBlock(tagId)
          if (block.deleted_at !== null) {
            notify.error(translate('blockTree.linkTargetNotFound'))
            return
          }
          const name = block.content ?? cached?.title ?? 'Tag'
          useResolveStore.getState().set(tagId, name, false)
          navigateToPage(tagId, name)
        } catch (err) {
          logger.warn(
            'useTagClickHandler',
            'tag target not found; refusing to navigate',
            { tagId },
            err,
          )
          notify.error(translate('blockTree.linkTargetNotFound'))
        }
      })()
    },
    [navigateToPage],
  )
}
