/**
 * Tests for useBlockZoom hook.
 *
 * Validates:
 * - Initial state (no zoom, empty breadcrumbs, passthrough visibleBlocks)
 * - zoomIn sets zoomedBlockId and computes breadcrumbs
 * - zoomOut navigates to parent block
 * - zoomOut at top level returns to root (null)
 * - zoomToRoot resets zoom state
 * - breadcrumbs builds correct trail from zoomed block to root
 * - zoomedVisible filters and depth-adjusts descendant blocks
 * - Falls back to collapseVisible when zoomed block not found
 * - #4038: while zoomed, collapse is re-applied WITHIN the pane (from the
 *   unfiltered tree) instead of being inherited from the page-wide filtering
 */

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeBlock } from '@/__tests__/fixtures'
import { useBlockZoom } from '@/components/block-tree/use-block-zoom'
import { __resetBackHandlersForTests, runBackChain } from '@/lib/back-chain'
import type { FlatBlock } from '@/lib/tree-utils'

vi.mock('@/lib/tree-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tree-utils')>()
  return {
    ...actual,
    // Use real getDragDescendants so zoom filtering works correctly in tests
  }
})

/** "Nothing collapsed" — the third `useBlockZoom` argument for most cases. */
const NO_COLLAPSE: ReadonlySet<string> = new Set<string>()

