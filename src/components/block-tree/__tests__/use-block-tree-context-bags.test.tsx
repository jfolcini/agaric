/**
 * Tests for useBlockTreeContextBags.
 *
 * The hook's whole point is identity stability — the returned `blockActions`
 * and `blockResolvers` are consumed via context and feed React.memo'd
 * descendants. If a dep changes the bag identity must change; if no deps
 * change the bag must keep its identity. These tests pin both halves of
 * that contract for the 14 actions + 4 resolvers.
 */

import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import {
  type UseBlockTreeContextBagsParams,
  useBlockTreeContextBags,
} from '../use-block-tree-context-bags'

function makeParams(
  overrides: Partial<UseBlockTreeContextBagsParams> = {},
): UseBlockTreeContextBagsParams {
  return {
    onNavigate: vi.fn(),
    onDelete: vi.fn(),
    onIndent: vi.fn(),
    onDedent: vi.fn(),
    onMoveUp: vi.fn(),
    onMoveDown: vi.fn(),
    onMerge: vi.fn(),
    onToggleTodo: vi.fn(),
    onTogglePriority: vi.fn(),
    onToggleCollapse: vi.fn(),
    onShowHistory: vi.fn(),
    onShowProperties: vi.fn(),
    onZoomIn: vi.fn(),
    onSelect: vi.fn(),
    resolveBlockTitle: vi.fn(),
    resolveTagName: vi.fn(),
    resolveBlockStatus: vi.fn(),
    resolveTagStatus: vi.fn(),
    ...overrides,
  }
}

describe('useBlockTreeContextBags', () => {
  it('preserves bag identity across renders when all deps are stable', () => {
    const params = makeParams()
    const { result, rerender } = renderHook(
      (p: UseBlockTreeContextBagsParams) => useBlockTreeContextBags(p),
      { initialProps: params },
    )

    const first = result.current
    rerender(params) // same params → memo hits
    const second = result.current

    expect(second.blockActions).toBe(first.blockActions)
    expect(second.blockResolvers).toBe(first.blockResolvers)
  })

  it('rebuilds blockActions when one action callback identity changes', () => {
    const params = makeParams()
    const { result, rerender } = renderHook(
      (p: UseBlockTreeContextBagsParams) => useBlockTreeContextBags(p),
      { initialProps: params },
    )

    const firstActions = result.current.blockActions
    const firstResolvers = result.current.blockResolvers

    rerender({ ...params, onDelete: vi.fn() })

    expect(result.current.blockActions).not.toBe(firstActions)
    // Resolvers must stay stable — independent memo.
    expect(result.current.blockResolvers).toBe(firstResolvers)
  })

  it('rebuilds blockResolvers when one resolver identity changes', () => {
    const params = makeParams()
    const { result, rerender } = renderHook(
      (p: UseBlockTreeContextBagsParams) => useBlockTreeContextBags(p),
      { initialProps: params },
    )

    const firstActions = result.current.blockActions
    const firstResolvers = result.current.blockResolvers

    rerender({ ...params, resolveTagName: vi.fn() })

    expect(result.current.blockResolvers).not.toBe(firstResolvers)
    // Actions must stay stable.
    expect(result.current.blockActions).toBe(firstActions)
  })

  it('publishes every action callback by identity onto the bag', () => {
    const params = makeParams()
    const { result } = renderHook(() => useBlockTreeContextBags(params))
    const actions = result.current.blockActions

    expect(actions.onNavigate).toBe(params.onNavigate)
    expect(actions.onDelete).toBe(params.onDelete)
    expect(actions.onIndent).toBe(params.onIndent)
    expect(actions.onDedent).toBe(params.onDedent)
    expect(actions.onMoveUp).toBe(params.onMoveUp)
    expect(actions.onMoveDown).toBe(params.onMoveDown)
    expect(actions.onMerge).toBe(params.onMerge)
    expect(actions.onToggleTodo).toBe(params.onToggleTodo)
    expect(actions.onTogglePriority).toBe(params.onTogglePriority)
    expect(actions.onToggleCollapse).toBe(params.onToggleCollapse)
    expect(actions.onShowHistory).toBe(params.onShowHistory)
    expect(actions.onShowProperties).toBe(params.onShowProperties)
    expect(actions.onZoomIn).toBe(params.onZoomIn)
    expect(actions.onSelect).toBe(params.onSelect)
  })

  it('publishes every resolver by identity onto the bag', () => {
    const params = makeParams()
    const { result } = renderHook(() => useBlockTreeContextBags(params))
    const resolvers = result.current.blockResolvers

    expect(resolvers.resolveBlockTitle).toBe(params.resolveBlockTitle)
    expect(resolvers.resolveTagName).toBe(params.resolveTagName)
    expect(resolvers.resolveBlockStatus).toBe(params.resolveBlockStatus)
    expect(resolvers.resolveTagStatus).toBe(params.resolveTagStatus)
  })
})
