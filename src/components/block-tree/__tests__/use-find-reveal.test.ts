/**
 * useFindReveal (#6557): the tree owning find's current match expands the
 * collapsed blocks whose folds hold it and raises the mount cap to its row.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { makeBlock } from '@/__tests__/fixtures'
import { useFindReveal } from '@/components/block-tree/use-find-reveal'
import type { FlatBlock } from '@/lib/tree-utils'
import { useInPageFindStore } from '@/stores/useInPageFindStore'

const parent = makeBlock({ id: 'PARENT', parent_id: null, depth: 0 })
const child = makeBlock({ id: 'CHILD', parent_id: 'PARENT', depth: 1 })
const other = makeBlock({ id: 'OTHER', parent_id: null, depth: 0 })
const tree = [parent, child, other]

function setup(
  collapsedIds: ReadonlySet<string>,
  visible: readonly FlatBlock[],
  blocks: readonly FlatBlock[] = tree,
) {
  const expandBlock = vi.fn()
  const revealIndex = vi.fn()
  renderHook(() => useFindReveal({ blocks, collapsedIds, visible, expandBlock, revealIndex }))
  return { expandBlock, revealIndex }
}

afterEach(() => {
  act(() => useInPageFindStore.getState().setRevealBlockId(null))
})

describe('useFindReveal', () => {
  it('expands a collapsed ancestor of the target', () => {
    act(() => useInPageFindStore.getState().setRevealBlockId('CHILD'))
    const { expandBlock, revealIndex } = setup(new Set(['PARENT']), [parent, other])
    expect(expandBlock).toHaveBeenCalledExactlyOnceWith('PARENT')
    expect(revealIndex).not.toHaveBeenCalled()
  })

  it('expands a collapsed heading whose section holds the target (#7040)', () => {
    const heading = makeBlock({ id: 'HEADING', parent_id: null, depth: 0, content: '## H' })
    const sibling = makeBlock({ id: 'SIBLING', parent_id: null, depth: 0, content: 'in it' })
    act(() => useInPageFindStore.getState().setRevealBlockId('SIBLING'))
    const { expandBlock } = setup(new Set(['HEADING']), [heading], [heading, sibling])
    expect(expandBlock).toHaveBeenCalledExactlyOnceWith('HEADING')
  })

  it('raises the mount cap to the target row', () => {
    act(() => useInPageFindStore.getState().setRevealBlockId('OTHER'))
    const { expandBlock, revealIndex } = setup(new Set(), [parent, child, other])
    expect(revealIndex).toHaveBeenCalledExactlyOnceWith(2)
    expect(expandBlock).not.toHaveBeenCalled()
  })

  it('leaves a block another tree owns alone', () => {
    act(() => useInPageFindStore.getState().setRevealBlockId('ELSEWHERE'))
    const { expandBlock, revealIndex } = setup(new Set(['PARENT']), [parent, other])
    expect(expandBlock).not.toHaveBeenCalled()
    expect(revealIndex).not.toHaveBeenCalled()
  })
})
