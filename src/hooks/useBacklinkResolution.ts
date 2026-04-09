/**
 * useBacklinkResolution -- resolve [[ULID]] and #[ULID] tokens in backlink content.
 *
 * Manages a TTL cache of resolved page titles and tag names, batch-resolving
 * unknown IDs via the backend and providing stable resolver callbacks for rendering.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { logger } from '../lib/logger'
import type { BacklinkGroup } from '../lib/tauri'
import { batchResolve } from '../lib/tauri'

export interface ResolveCacheEntry {
  title: string
  deleted: boolean
  cachedAt: number
}

export const TTL_MS = 5 * 60 * 1000
export const MAX_CACHE_SIZE = 1000

export interface UseBacklinkResolutionResult {
  resolveBlockTitle: (id: string) => string
  resolveBlockStatus: (id: string) => 'active' | 'deleted'
  resolveTagName: (id: string) => string
  clearCache: () => void
}

export function useBacklinkResolution(groups: BacklinkGroup[]): UseBacklinkResolutionResult {
  const [resolveVersion, setResolveVersion] = useState(0)
  const resolveCache = useRef<Map<string, ResolveCacheEntry>>(new Map())

  // Resolve [[ULID]] and #[ULID] tokens in block content
  useEffect(() => {
    const allBlocks = groups.flatMap((g) => g.blocks)
    if (allBlocks.length === 0) return

    const ULID_RE = /\[\[([0-9A-Z]{26})\]\]/g
    const TAG_RE = /#\[([0-9A-Z]{26})\]/g
    const idsToResolve = new Set<string>()

    for (const block of allBlocks) {
      if (!block.content) continue
      for (const m of block.content.matchAll(ULID_RE)) idsToResolve.add(m[1] as string)
      for (const m of block.content.matchAll(TAG_RE)) idsToResolve.add(m[1] as string)
    }

    // Remove already-cached IDs (skip expired entries so they get re-fetched)
    for (const id of idsToResolve) {
      const cached = resolveCache.current.get(id)
      if (cached && Date.now() - cached.cachedAt <= TTL_MS) {
        idsToResolve.delete(id)
      }
    }

    if (idsToResolve.size === 0) {
      setResolveVersion((v) => v + 1)
      return
    }

    let cancelled = false

    batchResolve([...idsToResolve])
      .then((resolved) => {
        if (cancelled) return
        const now = Date.now()
        for (const [key, entry] of resolveCache.current) {
          if (now - entry.cachedAt > TTL_MS) {
            resolveCache.current.delete(key)
          }
        }
        if (resolveCache.current.size + idsToResolve.size > MAX_CACHE_SIZE) {
          const overflow = resolveCache.current.size + idsToResolve.size - MAX_CACHE_SIZE
          const keys = resolveCache.current.keys()
          for (let i = 0; i < overflow; i++) {
            const next = keys.next()
            if (next.done) break
            resolveCache.current.delete(next.value)
          }
        }
        for (const r of resolved) {
          resolveCache.current.set(r.id, {
            title:
              r.title?.slice(0, 60) ||
              (r.block_type === 'tag' ? `#${r.id.slice(0, 8)}...` : `[[${r.id.slice(0, 8)}...]]`),
            deleted: r.deleted,
            cachedAt: Date.now(),
          })
        }
        for (const id of idsToResolve) {
          if (!resolveCache.current.has(id)) {
            resolveCache.current.set(id, {
              title: `[[${id.slice(0, 8)}...]]`,
              deleted: true,
              cachedAt: Date.now(),
            })
          }
        }
        setResolveVersion((v) => v + 1)
      })
      .catch((err) => {
        logger.warn('useBacklinkResolution', 'batch resolve failed', undefined, err)
        if (!cancelled) setResolveVersion((v) => v + 1)
      })

    return () => {
      cancelled = true
    }
  }, [groups])

  // biome-ignore lint/correctness/useExhaustiveDependencies: resolveVersion forces re-creation so render picks up cache updates
  const resolveBlockTitle = useCallback(
    (id: string): string => {
      return resolveCache.current.get(id)?.title ?? `[[${id.slice(0, 8)}...]]`
    },
    [resolveVersion],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: resolveVersion forces re-creation so render picks up cache updates
  const resolveBlockStatus = useCallback(
    (id: string): 'active' | 'deleted' => {
      return resolveCache.current.get(id)?.deleted ? 'deleted' : 'active'
    },
    [resolveVersion],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: resolveVersion forces re-creation so render picks up cache updates
  const resolveTagName = useCallback(
    (id: string): string => {
      return resolveCache.current.get(id)?.title ?? `#${id.slice(0, 8)}...`
    },
    [resolveVersion],
  )

  const clearCache = useCallback(() => {
    resolveCache.current.clear()
  }, [])

  return {
    resolveBlockTitle,
    resolveBlockStatus,
    resolveTagName,
    clearCache,
  }
}
