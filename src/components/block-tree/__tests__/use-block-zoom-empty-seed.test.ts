/**
 * Tests for useBlockZoomEmptySeed (#922).
 *
 * Validates:
 * - Happy path: zooming into a LEAF block creates a child UNDER the zoom root
 *   via a NON-wholesale splice (the rest of the page is preserved) and focuses
 *   the new child.
 * - No-op when the zoom root already has children.
 * - No-op when not zoomed.
 * - Re-arms after child deletion or same-cardinality reparenting.
 * - Does not duplicate an in-flight seed or clobber a newer root's guard.
 * - Re-zoom guard: a child that appeared while the create IPC was in flight is
 *   not duplicated.
 * - Error path: failure toast.
 */

import { invoke } from '@tauri-apps/api/core'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { TFunction } from 'i18next'
import { createElement, useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'

import { makeBlock } from '@/__tests__/fixtures'
import { useBlockZoomEmptySeed } from '@/components/block-tree/use-block-zoom-empty-seed'
import { useBlockStore } from '@/stores/blocks'
import { createPageBlockStore, type PageBlockState } from '@/stores/page-blocks'

const mockedInvoke = vi.mocked(invoke)

let pageStore: StoreApi<PageBlockState>

function makeParams(
  overrides?: Partial<Parameters<typeof useBlockZoomEmptySeed>[0]>,
): Parameters<typeof useBlockZoomEmptySeed>[0] {
  return {
    enabled: true,
    loading: false,
    zoomedBlockId: 'LEAF',
    zoomRootHasChildren: false,
    pageStore,
    t: vi.fn((key: string) => key) as unknown as TFunction,
    ...overrides,
  }
}

function useSeedWithLayoutBoundary({
  params,
  resolveOnLayout,
  resolveOnLayoutCleanup,
}: {
  params: Parameters<typeof useBlockZoomEmptySeed>[0]
  resolveOnLayout?: (() => void) | undefined
  resolveOnLayoutCleanup?: (() => void) | undefined
}): void {
  useBlockZoomEmptySeed(params)
  // Registered after the hook's own committed-context lifecycle. This lets a
  // regression test settle the old IPC in the commit -> passive-effect window:
  // a layout context update/cleanup has already run, while a passive one has not.
  useLayoutEffect(() => {
    resolveOnLayout?.()
    return () => resolveOnLayoutCleanup?.()
  }, [resolveOnLayout, resolveOnLayoutCleanup])
}

function SeedLayoutBoundary(props: Parameters<typeof useSeedWithLayoutBoundary>[0]): null {
  useSeedWithLayoutBoundary(props)
  return null
}

function LayoutSignal({ onLayout }: { onLayout: () => void }): null {
  useLayoutEffect(() => onLayout(), [onLayout])
  return null
}

async function flushSeedPromiseChain(): Promise<void> {
  // createBlock's typed-error wrapper, unwrap, reconciliation, and finally each
  // add a promise continuation. Drain microtasks only: yielding a macrotask
  // here would also run passive effects and erase the timing boundary.
  for (let i = 0; i < 6; i++) await Promise.resolve()
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
      // #2849 PR2 — zoom-empty seed supplies no client id (null).
      blockId: null,
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

  it('does not re-seed while the zoom root still has the created child', async () => {
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

    // BlockTree projects the updated tree into this primitive on the next
    // render, so the same zoom root must not seed a second child.
    rerender(makeParams({ zoomRootHasChildren: true }))
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

  it('resets the idempotency ref on failure so a re-render retries (#1566 recovery)', async () => {
    const leaf = makeBlock({ id: 'LEAF', position: 0, parent_id: null, depth: 0 })
    pageStore.setState({ blocks: [leaf] })

    // First create rejects; the second (on the next render) succeeds.
    const newChild = makeBlock({ id: 'CHILD', content: '', parent_id: 'LEAF' })
    mockedInvoke.mockRejectedValueOnce(new Error('DB error')).mockResolvedValueOnce(newChild)

    const { rerender } = renderHook((props) => useBlockZoomEmptySeed(props), {
      initialProps: makeParams(),
    })

    // The first attempt fails and surfaces the toast — the zoom pane is blank.
    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith('blockTree.createFirstBlockFailed')
    })
    expect(pageStore.getState().blocks).toHaveLength(1)

    // A subsequent render re-fires the effect (the ref was reset on failure),
    // and the retry succeeds — the user is no longer stranded on a blank pane.
    rerender(makeParams())

    await waitFor(() => {
      expect(pageStore.getState().blocks).toHaveLength(2)
    })
    const createCalls = mockedInvoke.mock.calls.filter((c) => c[0] === 'create_block')
    expect(createCalls).toHaveLength(2)
    expect(pageStore.getState().blocks.map((b) => b.id)).toEqual(['LEAF', 'CHILD'])
    expect(useBlockStore.getState().focusedBlockId).toBe('CHILD')
  })

  it('re-seeds after the created child is deleted', async () => {
    const leaf = makeBlock({ id: 'LEAF', position: 0, parent_id: null, depth: 0 })
    pageStore.setState({ blocks: [leaf] })
    const firstChild = makeBlock({ id: 'CHILD_1', content: '', parent_id: 'LEAF' })
    const secondChild = makeBlock({ id: 'CHILD_2', content: '', parent_id: 'LEAF' })
    mockedInvoke.mockResolvedValueOnce(firstChild).mockResolvedValueOnce(secondChild)

    const stableT = vi.fn((key: string) => key) as unknown as TFunction

    const { rerender } = renderHook((props) => useBlockZoomEmptySeed(props), {
      initialProps: makeParams({ t: stableT }),
    })
    await waitFor(() => {
      expect(pageStore.getState().blocks).toHaveLength(2)
    })

    // Observe the first child, then delete it. The true -> false primitive
    // transition re-arms this root even though it was seeded successfully once.
    rerender(makeParams({ t: stableT, zoomRootHasChildren: true }))
    pageStore.setState({ blocks: [leaf] })
    rerender(makeParams({ t: stableT, zoomRootHasChildren: false }))

    await waitFor(() => {
      expect(pageStore.getState().blocks.map((b) => b.id)).toEqual(['LEAF', 'CHILD_2'])
    })
    expect(mockedInvoke.mock.calls.filter((c) => c[0] === 'create_block')).toHaveLength(2)
  })

  it('re-seeds after a same-cardinality reparent makes the zoom root a leaf', async () => {
    const root = makeBlock({ id: 'LEAF', position: 0, parent_id: null, depth: 0 })
    const other = makeBlock({ id: 'OTHER', position: 1, parent_id: null, depth: 0 })
    const child = makeBlock({ id: 'CHILD', position: 0, parent_id: 'LEAF', depth: 1 })
    pageStore.setState({ blocks: [root, child, other] })

    const stableT = vi.fn((key: string) => key) as unknown as TFunction
    const seeded = makeBlock({ id: 'SEEDED', content: '', parent_id: 'LEAF' })
    mockedInvoke.mockResolvedValue(seeded)

    const { rerender } = renderHook((props) => useBlockZoomEmptySeed(props), {
      initialProps: makeParams({ t: stableT, zoomRootHasChildren: true }),
    })
    expect(mockedInvoke).not.toHaveBeenCalledWith('create_block', expect.anything())

    // The array length stays three; only the parent/depth projection changes.
    const reparented = { ...child, parent_id: 'OTHER', depth: 1 }
    pageStore.setState({ blocks: [root, other, reparented] })
    rerender(makeParams({ t: stableT, zoomRootHasChildren: false }))

    await waitFor(() => {
      expect(pageStore.getState().blocks.map((b) => b.id)).toEqual([
        'LEAF',
        'SEEDED',
        'OTHER',
        'CHILD',
      ])
    })
    expect(mockedInvoke.mock.calls.filter((c) => c[0] === 'create_block')).toHaveLength(1)
  })

  it('does not start a duplicate create while the same root is still in flight', async () => {
    const leaf = makeBlock({ id: 'LEAF', position: 0, parent_id: null, depth: 0 })
    pageStore.setState({ blocks: [leaf] })
    const stableT = vi.fn((key: string) => key) as unknown as TFunction

    let resolveCreate: ((value: unknown) => void) | undefined
    mockedInvoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve
        }),
    )

    const { rerender } = renderHook((props) => useBlockZoomEmptySeed(props), {
      initialProps: makeParams({ t: stableT }),
    })
    await waitFor(() => {
      expect(mockedInvoke.mock.calls.filter((c) => c[0] === 'create_block')).toHaveLength(1)
    })

    // Force the effect through a dependency cycle while the first request is pending.
    rerender(makeParams({ t: stableT, zoomRootHasChildren: true }))
    rerender(makeParams({ t: stableT, zoomRootHasChildren: false }))
    expect(mockedInvoke.mock.calls.filter((c) => c[0] === 'create_block')).toHaveLength(1)

    await act(async () => {
      resolveCreate?.(makeBlock({ id: 'CHILD', parent_id: 'LEAF' }))
      await Promise.resolve()
    })
  })

  it('reconciles an older root without stealing focus from the current zoom', async () => {
    const rootA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
    const rootB = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })
    pageStore.setState({ blocks: [rootA, rootB] })
    const stableT = vi.fn((key: string) => key) as unknown as TFunction
    const resolvers = new Map<string, (value: unknown) => void>()
    mockedInvoke.mockImplementation((_cmd, args) => {
      const parentId = (args as { parentId: string }).parentId
      return new Promise((resolve) => {
        resolvers.set(parentId, resolve)
      })
    })

    const { rerender } = renderHook((props) => useBlockZoomEmptySeed(props), {
      initialProps: makeParams({ t: stableT, zoomedBlockId: 'A' }),
    })
    await waitFor(() => expect(resolvers.has('A')).toBe(true))

    rerender(makeParams({ t: stableT, zoomedBlockId: 'B' }))
    await waitFor(() => expect(resolvers.has('B')).toBe(true))

    await act(async () => {
      resolvers.get('A')?.(makeBlock({ id: 'A_CHILD', parent_id: 'A' }))
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(pageStore.getState().blocks.map((block) => block.id)).toContain('A_CHILD')
    })
    expect(useBlockStore.getState().focusedBlockId).toBeNull()

    // Re-run B's effect while its own request remains outstanding. A's finally
    // must not have cleared B's guard.
    rerender(makeParams({ t: stableT, zoomedBlockId: 'B', zoomRootHasChildren: true }))
    rerender(makeParams({ t: stableT, zoomedBlockId: 'B', zoomRootHasChildren: false }))
    expect(mockedInvoke.mock.calls.filter((c) => c[0] === 'create_block')).toHaveLength(2)

    await act(async () => {
      resolvers.get('B')?.(makeBlock({ id: 'B_CHILD', parent_id: 'B' }))
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(pageStore.getState().blocks.map((block) => block.id)).toContain('B_CHILD')
      expect(useBlockStore.getState().focusedBlockId).toBe('B_CHILD')
    })
  })

  it('commits a page-store change before an old create settles from a later layout effect', async () => {
    const oldStore = createPageBlockStore('PAGE_OLD')
    const newStore = createPageBlockStore('PAGE_NEW')
    const oldRoot = makeBlock({ id: 'OLD_ROOT', parent_id: null, depth: 0 })
    const newRoot = makeBlock({ id: 'NEW_ROOT', parent_id: null, depth: 0 })
    oldStore.setState({ blocks: [oldRoot], loading: false })
    newStore.setState({ blocks: [newRoot], loading: false })
    const stableT = vi.fn((key: string) => key) as unknown as TFunction

    let resolveOld: ((value: unknown) => void) | undefined
    mockedInvoke.mockImplementation((_cmd, args) => {
      const parentId = (args as { parentId: string }).parentId
      return new Promise((resolve) => {
        if (parentId === 'OLD_ROOT') resolveOld = resolve
      })
    })
    const settleOld = (): void => {
      resolveOld?.(makeBlock({ id: 'OLD_CHILD', parent_id: 'OLD_ROOT' }))
    }

    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        createElement(SeedLayoutBoundary, {
          params: makeParams({
            t: stableT,
            pageStore: oldStore,
            zoomedBlockId: 'OLD_ROOT',
          }),
        }),
      )
    })
    await waitFor(() => expect(resolveOld).toBeDefined())

    // The harness layout effect settles OLD after the hook's context lifecycle
    // has committed NEW, but before passive effects would update a passive ref.
    let markLayoutReached: (() => void) | undefined
    const layoutReached = new Promise<void>((resolve) => {
      markLayoutReached = resolve
    })
    const previousActEnvironment = (globalThis as any).IS_REACT_ACT_ENVIRONMENT
    try {
      ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = false
      root.render(
        createElement(SeedLayoutBoundary, {
          params: makeParams({
            t: stableT,
            pageStore: newStore,
            zoomedBlockId: 'NEW_ROOT',
          }),
          resolveOnLayout: () => {
            settleOld()
            markLayoutReached?.()
          },
        }),
      )
      await layoutReached
      await flushSeedPromiseChain()

      expect(oldStore.getState().blocks.map((block) => block.id)).toContain('OLD_CHILD')
      expect(newStore.getState().blocks.map((block) => block.id)).toEqual(['NEW_ROOT'])
      expect(useBlockStore.getState().focusedBlockId).toBeNull()
    } finally {
      ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('clears committed context before an unmount layout cleanup settles the old create', async () => {
    const originStore = createPageBlockStore('PAGE_ORIGIN')
    const rootBlock = makeBlock({ id: 'ORIGIN_ROOT', parent_id: null, depth: 0 })
    originStore.setState({ blocks: [rootBlock], loading: false })
    const stableT = vi.fn((key: string) => key) as unknown as TFunction

    let resolveOrigin: ((value: unknown) => void) | undefined
    mockedInvoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveOrigin = resolve
        }),
    )
    const settleOrigin = (): void => {
      resolveOrigin?.(makeBlock({ id: 'ORIGIN_CHILD', parent_id: 'ORIGIN_ROOT' }))
    }

    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        createElement(SeedLayoutBoundary, {
          params: makeParams({
            t: stableT,
            pageStore: originStore,
            zoomedBlockId: 'ORIGIN_ROOT',
          }),
        }),
      )
    })
    await waitFor(() => expect(resolveOrigin).toBeDefined())

    // Replace the seed with a layout-only signal. The seed's layout cleanup
    // must invalidate focus ownership before the signal settles the old IPC;
    // a passive cleanup would still be pending in this microtask-only window.
    let markLayoutReached: (() => void) | undefined
    const layoutReached = new Promise<void>((resolve) => {
      markLayoutReached = resolve
    })
    const previousActEnvironment = (globalThis as any).IS_REACT_ACT_ENVIRONMENT
    try {
      ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = false
      root.render(
        createElement(LayoutSignal, {
          onLayout: () => {
            settleOrigin()
            markLayoutReached?.()
          },
        }),
      )
      await layoutReached
      await flushSeedPromiseChain()

      expect(originStore.getState().blocks.map((block) => block.id)).toContain('ORIGIN_CHILD')
      expect(useBlockStore.getState().focusedBlockId).toBeNull()
    } finally {
      ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('does not duplicate A across an A to B to A switch while both creates are pending', async () => {
    const rootA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
    const rootB = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })
    pageStore.setState({ blocks: [rootA, rootB] })
    const stableT = vi.fn((key: string) => key) as unknown as TFunction
    const resolvers = new Map<string, (value: unknown) => void>()
    mockedInvoke.mockImplementation((_cmd, args) => {
      const parentId = (args as { parentId: string }).parentId
      return new Promise((resolve) => {
        resolvers.set(parentId, resolve)
      })
    })

    const { rerender } = renderHook((props) => useBlockZoomEmptySeed(props), {
      initialProps: makeParams({ t: stableT, zoomedBlockId: 'A' }),
    })
    await waitFor(() => expect(resolvers.has('A')).toBe(true))

    rerender(makeParams({ t: stableT, zoomedBlockId: 'B' }))
    await waitFor(() => expect(resolvers.has('B')).toBe(true))
    rerender(makeParams({ t: stableT, zoomedBlockId: 'A' }))

    const createCalls = mockedInvoke.mock.calls.filter((call) => call[0] === 'create_block')
    expect(createCalls).toHaveLength(2)
    expect(
      createCalls.filter((call) => (call[1] as { parentId: string }).parentId === 'A'),
    ).toHaveLength(1)

    await act(async () => {
      resolvers.get('B')?.(makeBlock({ id: 'B_CHILD', parent_id: 'B' }))
      resolvers.get('A')?.(makeBlock({ id: 'A_CHILD', parent_id: 'A' }))
      await Promise.resolve()
    })
  })
})
