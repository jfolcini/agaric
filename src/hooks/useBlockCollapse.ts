/**
 * useBlockCollapse — manages collapsed block state and visible-block filtering.
 *
 * Extracted from BlockTree to encapsulate:
 * - Collapsed block IDs state (persisted in localStorage)
 * - Toggle callback with optional pre-collapse hook (e.g. focus rescue)
 * - Visible block computation (filters out descendants of collapsed blocks)
 * - hasChildren lookup set
 *
 * Persistence (#752): one localStorage entry PER PAGE (`collapsed_ids:<pageKey>`),
 * pruned on every write to ids that still exist on the page. The pre-#752
 * scheme was a single global `collapsed_ids` key shared across all pages and
 * spaces — unbounded and never pruned (every block id ever collapsed anywhere
 * accumulated forever, and concurrent journal trees raced each other's
 * writes). The legacy key is still READ as a one-way migration fallback when
 * a page has no scoped entry yet, but is never written again.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { hasPreference, PREFERENCES, readPreference, writePreference } from '../lib/preferences'
import type { FlatBlock } from '../lib/tree-utils'

/**
 * Load persisted collapsed ids for a page. Scoped key first; falls back to
 * the legacy global key (pre-#752 data) so existing users keep their
 * collapse state until the page's first scoped write. `hasPreference` (not
 * merely "the scoped list is non-empty") mirrors the original presence
 * check — a page that scoped-wrote an empty list (everything expanded)
 * must NOT fall through to the legacy list.
 */
function loadCollapsedIds(pageKey: string | null | undefined): Set<string> {
  if (pageKey && hasPreference(PREFERENCES.blockCollapse, pageKey)) {
    return new Set(readPreference(PREFERENCES.blockCollapse, pageKey))
  }
  return new Set(readPreference(PREFERENCES.blockCollapseLegacy))
}

export interface UseBlockCollapseOptions {
  /** Called before a block is collapsed (not expanded). Use to rescue focus, etc. */
  onBeforeCollapse?: (blockId: string) => void
  /**
   * Persistence scope (#752) — the page root id. Each page persists its own
   * `collapsed_ids:<pageKey>` localStorage entry, pruned to the page's
   * current block ids on write. When null/undefined (page not loaded yet, or
   * a caller that doesn't want persistence), state is in-memory only —
   * though the legacy global key is still read once as a migration fallback.
   */
  pageKey?: string | null
}

export interface UseBlockCollapseReturn {
  collapsedIds: Set<string>
  toggleCollapse: (blockId: string) => void
  /** Blocks visible after collapse filtering. */
  visibleBlocks: FlatBlock[]
  /** Set of block IDs that have children (next block has greater depth). */
  hasChildrenSet: Set<string>
}

export function useBlockCollapse(
  blocks: FlatBlock[],
  options: UseBlockCollapseOptions = {},
): UseBlockCollapseReturn {
  const { onBeforeCollapse, pageKey = null } = options

  // ── Collapse state (persisted per page in localStorage, #752) ─────────────────
  const [collapsedIds, setCollapsedIdsRaw] = useState<Set<string>>(() => loadCollapsedIds(pageKey))

  // Latest collapsed ids for event-time membership reads, so toggleCollapse
  // can check prior membership without depending on `collapsedIds` (which
  // would re-create the callback on every collapse/expand and churn memoized
  // consumers). Mirrors the blocksRef pattern below. (#1636)
  const collapsedIdsRef = useRef(collapsedIds)
  collapsedIdsRef.current = collapsedIds

  // BlockTree is NOT remounted on page switch (`rootParentId` just changes),
  // so reload the persisted state whenever the storage scope changes.
  const prevPageKeyRef = useRef(pageKey)
  useEffect(() => {
    if (prevPageKeyRef.current === pageKey) return
    prevPageKeyRef.current = pageKey
    setCollapsedIdsRaw(loadCollapsedIds(pageKey))
  }, [pageKey])

  // Latest blocks for write-time pruning, synced in an effect (not during
  // render) and only read at event time (toggle).
  const blocksRef = useRef(blocks)
  useEffect(() => {
    blocksRef.current = blocks
  })

  const setCollapsedIds = useCallback(
    (updater: (prev: Set<string>) => Set<string>) => {
      setCollapsedIdsRaw((prev) => {
        const next = updater(prev)
        if (pageKey) {
          // #752 — prune to ids that still exist on this page so deleted
          // blocks (and ids inherited from the legacy global key) can't
          // accumulate forever. Storage-unavailable failures are logged and
          // swallowed by writePreference.
          const known = new Set(blocksRef.current.map((b) => b.id))
          const pruned = [...next].filter((id) => known.has(id))
          writePreference(PREFERENCES.blockCollapse, pruned, pageKey)
        }
        return next
      })
    },
    [pageKey],
  )

  // ── Toggle collapse ─────────────────────────────────────────────
  const toggleCollapse = useCallback(
    (blockId: string) => {
      // Read prior membership from the ref (not `collapsedIds`) so this
      // callback stays referentially stable across collapse/expand. (#1636)
      const wasCollapsed = collapsedIdsRef.current.has(blockId)
      if (!wasCollapsed) {
        onBeforeCollapse?.(blockId)
      }

      setCollapsedIds((prev) => {
        const next = new Set(prev)
        if (next.has(blockId)) next.delete(blockId)
        else next.add(blockId)
        return next
      })
    },
    [onBeforeCollapse, setCollapsedIds],
  )

  // ── hasChildren set ───────────────────────────────────────────
  const hasChildrenSet = useMemo(() => {
    const set = new Set<string>()
    for (let i = 0; i < blocks.length - 1; i++) {
      const curr = blocks[i] as (typeof blocks)[number]
      const next = blocks[i + 1] as (typeof blocks)[number]
      if (next.depth > curr.depth) {
        set.add(curr.id)
      }
    }
    return set
  }, [blocks])

  // ── Visible blocks after collapse filtering ──────────────────────────
  const visibleBlocks = useMemo(() => {
    if (collapsedIds.size === 0) return blocks
    const result: typeof blocks = []
    const skipUntilDepth: number[] = []

    for (const block of blocks) {
      while (skipUntilDepth.length > 0 && block.depth <= (skipUntilDepth.at(-1) as number)) {
        skipUntilDepth.pop()
      }

      if (skipUntilDepth.length > 0) continue

      result.push(block)

      if (collapsedIds.has(block.id)) {
        skipUntilDepth.push(block.depth)
      }
    }
    return result
  }, [blocks, collapsedIds])

  return { collapsedIds, toggleCollapse, visibleBlocks, hasChildrenSet }
}
