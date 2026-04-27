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
 */

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { makeBlock } from '../../__tests__/fixtures'
import type { FlatBlock } from '../../lib/tree-utils'
import { useBlockZoom } from '../useBlockZoom'

vi.mock('../../lib/tree-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/tree-utils')>()
  return {
    ...actual,
    // Use real getDragDescendants so zoom filtering works correctly in tests
  }
})

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
    const { result } = renderHook(() => useBlockZoom(allBlocks, allBlocks))
    expect(result.current.zoomedBlockId).toBeNull()
    expect(result.current.breadcrumbs).toEqual([])
  })

  it('returns collapseVisible as-is when not zoomed', () => {
    const { result } = renderHook(() => useBlockZoom(allBlocks, allBlocks))
    expect(result.current.zoomedVisible).toEqual(allBlocks)
  })

  it('zoomIn sets the zoomed block ID', () => {
    const { result } = renderHook(() => useBlockZoom(allBlocks, allBlocks))

    act(() => {
      result.current.zoomIn('A')
    })

    expect(result.current.zoomedBlockId).toBe('A')
  })

  it('zoomIn computes breadcrumbs from zoomed block to root', () => {
    const { result } = renderHook(() => useBlockZoom(allBlocks, allBlocks))

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
    const { result } = renderHook(() => useBlockZoom(allBlocks, allBlocks))

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
    const { result } = renderHook(() => useBlockZoom(allBlocks, allBlocks))

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
    const { result } = renderHook(() => useBlockZoom(allBlocks, allBlocks))

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
    const { result } = renderHook(() => useBlockZoom(allBlocks, allBlocks))

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
    const { result } = renderHook(() => useBlockZoom(allBlocks, allBlocks))

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
    const { result } = renderHook(() => useBlockZoom(allBlocks, allBlocks))

    act(() => {
      result.current.zoomIn('NONEXISTENT')
    })

    // Should fallback to collapseVisible
    expect(result.current.zoomedVisible).toEqual(allBlocks)
  })

  it('zoomOut does nothing when not zoomed', () => {
    const { result } = renderHook(() => useBlockZoom(allBlocks, allBlocks))

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
    const { result } = renderHook(() => useBlockZoom(blocksWithNull, blocksWithNull))

    act(() => {
      result.current.zoomIn('Y')
    })

    expect(result.current.breadcrumbs).toEqual([
      { id: 'X', content: '' },
      { id: 'Y', content: 'Block Y' },
    ])
  })

  it('respects collapseVisible filtering when zoomed', () => {
    // If C is collapsed away in collapseVisible, it shouldn't appear in zoomedVisible
    const collapseVisible = allBlocks.filter((b) => b.id !== 'C')

    const { result } = renderHook(() => useBlockZoom(allBlocks, collapseVisible))

    act(() => {
      result.current.zoomIn('A')
    })

    const zoomedIds = result.current.zoomedVisible.map((b) => b.id)
    expect(zoomedIds).toEqual(['B', 'D']) // C is filtered out
  })
})
