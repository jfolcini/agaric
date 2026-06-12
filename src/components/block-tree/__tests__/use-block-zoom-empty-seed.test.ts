/**
 * Tests for useBlockZoomEmptySeed (#922).
 *
 * Validates:
 * - Happy path: zooming into a LEAF block creates a child UNDER the zoom root
 *   via a NON-wholesale splice (the rest of the page is preserved) and focuses
 *   the new child.
 * - No-op when the zoom root already has children.
 * - No-op when not zoomed.
 * - Idempotent per zoom root (fires once per zoom-into).
 * - Re-zoom guard: a child that appeared while the create IPC was in flight is
 *   not duplicated.
 * - Error path: failure toast.
 */

import { invoke } from '@tauri-apps/api/core'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { TFunction } from 'i18next'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'

import { makeBlock } from '../../../__tests__/fixtures'
import { useBlockStore } from '../../../stores/blocks'
import { createPageBlockStore, type PageBlockState } from '../../../stores/page-blocks'
import { useBlockZoomEmptySeed } from '../use-block-zoom-empty-seed'

const mockedInvoke = vi.mocked(invoke)

let pageStore: StoreApi<PageBlockState>

function makeParams(
  overrides?: Partial<Parameters<typeof useBlockZoomEmptySeed>[0]>,
): Parameters<typeof useBlockZoomEmptySeed>[0] {
  return {
    enabled: true,
    loading: false,
    zoomedBlockId: 'LEAF',
    pageStore,
    t: vi.fn((key: string) => key) as unknown as TFunction,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  pageStore = createPageBlockStore('PAGE_1')
  pageStore.setState({ loading: false })
  useBlockStore.setState({ focusedBlockId: null, selectedBlockIds: [] })
})

describe('useBlockZoomEmptySeed', () => {
  it('seeds a child UNDER the zoomed leaf without clobbering the rest of the page', async () => {
    // OTHER is a sibling of LEAF; the seed must NOT remove it.
    const other = makeBlock({ id: 'OTHER', position: 0, parent_id: null, depth: 0 })
    const leaf = makeBlock({ id: 'LEAF', position: 1, parent_id: null, depth: 0 })
    pageStore.setState({ blocks: [other, leaf] })

    const newChild = makeBlock({ id: 'CHILD', content: '', parent_id: 'LEAF' })
    mockedInvoke.mockResolvedValue(newChild)

    renderHook(() => useBlockZoomEmptySeed(makeParams()))

    await waitFor(() => {
      expect(pageStore.getState().blocks).toHaveLength(3)
    })
    // The child is created under the zoom root.
    expect(mockedInvoke).toHaveBeenCalledWith('create_block', {
      blockType: 'content',
      content: '',
      parentId: 'LEAF',
      index: null,
      scope: { kind: 'global' },
    })
    // NON-wholesale: OTHER survives, and the child is spliced right after LEAF
    // at depth+1.
    expect(pageStore.getState().blocks.map((b) => b.id)).toEqual(['OTHER', 'LEAF', 'CHILD'])
    expect(pageStore.getState().blocks[2]).toEqual({ ...newChild, depth: 1 })
    // The wrapped setState derives blocksById for `{ blocks }` partials.
    expect(pageStore.getState().blocksById.get('CHILD')).toEqual({ ...newChild, depth: 1 })
    expect(useBlockStore.getState().focusedBlockId).toBe('CHILD')
  })

  it('is a no-op when the zoom root already has children', async () => {
    const leaf = makeBlock({ id: 'LEAF', position: 0, parent_id: null, depth: 0 })
    const existing = makeBlock({ id: 'EXISTING', position: 0, parent_id: 'LEAF', depth: 1 })
    pageStore.setState({ blocks: [leaf, existing] })

    renderHook(() => useBlockZoomEmptySeed(makeParams()))

    await Promise.resolve()
    expect(mockedInvoke).not.toHaveBeenCalledWith('create_block', expect.anything())
    expect(pageStore.getState().blocks).toHaveLength(2)
  })

  it('is a no-op when not zoomed (zoomedBlockId null)', async () => {
    pageStore.setState({ blocks: [makeBlock({ id: 'LEAF', parent_id: null, depth: 0 })] })

    renderHook(() => useBlockZoomEmptySeed(makeParams({ zoomedBlockId: null })))

    await Promise.resolve()
    expect(mockedInvoke).not.toHaveBeenCalledWith('create_block', expect.anything())
  })

  it('fires only once per zoom root (idempotent across re-renders)', async () => {
    const leaf = makeBlock({ id: 'LEAF', position: 0, parent_id: null, depth: 0 })
    pageStore.setState({ blocks: [leaf] })
    const newChild = makeBlock({ id: 'CHILD', content: '', parent_id: 'LEAF' })
    mockedInvoke.mockResolvedValue(newChild)

    const { rerender } = renderHook((props) => useBlockZoomEmptySeed(props), {
      initialProps: makeParams(),
    })
    await waitFor(() => {
      expect(pageStore.getState().blocks).toHaveLength(2)
    })

    // A re-render with the same zoom root must not seed a second child.
    rerender(makeParams())
    await Promise.resolve()
    const createCalls = mockedInvoke.mock.calls.filter((c) => c[0] === 'create_block')
    expect(createCalls).toHaveLength(1)
  })

  it('does not duplicate when a child appeared while the create IPC was in flight', async () => {
    const leaf = makeBlock({ id: 'LEAF', position: 0, parent_id: null, depth: 0 })
    pageStore.setState({ blocks: [leaf] })

    const newChild = makeBlock({ id: 'CHILD', content: '', parent_id: 'LEAF' })
    let resolveCreate!: (value: unknown) => void
    mockedInvoke.mockImplementation(
      (cmd: string) =>
        new Promise((resolve) => {
          if (cmd === 'create_block') resolveCreate = resolve
          else resolve(undefined)
        }),
    )

    renderHook(() => useBlockZoomEmptySeed(makeParams()))
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('create_block', expect.anything())
    })

    // A child lands under LEAF before the IPC settles (e.g. a sync reload).
    const raced = makeBlock({ id: 'RACED', content: 'fast', parent_id: 'LEAF', depth: 1 })
    pageStore.setState({ blocks: [leaf, raced] })

    await act(async () => {
      resolveCreate(newChild)
      await Promise.resolve()
    })

    // The seed must NOT add a second empty child.
    expect(pageStore.getState().blocks.map((b) => b.id)).toEqual(['LEAF', 'RACED'])
    expect(useBlockStore.getState().focusedBlockId).toBeNull()
  })

  it('shows a failure toast when create_block rejects', async () => {
    pageStore.setState({ blocks: [makeBlock({ id: 'LEAF', parent_id: null, depth: 0 })] })
    mockedInvoke.mockRejectedValue(new Error('DB error'))

    renderHook(() => useBlockZoomEmptySeed(makeParams()))

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith('blockTree.createFirstBlockFailed')
    })
    expect(pageStore.getState().blocks).toHaveLength(1)
  })
})
