/**
 * useBlockFindVersion (#6557): find over block text runs again when a mounted
 * tree's blocks change, and not while the bar is closed.
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { createStore } from 'zustand'

import { makeBlock } from '@/__tests__/fixtures'
import { useBlockFindVersion } from '@/hooks/useBlockFindVersion'
import { __resetBlockCommandBus, registerBlockCommandTarget } from '@/stores/block-command-bus'
import type { PageBlockState } from '@/stores/page-blocks'

function mountTree() {
  const store = createStore<PageBlockState>(
    () => ({ blocks: [makeBlock({ id: 'A' })] }) as unknown as PageBlockState,
  )
  registerBlockCommandTarget(store, {})
  return store
}

function renderVersion(open: boolean) {
  return renderHook(() =>
    useBlockFindVersion({
      open,
      container: null,
      hasBlockMatches: () => false,
      repaint: () => {},
      onTitlesChanged: () => {},
    }),
  )
}

afterEach(() => {
  __resetBlockCommandBus()
})

describe('useBlockFindVersion', () => {
  it('bumps when a mounted tree changes its blocks', async () => {
    const store = mountTree()
    const { result } = renderVersion(true)
    const before = result.current
    act(() => store.setState({ blocks: [makeBlock({ id: 'B' })] }))
    await waitFor(() => expect(result.current).toBe(before + 1))
  })

  it('does nothing while the bar is closed', async () => {
    const store = mountTree()
    const { result } = renderVersion(false)
    act(() => store.setState({ blocks: [makeBlock({ id: 'B' })] }))
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)))
    expect(result.current).toBe(0)
  })
})
