// @vitest-environment jsdom
// `vi.spyOn(Storage.prototype, 'setItem')` doesn't intercept
// `localStorage.setItem` calls under happy-dom (its Storage impl bypasses
// the prototype method). Pin to jsdom until the spy pattern is refactored
// to target the instance directly.

/**
 * Tests for useBlockCollapse hook.
 *
 * Validates:
 * - Initial state with empty collapsedIds
 * - localStorage persistence of collapsed IDs
 * - toggleCollapse adds/removes block IDs
 * - onBeforeCollapse is called when collapsing (not expanding)
 * - visibleBlocks filters out descendants of collapsed blocks
 * - hasChildrenSet correctly identifies parent blocks
 * - Multiple levels of nesting collapse correctly
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { makeBlock } from '@/__tests__/fixtures'
import { useBlockCollapse } from '@/components/block-tree/use-block-collapse'
import type { FlatBlock } from '@/lib/tree-utils'

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
})

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('useBlockCollapse', () => {
  const flatBlocks: FlatBlock[] = [
    makeBlock({ id: 'A', depth: 0, content: 'Block A' }),
    makeBlock({ id: 'B', depth: 1, parent_id: 'A', content: 'Block B' }),
    makeBlock({ id: 'C', depth: 2, parent_id: 'B', content: 'Block C' }),
    makeBlock({ id: 'D', depth: 1, parent_id: 'A', content: 'Block D' }),
    makeBlock({ id: 'E', depth: 0, content: 'Block E' }),
  ]

  it('starts with empty collapsedIds', () => {
    const { result } = renderHook(() => useBlockCollapse(flatBlocks))
    expect(result.current.collapsedIds.size).toBe(0)
  })

  it('returns all blocks as visibleBlocks when nothing is collapsed', () => {
    const { result } = renderHook(() => useBlockCollapse(flatBlocks))
    expect(result.current.visibleBlocks).toEqual(flatBlocks)
  })

  it('correctly identifies hasChildrenSet', () => {
    const { result } = renderHook(() => useBlockCollapse(flatBlocks))
    // A has child B (depth 0 -> 1), B has child C (depth 1 -> 2)
    expect(result.current.hasChildrenSet.has('A')).toBe(true)
    expect(result.current.hasChildrenSet.has('B')).toBe(true)
    // D and E have no children
    expect(result.current.hasChildrenSet.has('D')).toBe(false)
    expect(result.current.hasChildrenSet.has('E')).toBe(false)
    // C has no children
    expect(result.current.hasChildrenSet.has('C')).toBe(false)
  })

  it('toggleCollapse adds a block ID to collapsedIds', () => {
    const { result } = renderHook(() => useBlockCollapse(flatBlocks))

    act(() => {
      result.current.toggleCollapse('A')
    })

    expect(result.current.collapsedIds.has('A')).toBe(true)
  })

  it('toggleCollapse removes a block ID from collapsedIds when toggled again', () => {
    const { result } = renderHook(() => useBlockCollapse(flatBlocks))

    act(() => {
      result.current.toggleCollapse('A')
    })
    expect(result.current.collapsedIds.has('A')).toBe(true)

    act(() => {
      result.current.toggleCollapse('A')
    })
    expect(result.current.collapsedIds.has('A')).toBe(false)
  })

  // #1636 — toggleCollapse must stay referentially stable across
  // collapse/expand so memoized consumers aren't churned. It reads prior
  // membership via a ref, not the `collapsedIds` dep.
  it('keeps toggleCollapse referentially stable across collapse changes', () => {
    const { result } = renderHook(() => useBlockCollapse(flatBlocks))

    const initial = result.current.toggleCollapse

    act(() => {
      result.current.toggleCollapse('A')
    })
    expect(result.current.collapsedIds.has('A')).toBe(true)
    expect(result.current.toggleCollapse).toBe(initial)

    act(() => {
      result.current.toggleCollapse('A')
    })
    expect(result.current.collapsedIds.has('A')).toBe(false)
    expect(result.current.toggleCollapse).toBe(initial)
  })

  it('expandBlock expands a collapsed block and persists the expanded state', () => {
    localStorage.setItem('collapsed_ids:PAGE_1', JSON.stringify(['A']))
    const { result } = renderHook(() => useBlockCollapse(flatBlocks, { pageKey: 'PAGE_1' }))

    expect(result.current.visibleBlocks.map((block) => block.id)).toEqual(['A', 'E'])

    act(() => {
      result.current.expandBlock('A')
    })

    expect(result.current.collapsedIds.has('A')).toBe(false)
    expect(result.current.visibleBlocks).toEqual(flatBlocks)
    expect(JSON.parse(localStorage.getItem('collapsed_ids:PAGE_1') as string)).toEqual([])
  })

  it('keeps expandBlock stable and leaves an already-expanded block unchanged', () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
    const onBeforeCollapse = vi.fn()
    const { result } = renderHook(() =>
      useBlockCollapse(flatBlocks, { pageKey: 'PAGE_1', onBeforeCollapse }),
    )
    const initialExpand = result.current.expandBlock

    act(() => {
      result.current.expandBlock('A')
    })

    expect(result.current.collapsedIds.has('A')).toBe(false)
    expect(result.current.expandBlock).toBe(initialExpand)
    expect(onBeforeCollapse).not.toHaveBeenCalled()
    expect(setItemSpy).not.toHaveBeenCalled()

    act(() => {
      result.current.toggleCollapse('A')
    })
    expect(result.current.expandBlock).toBe(initialExpand)

    act(() => {
      result.current.expandBlock('A')
    })
    expect(result.current.collapsedIds.has('A')).toBe(false)
    expect(result.current.expandBlock).toBe(initialExpand)
    expect(onBeforeCollapse).toHaveBeenCalledTimes(1)
  })

  it('filters descendants of collapsed blocks from visibleBlocks', () => {
    const { result } = renderHook(() => useBlockCollapse(flatBlocks))

    act(() => {
      result.current.toggleCollapse('A')
    })

    const visibleIds = result.current.visibleBlocks.map((b) => b.id)
    // A is visible (it's collapsed, not hidden), B, C, D are descendants hidden
    expect(visibleIds).toEqual(['A', 'E'])
  })

  it('collapsing a nested parent hides only its descendants', () => {
    const { result } = renderHook(() => useBlockCollapse(flatBlocks))

    act(() => {
      result.current.toggleCollapse('B')
    })

    const visibleIds = result.current.visibleBlocks.map((b) => b.id)
    // B is collapsed, so C is hidden, but A, D, E remain
    expect(visibleIds).toEqual(['A', 'B', 'D', 'E'])
  })

  it('calls onBeforeCollapse when collapsing (not expanding)', () => {
    const onBeforeCollapse = vi.fn()
    const { result } = renderHook(() => useBlockCollapse(flatBlocks, { onBeforeCollapse }))

    // First toggle: collapse
    act(() => {
      result.current.toggleCollapse('A')
    })
    expect(onBeforeCollapse).toHaveBeenCalledWith('A')
    expect(onBeforeCollapse).toHaveBeenCalledTimes(1)

    // Second toggle: expand — should NOT call onBeforeCollapse
    act(() => {
      result.current.toggleCollapse('A')
    })
    expect(onBeforeCollapse).toHaveBeenCalledTimes(1)
  })

  // #752 — persistence is scoped per page (`collapsed_ids:<pageKey>`), not
  // the old single global `collapsed_ids` key shared across all pages/spaces.
  it('persists collapsed IDs to the page-scoped localStorage key', () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
    const { result } = renderHook(() => useBlockCollapse(flatBlocks, { pageKey: 'PAGE_1' }))

    act(() => {
      result.current.toggleCollapse('A')
    })

    expect(setItemSpy).toHaveBeenCalledWith('collapsed_ids:PAGE_1', expect.any(String))
    const stored = JSON.parse(setItemSpy.mock.calls[0]?.[1] as string) as string[]
    expect(stored).toContain('A')
    // The legacy global key is never written again.
    expect(localStorage.getItem('collapsed_ids')).toBeNull()
  })

  it('restores collapsed IDs from the page-scoped localStorage key on init', () => {
    localStorage.setItem('collapsed_ids:PAGE_1', JSON.stringify(['B']))

    const { result } = renderHook(() => useBlockCollapse(flatBlocks, { pageKey: 'PAGE_1' }))

    expect(result.current.collapsedIds.has('B')).toBe(true)
    const visibleIds = result.current.visibleBlocks.map((b) => b.id)
    // B is collapsed, C is hidden
    expect(visibleIds).toEqual(['A', 'B', 'D', 'E'])
  })

  it('falls back to the legacy global key when the page has no scoped entry (#752 migration)', () => {
    localStorage.setItem('collapsed_ids', JSON.stringify(['B']))

    const { result } = renderHook(() => useBlockCollapse(flatBlocks, { pageKey: 'PAGE_1' }))

    expect(result.current.collapsedIds.has('B')).toBe(true)
  })

  it('prefers the scoped entry over the legacy global key', () => {
    localStorage.setItem('collapsed_ids', JSON.stringify(['B']))
    localStorage.setItem('collapsed_ids:PAGE_1', JSON.stringify(['A']))

    const { result } = renderHook(() => useBlockCollapse(flatBlocks, { pageKey: 'PAGE_1' }))

    expect(result.current.collapsedIds.has('A')).toBe(true)
    expect(result.current.collapsedIds.has('B')).toBe(false)
  })

  it('prunes ids no longer on the page when persisting (#752)', () => {
    // 'GONE' was collapsed once (e.g. inherited from the legacy key or a
    // since-deleted block) but is not in `flatBlocks` any more.
    localStorage.setItem('collapsed_ids:PAGE_1', JSON.stringify(['GONE', 'B']))
    const { result } = renderHook(() => useBlockCollapse(flatBlocks, { pageKey: 'PAGE_1' }))

    act(() => {
      result.current.toggleCollapse('A')
    })

    const stored = JSON.parse(localStorage.getItem('collapsed_ids:PAGE_1') as string) as string[]
    expect(stored.toSorted()).toEqual(['A', 'B'])
  })

  it('reloads persisted state when pageKey changes (page switch without remount)', () => {
    localStorage.setItem('collapsed_ids:PAGE_1', JSON.stringify(['A']))
    localStorage.setItem('collapsed_ids:PAGE_2', JSON.stringify(['B']))

    const { result, rerender } = renderHook(
      ({ pageKey }: { pageKey: string }) => useBlockCollapse(flatBlocks, { pageKey }),
      { initialProps: { pageKey: 'PAGE_1' } },
    )
    expect(result.current.collapsedIds.has('A')).toBe(true)

    rerender({ pageKey: 'PAGE_2' })

    expect(result.current.collapsedIds.has('B')).toBe(true)
    expect(result.current.collapsedIds.has('A')).toBe(false)
  })

  it('does not persist when pageKey is absent (in-memory only)', () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
    const { result } = renderHook(() => useBlockCollapse(flatBlocks))

    act(() => {
      result.current.toggleCollapse('A')
    })

    expect(result.current.collapsedIds.has('A')).toBe(true)
    expect(setItemSpy).not.toHaveBeenCalled()
  })

  it('handles empty block list gracefully', () => {
    const { result } = renderHook(() => useBlockCollapse([]))
    expect(result.current.visibleBlocks).toEqual([])
    expect(result.current.hasChildrenSet.size).toBe(0)
  })

  it('handles blocks with no parent-child relationships', () => {
    const flatList = [
      makeBlock({ id: 'X', depth: 0, content: 'Block X' }),
      makeBlock({ id: 'Y', depth: 0, content: 'Block Y' }),
      makeBlock({ id: 'Z', depth: 0, content: 'Block Z' }),
    ]
    const { result } = renderHook(() => useBlockCollapse(flatList))
    expect(result.current.hasChildrenSet.size).toBe(0)
    expect(result.current.visibleBlocks).toEqual(flatList)
  })

  // #3276 — navigating to a block hidden under a collapsed ancestor was a
  // silent no-op: the store had the block, but nothing ever expanded the
  // collapsed chain hiding it from `visibleBlocks`. `expandAncestors` is the
  // reveal primitive BlockTree wires to focus navigation.
  describe('expandAncestors (#3276)', () => {
    it('expands every collapsed ancestor so a deeply-nested target becomes visible', () => {
      const { result } = renderHook(() => useBlockCollapse(flatBlocks))

      // Collapse both A (grandparent) and B (parent) — C is now doubly hidden.
      act(() => {
        result.current.toggleCollapse('A')
      })
      act(() => {
        result.current.toggleCollapse('B')
      })

      // Precondition: C is genuinely unreachable before the reveal call —
      // this is the silent no-op the issue describes, not a tautology.
      expect(result.current.visibleBlocks.some((b) => b.id === 'C')).toBe(false)

      act(() => {
        result.current.expandAncestors('C')
      })

      // C must actually be reachable now — both ancestors expanded, not just
      // "no throw".
      expect(result.current.collapsedIds.has('A')).toBe(false)
      expect(result.current.collapsedIds.has('B')).toBe(false)
      expect(result.current.visibleBlocks.some((b) => b.id === 'C')).toBe(true)
    })

    it('is a no-op when no ancestor is collapsed', () => {
      const { result } = renderHook(() => useBlockCollapse(flatBlocks))
      const before = result.current.collapsedIds

      act(() => {
        result.current.expandAncestors('C')
      })

      // Reference-stable — mirrors expandBlock's no-churn-when-unnecessary
      // discipline (see setCollapsedIds's `next === prev` bail).
      expect(result.current.collapsedIds).toBe(before)
    })

    it('does not collapse or otherwise touch the target block itself', () => {
      const { result } = renderHook(() => useBlockCollapse(flatBlocks))
      act(() => {
        result.current.toggleCollapse('A')
      })

      act(() => {
        result.current.expandAncestors('C')
      })

      expect(result.current.collapsedIds.has('C')).toBe(false)
    })
  })

  // #4002 — #3276's reveal routed through the persisting setter, so following
  // one backlink into a collapsed subtree DELETED those ancestors from the
  // user's saved layout for good (no undo, survives reload). The reveal is now
  // ephemeral: the ancestors are expanded for the visit only, the persisted
  // `collapsed_ids:<pageKey>` entry is left alone, and the saved layout comes
  // back as soon as focus leaves the revealed subtree.
  describe('expandAncestors is an ephemeral reveal (#4002)', () => {
    const stored = () =>
      (JSON.parse(localStorage.getItem('collapsed_ids:PAGE_1') as string) as string[]).toSorted()

    it('reveals the target WITHOUT rewriting the persisted collapse layout', () => {
      localStorage.setItem('collapsed_ids:PAGE_1', JSON.stringify(['A', 'B']))
      const { result } = renderHook(() => useBlockCollapse(flatBlocks, { pageKey: 'PAGE_1' }))

      // Precondition: C really is hidden under two collapsed ancestors.
      expect(result.current.visibleBlocks.some((b) => b.id === 'C')).toBe(false)

      act(() => {
        result.current.expandAncestors('C')
      })

      // Arm 1 — the reveal still works. A "fix" that simply stopped revealing
      // anything must not pass this test.
      expect(result.current.collapsedIds.has('A')).toBe(false)
      expect(result.current.collapsedIds.has('B')).toBe(false)
      expect(result.current.visibleBlocks.some((b) => b.id === 'C')).toBe(true)

      // Arm 2 — the SAVED layout is untouched (the #4002 regression).
      expect(stored()).toEqual(['A', 'B'])
    })

    it('restores the collapsed layout once focus moves out of the revealed subtree', () => {
      localStorage.setItem('collapsed_ids:PAGE_1', JSON.stringify(['A', 'B']))
      const { result } = renderHook(() => useBlockCollapse(flatBlocks, { pageKey: 'PAGE_1' }))

      act(() => {
        result.current.expandAncestors('C')
      })
      expect(result.current.visibleBlocks.some((b) => b.id === 'C')).toBe(true)

      // Focus moves to a root-level block with no collapsed ancestors: the
      // transient reveal is released.
      act(() => {
        result.current.expandAncestors('E')
      })

      expect(result.current.collapsedIds.has('A')).toBe(true)
      expect(result.current.collapsedIds.has('B')).toBe(true)
      expect(result.current.visibleBlocks.map((b) => b.id)).toEqual(['A', 'E'])
      expect(stored()).toEqual(['A', 'B'])
    })

    it('keeps a revealed subtree revealed while focus stays inside it', () => {
      localStorage.setItem('collapsed_ids:PAGE_1', JSON.stringify(['A']))
      const { result } = renderHook(() => useBlockCollapse(flatBlocks, { pageKey: 'PAGE_1' }))

      act(() => {
        result.current.expandAncestors('C')
      })
      // A sibling deeper in the same collapsed subtree keeps the reveal.
      act(() => {
        result.current.expandAncestors('D')
      })

      expect(result.current.collapsedIds.has('A')).toBe(false)
      expect(result.current.visibleBlocks.some((b) => b.id === 'C')).toBe(true)
      expect(stored()).toEqual(['A'])
    })

    it('lets a manual collapse of a transiently revealed ancestor win and persist', () => {
      localStorage.setItem('collapsed_ids:PAGE_1', JSON.stringify(['A']))
      const onBeforeCollapse = vi.fn()
      const { result } = renderHook(() =>
        useBlockCollapse(flatBlocks, { pageKey: 'PAGE_1', onBeforeCollapse }),
      )

      act(() => {
        result.current.expandAncestors('C')
      })
      expect(result.current.collapsedIds.has('A')).toBe(false)
      // Pinned mid-flight, NOT only at the end: the end-state `['A']` below is
      // also what the pre-#4002 persisting reveal produced (it deleted A here
      // and the toggle re-added it), so without this line the test is green
      // against the very behaviour #4002 is about.
      expect(stored()).toEqual(['A'])

      // A now RENDERS as expanded, so the user's chevron click means "collapse"
      // — not "expand again" off the stale persisted value.
      act(() => {
        result.current.toggleCollapse('A')
      })

      expect(onBeforeCollapse).toHaveBeenCalledWith('A')
      expect(result.current.collapsedIds.has('A')).toBe(true)
      expect(result.current.visibleBlocks.map((b) => b.id)).toEqual(['A', 'E'])
      expect(stored()).toEqual(['A'])
    })

    it('lets a manual expand of a transiently revealed ancestor persist the expansion', () => {
      localStorage.setItem('collapsed_ids:PAGE_1', JSON.stringify(['A', 'B']))
      const { result } = renderHook(() => useBlockCollapse(flatBlocks, { pageKey: 'PAGE_1' }))

      act(() => {
        result.current.expandAncestors('C')
      })
      // The user commits the reveal for A by clicking its chevron twice
      // (collapse, then expand): A leaves the saved layout for real.
      act(() => {
        result.current.toggleCollapse('A')
      })
      act(() => {
        result.current.toggleCollapse('A')
      })

      expect(result.current.collapsedIds.has('A')).toBe(false)
      expect(stored()).toEqual(['B'])

      // Leaving the subtree no longer resurrects A, but B (never touched) is
      // still saved and comes back.
      act(() => {
        result.current.expandAncestors('E')
      })
      expect(result.current.collapsedIds.has('A')).toBe(false)
      expect(result.current.collapsedIds.has('B')).toBe(true)
      expect(stored()).toEqual(['B'])
    })

    // Zoom (`expandBlock`) lands in the middle of a reveal: its expansion is
    // an explicit user action and MUST persist, while the sibling ancestors
    // the reveal is holding open must still not reach storage. Nothing else
    // exercised `expandBlock` against a live overlay.
    //
    // Note on the `releaseReveal(blockId)` call inside `expandBlock`: it
    // maintains the "overlay ⊆ persisted" invariant but is not observable —
    // deleting an overlay id that is no longer in the persisted set is a
    // no-op for the effective set, and `toggleCollapse` releases the id
    // before it could ever be re-added. Deleting that line keeps this (and
    // every other) test green; it is kept as invariant maintenance, not
    // because a test pins it.
    it('persists a zoom expansion mid-reveal without persisting the reveal itself', () => {
      localStorage.setItem('collapsed_ids:PAGE_1', JSON.stringify(['A', 'B']))
      const { result } = renderHook(() => useBlockCollapse(flatBlocks, { pageKey: 'PAGE_1' }))

      act(() => {
        result.current.expandAncestors('C')
      })
      act(() => {
        result.current.expandBlock('B')
      })

      // B's expansion is the user's and is saved; A is only revealed, so the
      // saved layout still has it.
      expect(stored()).toEqual(['A'])

      // Focus leaves: A comes back collapsed, B stays expanded for real.
      act(() => {
        result.current.expandAncestors('E')
      })
      expect(result.current.collapsedIds.has('A')).toBe(true)
      expect(result.current.collapsedIds.has('B')).toBe(false)
      expect(result.current.visibleBlocks.map((b) => b.id)).toEqual(['A', 'E'])
      expect(stored()).toEqual(['A'])
    })

    it('drops a transient reveal when the page changes', () => {
      localStorage.setItem('collapsed_ids:PAGE_1', JSON.stringify(['A']))
      localStorage.setItem('collapsed_ids:PAGE_2', JSON.stringify(['B']))
      const { result, rerender } = renderHook(
        ({ pageKey }: { pageKey: string }) => useBlockCollapse(flatBlocks, { pageKey }),
        { initialProps: { pageKey: 'PAGE_1' } },
      )

      act(() => {
        result.current.expandAncestors('C')
      })
      expect(result.current.collapsedIds.has('A')).toBe(false)

      rerender({ pageKey: 'PAGE_2' })

      expect(result.current.collapsedIds.has('B')).toBe(true)
      expect(result.current.collapsedIds.has('A')).toBe(false)

      rerender({ pageKey: 'PAGE_1' })

      // Back on PAGE_1 the saved layout is intact — the reveal did not leak
      // across the page switch either as state or as a write.
      expect(result.current.collapsedIds.has('A')).toBe(true)
      expect(stored()).toEqual(['A'])
    })

    // #4038 note 3 — the JSDoc used to promise a reference-stable no-op for an
    // unknown id, which was never what the code did. The doc now states the
    // real (and safer) behaviour: an unknown target reveals nothing, so it
    // releases the overlay exactly like a target with no collapsed ancestors.
    // Pinned here so the doc and the code cannot drift apart again —
    // `BlockTree`'s `blocksById.has(...)` guard means no production caller
    // reaches it, so nothing else would notice a change.
    it('releases the reveal when asked to reveal an id that is not on the page', () => {
      localStorage.setItem('collapsed_ids:PAGE_1', JSON.stringify(['A']))
      const { result } = renderHook(() => useBlockCollapse(flatBlocks, { pageKey: 'PAGE_1' }))

      act(() => {
        result.current.expandAncestors('C')
      })
      expect(result.current.collapsedIds.has('A')).toBe(false)

      act(() => {
        result.current.expandAncestors('GONE')
      })

      expect(result.current.collapsedIds.has('A')).toBe(true)
      expect(result.current.visibleBlocks.map((b) => b.id)).toEqual(['A', 'E'])
      expect(stored()).toEqual(['A'])
    })
  })
})
