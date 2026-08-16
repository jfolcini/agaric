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
 *
 * Two layers of collapse state (#4002): the PERSISTED set is the user's saved
 * layout — only their own toggles write it — and a TRANSIENT `revealedIds`
 * overlay temporarily un-collapses the ancestors hiding a navigation target
 * (`expandAncestors`). Consumers see the effective set (persisted minus
 * revealed); localStorage only ever sees the persisted one. Before #4002 the
 * reveal went through the persisting setter, so following a single backlink
 * into a collapsed subtree permanently deleted those ancestors from the saved
 * layout, with no undo and across reloads.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { hasPreference, PREFERENCES, readPreference, writePreference } from '@/lib/preferences'
import type { FlatBlock } from '@/lib/tree-utils'

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

/** Shared empty transient overlay, so "nothing revealed" stays reference-stable. */
const NO_REVEAL: ReadonlySet<string> = new Set<string>()

function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const id of a) if (!b.has(id)) return false
  return true
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
  /**
   * Effective collapsed set = persisted layout minus the transient reveal
   * overlay (#4002). This is what the UI renders and what `visibleBlocks` is
   * filtered by; it is NOT what gets written to localStorage.
   */
  collapsedIds: Set<string>
  toggleCollapse: (blockId: string) => void
  /** Expand a block if collapsed; leaves already-expanded blocks unchanged. */
  expandBlock: (blockId: string) => void
  /**
   * #3276 — reveal `blockId` by expanding every collapsed ANCESTOR of it (not
   * the block itself) in one update, so a block hidden under a collapsed
   * grandparent becomes reachable in a single call instead of requiring the
   * caller to walk the chain and call `expandBlock` per level.
   *
   * #4002 — the reveal is EPHEMERAL and EXCLUSIVE: it never writes the
   * persisted layout, and each call REPLACES the previous reveal. Callers pass
   * the current navigation target on every focus change, so moving focus out
   * of a revealed subtree restores the saved collapse layout by itself.
   *
   * Reference-stable (a true no-op) only when the newly computed chain equals
   * what is already revealed — in particular when nothing is revealed and the
   * target has no collapsed ancestors.
   *
   * An UNKNOWN `blockId` is not a no-op: it yields an empty chain and
   * therefore RELEASES any active reveal, exactly like a target with no
   * collapsed ancestors. (#4038 — this JSDoc used to claim the opposite.)
   * That is the safe direction for a "reveal whatever hides the current
   * target" primitive: a target this hook cannot place is not being kept on
   * screen by the overlay, so holding the previous chain open would strand a
   * subtree the user has already navigated away from. `BlockTree` never
   * reaches it — it guards with `blocksById.has(focusedBlockId)` first — but
   * the behaviour is defined rather than accidental, and pinned by a test.
   */
  expandAncestors: (blockId: string) => void
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

  // ── Collapse state (persisted per page in localStorage, #752) ──────
  // The user's SAVED layout. Only their own collapse/expand actions write it.
  const [persistedCollapsedIds, setCollapsedIdsRaw] = useState<Set<string>>(() =>
    loadCollapsedIds(pageKey),
  )

  // ── Transient reveal overlay (#4002) ───────────────────────────────
  // Ancestors currently un-collapsed ONLY to keep a navigation target on
  // screen. Never persisted, replaced wholesale by each `expandAncestors`
  // call, and dropped for any id the user toggles by hand.
  const [revealedIds, setRevealedIds] = useState<ReadonlySet<string>>(NO_REVEAL)

  // What the UI (and `visibleBlocks`) actually sees. Falls back to the
  // persisted set's own reference while nothing is revealed, so the common
  // case adds no identity churn for memoized consumers.
  const collapsedIds = useMemo(() => {
    if (revealedIds.size === 0) return persistedCollapsedIds
    const next = new Set(persistedCollapsedIds)
    for (const id of revealedIds) next.delete(id)
    return next
  }, [persistedCollapsedIds, revealedIds])

  // Latest collapsed ids for event-time membership reads, so toggleCollapse
  // can check prior membership without depending on `collapsedIds` (which
  // would re-create the callback on every collapse/expand and churn memoized
  // consumers). Mirrors the blocksRef pattern below. (#1636)
  // Effective, not persisted: a transiently revealed ancestor RENDERS as
  // expanded, so the user's next chevron click on it must mean "collapse".
  const collapsedIdsRef = useRef(collapsedIds)
  collapsedIdsRef.current = collapsedIds

  // Persisted set for event-time reads (`expandAncestors` decides what to
  // reveal against the SAVED layout, not against its own previous overlay).
  const persistedCollapsedIdsRef = useRef(persistedCollapsedIds)
  persistedCollapsedIdsRef.current = persistedCollapsedIds

  // BlockTree is NOT remounted on page switch (`rootParentId` just changes),
  // so reload the persisted state whenever the storage scope changes. A
  // reveal belongs to the navigation that requested it, so it does not
  // survive the page switch either (#4002).
  const prevPageKeyRef = useRef(pageKey)
  useEffect(() => {
    if (prevPageKeyRef.current === pageKey) return
    prevPageKeyRef.current = pageKey
    setCollapsedIdsRaw(loadCollapsedIds(pageKey))
    setRevealedIds(NO_REVEAL)
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
        if (next === prev) return prev
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

  // Drop a block from the transient overlay: any explicit user action on it
  // supersedes the reveal, and the persisted set below becomes the truth for
  // that id again. (#4002)
  const releaseReveal = useCallback((blockId: string) => {
    setRevealedIds((prev) => {
      if (!prev.has(blockId)) return prev
      const next = new Set(prev)
      next.delete(blockId)
      return next.size === 0 ? NO_REVEAL : next
    })
  }, [])

  // ── Toggle collapse ────────────────────────────────────────────────
  const toggleCollapse = useCallback(
    (blockId: string) => {
      // Read prior membership from the ref (not `collapsedIds`) so this
      // callback stays referentially stable across collapse/expand. (#1636)
      const wasCollapsed = collapsedIdsRef.current.has(blockId)
      if (!wasCollapsed) {
        onBeforeCollapse?.(blockId)
      }

      releaseReveal(blockId)
      // Written against the EFFECTIVE prior state: a transiently revealed
      // ancestor is already in `prev` (the persisted set), so toggling it
      // must ADD nothing and re-collapse by simply releasing the reveal —
      // and expanding it must delete it from the saved layout for real.
      setCollapsedIds((prev) => {
        if (wasCollapsed) {
          if (!prev.has(blockId)) return prev
          const next = new Set(prev)
          next.delete(blockId)
          return next
        }
        if (prev.has(blockId)) return prev
        const next = new Set(prev)
        next.add(blockId)
        return next
      })
    },
    [onBeforeCollapse, releaseReveal, setCollapsedIds],
  )

  // ── Explicit expand ────────────────────────────────────────────────
  // Unlike toggleCollapse, zoom/navigation callers need an idempotent
  // "make visible" operation: an already-expanded block must not collapse.
  // Reusing setCollapsedIds keeps the page-scoped persistence and pruning
  // path identical to manual expansion. The callback stays stable across
  // collapse changes because it only depends on the stable setter.
  // Zoom is an explicit "I want to be inside this block" action, so — unlike
  // the transient `expandAncestors` reveal (#4002) — its expansion is saved.
  const expandBlock = useCallback(
    (blockId: string) => {
      releaseReveal(blockId)
      setCollapsedIds((prev) => {
        if (!prev.has(blockId)) return prev
        const next = new Set(prev)
        next.delete(blockId)
        return next
      })
    },
    [releaseReveal, setCollapsedIds],
  )

  // ── Reveal (transiently un-collapse the ancestor chain) ──────────────
  // #3276 — the navigation-intent consumer (PageEditor) only knows the
  // TARGET block id; it has no way to find and expand whichever ancestors
  // are hiding it. Walk the parent chain from the ref (event-time reads,
  // same discipline as `toggleCollapse` above) and collect every collapsed id
  // found along the way.
  //
  // #4002 — the result becomes the transient overlay INSTEAD of a write to
  // the persisted set, and it REPLACES whatever was revealed before. Callers
  // re-assert the current target on every focus change, so navigating out of
  // the revealed subtree (to a target with no collapsed ancestors) computes
  // an empty overlay and the saved layout snaps back on its own — no separate
  // "restore" call.
  //
  // The release is driven by focus MOVING, not by focus being lost: clearing
  // `focusedBlockId` to null (editor blur, Escape, the `beforeCollapse` focus
  // rescue) makes BlockTree's effect bail before this call, so the overlay
  // outlives the blur and the revealed ancestors stay open until the next
  // focused block. That is deliberate — slamming the subtree shut under a
  // reader who merely clicked away would be worse — and it is bounded: the
  // overlay never exceeds one ancestor chain, is replaced wholesale by the
  // next reveal, and is dropped entirely on page change and unmount. Nothing
  // in it is ever persisted, so a stranded overlay cannot outlive a reload.
  const expandAncestors = useCallback((blockId: string) => {
    setRevealedIds((prev) => {
      const persisted = persistedCollapsedIdsRef.current
      // Nothing saved as collapsed and nothing revealed — skip the O(n) map
      // build entirely (this runs on every focus move).
      if (persisted.size === 0) return prev.size === 0 ? prev : NO_REVEAL
      const byId = new Map(blocksRef.current.map((b) => [b.id, b]))
      const next = new Set<string>()
      let cursor = byId.get(blockId)?.parent_id ?? null
      const visited = new Set<string>()
      while (cursor !== null && !visited.has(cursor)) {
        visited.add(cursor)
        if (persisted.has(cursor)) next.add(cursor)
        cursor = byId.get(cursor)?.parent_id ?? null
      }
      if (sameIds(prev, next)) return prev
      return next.size === 0 ? NO_REVEAL : next
    })
  }, [])

  // ── hasChildren set ────────────────────────────────────────────────
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

  // ── Visible blocks after collapse filtering ────────────────────────
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

  return {
    collapsedIds,
    toggleCollapse,
    expandBlock,
    expandAncestors,
    visibleBlocks,
    hasChildrenSet,
  }
}
