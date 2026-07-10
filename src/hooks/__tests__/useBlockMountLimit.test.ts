/**
 * Tests for useBlockMountLimit hook (#2467 — frontend mount envelope).
 *
 * Validates:
 * - Below the cap: every row mounts, identical reference, no hidden count
 * - At exactly the cap: still no hidden count (boundary is exclusive)
 * - Above the cap: mounted truncates to the limit, hiddenCount is the rest
 * - expandMountLimit reveals the next batch (interaction correctness at
 *   the boundary — this is the "deferred node loads/mounts it" behavior)
 * - Repeated expansion keeps revealing more until everything mounts
 * - The mount limit resets when `pageKey` changes (page switch without
 *   BlockTree remounting)
 * - Custom initialLimit / step options are honoured
 */

import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { makeBlock } from '../../__tests__/fixtures'
import type { FlatBlock } from '../../lib/tree-utils'
import { INITIAL_MOUNT_LIMIT, MOUNT_LIMIT_STEP, useBlockMountLimit } from '../useBlockMountLimit'

function makeFlatBlocks(count: number): FlatBlock[] {
  return Array.from({ length: count }, (_, i) => makeBlock({ id: `BLK_${i}`, content: `b${i}` }))
}

describe('useBlockMountLimit', () => {
  it('mounts every row and reports no hidden count when below the cap', () => {
    const blocks = makeFlatBlocks(10)
    const { result } = renderHook(() => useBlockMountLimit(blocks, { initialLimit: 500 }))

    expect(result.current.mounted).toBe(blocks) // referentially stable, not a copy
    expect(result.current.hiddenCount).toBe(0)
  })

  it('mounts every row when the count exactly equals the cap', () => {
    const blocks = makeFlatBlocks(500)
    const { result } = renderHook(() => useBlockMountLimit(blocks, { initialLimit: 500 }))

    expect(result.current.mounted).toHaveLength(500)
    expect(result.current.hiddenCount).toBe(0)
  })

  it('caps mounted rows and reports the overflow when above the limit', () => {
    const blocks = makeFlatBlocks(1200)
    const { result } = renderHook(() => useBlockMountLimit(blocks, { initialLimit: 500 }))

    expect(result.current.mounted).toHaveLength(500)
    expect(result.current.mounted[0]?.id).toBe('BLK_0')
    expect(result.current.mounted[499]?.id).toBe('BLK_499')
    expect(result.current.hiddenCount).toBe(700)
  })

  it('uses the exported default constants when no options are given', () => {
    const blocks = makeFlatBlocks(INITIAL_MOUNT_LIMIT + 10)
    const { result } = renderHook(() => useBlockMountLimit(blocks))

    expect(result.current.mounted).toHaveLength(INITIAL_MOUNT_LIMIT)
    expect(result.current.hiddenCount).toBe(10)
  })

  it('expandMountLimit reveals the next batch (deferred rows mount)', () => {
    const blocks = makeFlatBlocks(1200)
    const { result, rerender } = renderHook(
      ({ b }) => useBlockMountLimit(b, { initialLimit: 500, step: 500 }),
      { initialProps: { b: blocks } },
    )

    expect(result.current.mounted).toHaveLength(500)
    expect(result.current.hiddenCount).toBe(700)

    result.current.expandMountLimit()
    rerender({ b: blocks })

    expect(result.current.mounted).toHaveLength(1000)
    expect(result.current.mounted[999]?.id).toBe('BLK_999')
    expect(result.current.hiddenCount).toBe(200)
  })

  it('repeated expansion eventually mounts everything', () => {
    const blocks = makeFlatBlocks(1200)
    const { result, rerender } = renderHook(
      ({ b }) => useBlockMountLimit(b, { initialLimit: 500, step: 500 }),
      { initialProps: { b: blocks } },
    )

    result.current.expandMountLimit()
    rerender({ b: blocks })
    result.current.expandMountLimit()
    rerender({ b: blocks })

    expect(result.current.mounted).toHaveLength(1200)
    expect(result.current.hiddenCount).toBe(0)
  })

  it('honours a custom step size', () => {
    const blocks = makeFlatBlocks(300)
    const { result, rerender } = renderHook(
      ({ b }) => useBlockMountLimit(b, { initialLimit: 100, step: 50 }),
      { initialProps: { b: blocks } },
    )

    expect(result.current.hiddenCount).toBe(200)
    result.current.expandMountLimit()
    rerender({ b: blocks })
    expect(result.current.mounted).toHaveLength(150)
    expect(result.current.hiddenCount).toBe(150)
  })

  it('uses the exported default step constant', () => {
    const blocks = makeFlatBlocks(INITIAL_MOUNT_LIMIT + MOUNT_LIMIT_STEP + 1)
    const { result, rerender } = renderHook(({ b }) => useBlockMountLimit(b), {
      initialProps: { b: blocks },
    })

    result.current.expandMountLimit()
    rerender({ b: blocks })

    expect(result.current.mounted).toHaveLength(INITIAL_MOUNT_LIMIT + MOUNT_LIMIT_STEP)
    expect(result.current.hiddenCount).toBe(1)
  })

  it('resets the mount limit when pageKey changes (page switch without remount)', () => {
    const blocks = makeFlatBlocks(1200)
    const { result, rerender } = renderHook(
      ({ pageKey }: { pageKey: string }) =>
        useBlockMountLimit(blocks, { initialLimit: 500, step: 500, pageKey }),
      { initialProps: { pageKey: 'PAGE_1' } },
    )

    result.current.expandMountLimit()
    rerender({ pageKey: 'PAGE_1' })
    expect(result.current.mounted).toHaveLength(1000)

    // Switching pages resets the expanded limit back to the initial cap.
    rerender({ pageKey: 'PAGE_2' })
    expect(result.current.mounted).toHaveLength(500)
  })

  it('does not reset the mount limit on re-render when pageKey is unchanged', () => {
    const blocks = makeFlatBlocks(1200)
    const { result, rerender } = renderHook(
      ({ pageKey }: { pageKey: string | null }) =>
        useBlockMountLimit(blocks, { initialLimit: 500, step: 500, pageKey }),
      { initialProps: { pageKey: null } },
    )

    result.current.expandMountLimit()
    rerender({ pageKey: null })
    expect(result.current.mounted).toHaveLength(1000)

    rerender({ pageKey: null })
    expect(result.current.mounted).toHaveLength(1000)
  })

  it('handles an empty block list gracefully', () => {
    const { result } = renderHook(() => useBlockMountLimit([]))
    expect(result.current.mounted).toEqual([])
    expect(result.current.hiddenCount).toBe(0)
  })

  it('expandMountLimit keeps a stable identity across re-renders (mirrors toggleCollapse #1636)', () => {
    const blocks = makeFlatBlocks(1200)
    const { result, rerender } = renderHook(
      ({ b }) => useBlockMountLimit(b, { initialLimit: 500, step: 500 }),
      { initialProps: { b: blocks } },
    )

    const initial = result.current.expandMountLimit
    result.current.expandMountLimit()
    rerender({ b: blocks })
    expect(result.current.expandMountLimit).toBe(initial)
  })
})
