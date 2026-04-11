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
import { useResolveStore } from '../stores/resolve'

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

  const resolveBlockTitle = useCallback((id: string): string | undefined => {
    const cached = cacheRef.current.get(id)
    if (cached) return cached.title
    return undefined
  }, [])

  const resolveBlockStatus = useCallback((id: string): 'active' | 'deleted' => {
    const cached = cacheRef.current.get(id)
    if (cached) return cached.deleted ? 'deleted' : 'active'
    return 'active'
  }, [])

  const resolveTagName = useCallback((id: string): string | undefined => {
    const cached = cacheRef.current.get(id)
    if (cached) return cached.title
    return undefined
  }, [])

  const resolveTagStatus = useCallback((id: string): 'active' | 'deleted' => {
    const cached = cacheRef.current.get(id)
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