describe('useBlockZoom', () => {
  // Tree structure:
  //   A (depth 0)
  //     B (depth 1, parent A)
  //       C (depth 2, parent B)
  //     D (depth 1, parent A)
  //   E (depth 0)
  const allBlocks: FlatBlock[] = [
    makeBlock({ id: 'A', depth: 0, parent_id: null, content: 'Page' }),
    makeBlock({ id: 'B', depth: 1, parent_id: 'A', content: 'Section' }),
    makeBlock({ id: 'C', depth: 2, parent_id: 'B', content: 'Detail' }),
    makeBlock({ id: 'D', depth: 1, parent_id: 'A', content: 'Other' }),
    makeBlock({ id: 'E', depth: 0, parent_id: null, content: 'Second' }),
  ]

  it('starts with no zoom and empty breadcrumbs', () => {
    const { result } = renderHook(() => useBlockZoom(allBlocks, allBlocks, NO_COLLAPSE))
    expect(result.current.zoomedBlockId).toBeNull()
    expect(result.current.breadcrumbs).toEqual([])
  })

  it('returns collapseVisible as-is when not zoomed', () => {
    const { result } = renderHook(() => useBlockZoom(allBlocks, allBlocks, NO_COLLAPSE))
    expect(result.current.zoomedVisible).toEqual(allBlocks)
  })

  it('zoomIn sets the zoomed block ID', () => {
    const { result } = renderHook(() => useBlockZoom(allBlocks, allBlocks, NO_COLLAPSE))

    act(() => {
      result.current.zoomIn('A')
    })

    expect(result.current.zoomedBlockId).toBe('A')
  })

  it('zoomIn computes breadcrumbs from zoomed block to root', () => {
    const { result } = renderHook(() => useBlockZoom(allBlocks, allBlocks, NO_COLLAPSE))

    act(() => {
      result.current.zoomIn('B')
    })

    // Trail: A -> B (B's parent is A, A's parent is null so it stops)
    expect(result.current.breadcrumbs).toEqual([
      { id: 'A', content: 'Page' },
      { id: 'B', content: 'Section' },
    ])
  })

  it('zoomIn to deeply nested block builds full breadcrumb trail', () => {
    const { result } = renderHook(() => useBlockZoom(allBlocks, allBlocks, NO_COLLAPSE))

    act(() => {
      result.current.zoomIn('C')
    })

    expect(result.current.breadcrumbs).toEqual([
      { id: 'A', content: 'Page' },
      { id: 'B', content: 'Section' },
      { id: 'C', content: 'Detail' },
    ])
  })

  it('zoomedVisible filters to descendants and adjusts depth', () => {
    const { result } = renderHook(() => useBlockZoom(allBlocks, allBlocks, NO_COLLAPSE))

    act(() => {
      result.current.zoomIn('A')
    })

    // Descendants of A: B (depth 1), C (depth 2), D (depth 1)
    // Depth offset = A.depth + 1 = 1
    // So B becomes depth 0, C becomes depth 1, D becomes depth 0
    const zoomed = result.current.zoomedVisible
    expect(zoomed.map((b) => b.id)).toEqual(['B', 'C', 'D'])
    expect(zoomed.map((b) => b.depth)).toEqual([0, 1, 0])
  })

  it('zoomOut navigates to parent block', () => {
    const { result } = renderHook(() => useBlockZoom(allBlocks, allBlocks, NO_COLLAPSE))

    act(() => {
      result.current.zoomIn('B')
    })
    expect(result.current.zoomedBlockId).toBe('B')

    act(() => {
      result.current.zoomOut()
    })
    // B's parent is A, which is in the block list
    expect(result.current.zoomedBlockId).toBe('A')
  })

  it('zoomOut at top-level block resets to root', () => {
    const { result } = renderHook(() => useBlockZoom(allBlocks, allBlocks, NO_COLLAPSE))

    act(() => {
      result.current.zoomIn('A')
    })

    act(() => {
      result.current.zoomOut()
    })
    // A has no parent_id, so zoom resets to null
    expect(result.current.zoomedBlockId).toBeNull()
  })

  it('zoomToRoot resets zoom state', () => {
    const { result } = renderHook(() => useBlockZoom(allBlocks, allBlocks, NO_COLLAPSE))

    act(() => {
      result.current.zoomIn('C')
    })
    expect(result.current.zoomedBlockId).toBe('C')

    act(() => {
      result.current.zoomToRoot()
    })
    expect(result.current.zoomedBlockId).toBeNull()
    expect(result.current.breadcrumbs).toEqual([])
  })

  it('falls back to collapseVisible when zoomed block not found in blocks', () => {
    const { result } = renderHook(() => useBlockZoom(allBlocks, allBlocks, NO_COLLAPSE))

    act(() => {
      result.current.zoomIn('NONEXISTENT')
    })

    // Should fallback to collapseVisible
    expect(result.current.zoomedVisible).toEqual(allBlocks)
  })

  it('zoomOut does nothing when not zoomed', () => {
    const { result } = renderHook(() => useBlockZoom(allBlocks, allBlocks, NO_COLLAPSE))

    act(() => {
      result.current.zoomOut()
    })

    expect(result.current.zoomedBlockId).toBeNull()
  })

  it('handles block with null content in breadcrumbs', () => {
    const blocksWithNull: FlatBlock[] = [
      { ...makeBlock({ id: 'X', depth: 0, content: 'Block X' }), content: null },
      makeBlock({ id: 'Y', depth: 1, parent_id: 'X', content: 'Block Y' }),
    ]
    const { result } = renderHook(() => useBlockZoom(blocksWithNull, blocksWithNull, NO_COLLAPSE))

    act(() => {
      result.current.zoomIn('Y')
    })

    expect(result.current.breadcrumbs).toEqual([
      { id: 'X', content: '' },
      { id: 'Y', content: 'Block Y' },
    ])
  })

  // ── #716: Android back-chain integration ──────────────────────────
  describe('back-chain registration (#716)', () => {
    beforeEach(() => {
      __resetBackHandlersForTests()
    })

    it('registers no back handler while not zoomed', () => {
      renderHook(() => useBlockZoom(allBlocks, allBlocks, NO_COLLAPSE))
      expect(runBackChain()).toBe(false)
    })

    it('back press zooms out one level while zoomed', () => {
      const { result } = renderHook(() => useBlockZoom(allBlocks, allBlocks, NO_COLLAPSE))

      act(() => {
        result.current.zoomIn('B')
      })

      let handled = false
      act(() => {
        handled = runBackChain()
      })
      expect(handled).toBe(true)
      expect(result.current.zoomedBlockId).toBe('A')

      act(() => {
        handled = runBackChain()
      })
      expect(handled).toBe(true)
      expect(result.current.zoomedBlockId).toBeNull()

      // Fully zoomed out → handler unregistered → press not consumed.
      expect(runBackChain()).toBe(false)
    })

    it('unmount unregisters the zoom back handler', () => {
      const { result, unmount } = renderHook(() => useBlockZoom(allBlocks, allBlocks, NO_COLLAPSE))

      act(() => {
        result.current.zoomIn('B')
      })
      unmount()

      expect(runBackChain()).toBe(false)
    })
  })

  // ── #4038: the collapse filter the PANE applies is its own ────────────
  // The zoomed projection is derived from the unfiltered tree and re-filtered
  // by the collapsed ids inside the pane. Before #4038 it filtered the
  // page-wide `collapseVisible`, so collapse state at or above the zoom root
  // could subtract from — and in the ancestor case, entirely delete — the
  // contents of an open pane.
  describe('collapse is re-applied within the pane (#4038)', () => {
    it('still hides the children of a block collapsed INSIDE the pane', () => {
      // B is collapsed, so its child C must not render inside a zoom on A.
      // This is the arm that fails if the fix "works" by never filtering.
      const { result } = renderHook(() => useBlockZoom(allBlocks, allBlocks, new Set(['B'])))

      act(() => {
        result.current.zoomIn('A')
      })

      const zoomed = result.current.zoomedVisible
      expect(zoomed.map((b) => b.id)).toEqual(['B', 'D'])
      expect(zoomed.map((b) => b.depth)).toEqual([0, 0])
    })

    it('renders an empty pane for a genuinely empty subtree', () => {
      // C is a leaf: nothing to show, and nothing about #4038 may invent
      // rows for it. (#922's seed effect is what gives the user somewhere to
      // type here; it keys off `hasChildrenSet`, not off this list.)
      const { result } = renderHook(() => useBlockZoom(allBlocks, allBlocks, NO_COLLAPSE))

      act(() => {
        result.current.zoomIn('C')
      })

      expect(result.current.zoomedVisible).toEqual([])
    })

    it('keeps the pane populated when an ANCESTOR of the zoom root is collapsed', () => {
      // The #4038 defect in isolation: A is collapsed, so the page-wide
      // `collapseVisible` contains neither B nor C — and the pane, zoomed
      // into B, filtered down to `[]` while still rendering breadcrumbs.
      const collapseVisible = allBlocks.filter((b) => b.id === 'A' || b.id === 'E')
      const { result } = renderHook(() => useBlockZoom(allBlocks, collapseVisible, new Set(['A'])))

      act(() => {
        result.current.zoomIn('B')
      })

      expect(result.current.zoomedVisible.map((b) => b.id)).toEqual(['C'])
      // The breadcrumbs the empty pane used to be rendered under.
      expect(result.current.breadcrumbs.map((c) => c.id)).toEqual(['A', 'B'])
    })

    it('shows the contents of a zoom root that is itself collapsed', () => {
      // The zoom root is the pane's root, so its own collapsed flag says
      // nothing about the pane. (BlockTree also persists an expand on
      // zoom-in; this must not be the thing that keeps the pane non-empty.)
      const { result } = renderHook(() => useBlockZoom(allBlocks, allBlocks, new Set(['B'])))

      act(() => {
        result.current.zoomIn('B')
      })

      expect(result.current.zoomedVisible.map((b) => b.id)).toEqual(['C'])
    })

    it('scopes Ctrl+A to the same pane-filtered projection', () => {
      const { result } = renderHook(() => useBlockZoom(allBlocks, allBlocks, new Set(['B'])))

      act(() => {
        result.current.zoomIn('A')
      })

      expect(result.current.selectAllIds).toEqual(['B', 'D'])
    })
  })

  describe('rebased row identity (#3253)', () => {
    it('reuses the rebased object for rows whose source block is unchanged', () => {
      const { result, rerender } = renderHook(
        ({ blocks }: { blocks: FlatBlock[] }) => useBlockZoom(blocks, blocks, NO_COLLAPSE),
        { initialProps: { blocks: allBlocks } },
      )

      act(() => {
        result.current.zoomIn('A')
      })

      const first = result.current.zoomedVisible
      expect(first.map((b) => b.id)).toEqual(['B', 'C', 'D'])

      // Mirrors a store write (#2527): every untouched block keeps its exact
      // prior object reference, only the edited one is replaced.
      const editedD = { ...(allBlocks[3] as FlatBlock), content: 'Other (edited)' }
      const nextBlocks = [...allBlocks.slice(0, 3), editedD, allBlocks[4] as FlatBlock]
      rerender({ blocks: nextBlocks })

      const second = result.current.zoomedVisible
      expect(second.map((b) => b.id)).toEqual(['B', 'C', 'D'])
      // Unedited rows keep identity, so their React.memo'd row wrappers
      // short-circuit instead of re-rendering the whole pane.
      expect(second[0]).toBe(first[0])
      expect(second[1]).toBe(first[1])
      // The edited row is re-derived, still with the pane-relative depth.
      expect(second[2]).not.toBe(first[2])
      expect(second[2]?.content).toBe('Other (edited)')
      expect(second.map((b) => b.depth)).toEqual([0, 1, 0])
    })

    it('re-derives rows when the depth offset changes', () => {
      const { result } = renderHook(() => useBlockZoom(allBlocks, allBlocks, NO_COLLAPSE))

      act(() => {
        result.current.zoomIn('A')
      })
      const fromA = result.current.zoomedVisible.find((b) => b.id === 'C')
      expect(fromA?.depth).toBe(1)

      act(() => {
        result.current.zoomIn('B')
      })
      const fromB = result.current.zoomedVisible.find((b) => b.id === 'C')
      expect(fromB?.depth).toBe(0)
      expect(fromB).not.toBe(fromA)
    })
  })
})
