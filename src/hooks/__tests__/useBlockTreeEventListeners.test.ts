/**
 * Tests for useBlockTreeEventListeners hook.
 *
 * #1250 — the hook no longer installs document listeners; it registers this
 * tree's handlers with the focus-keyed block command bus. A producer's
 * `dispatchBlockEvent` routes through the bus to the single tree whose page
 * store owns the GLOBAL `focusedBlockId` (`useBlockStore`). These tests set
 * that global focus and assert each command reaches the correct callback, fires
 * exactly once (in the owning tree only), and is torn down on unmount.
 */

import { renderHook } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { makeBlock } from '../../__tests__/fixtures'
import type { RovingEditorHandle } from '../../editor/use-roving-editor'
import { __resetBlockCommandBus } from '../../lib/block-command-bus'
import { dispatchBlockEvent } from '../../lib/block-events'
import { useBlockStore } from '../../stores/blocks'
import { createPageBlockStore, PageBlockContext } from '../../stores/page-blocks'
import { useBlockProperties } from '../useBlockProperties'
import type { UseBlockTreeEventListenersOptions } from '../useBlockTreeEventListeners'
import { useBlockTreeEventListeners } from '../useBlockTreeEventListeners'

/**
 * #713 — minimal page-store stub that "owns" the given block ids: the bus
 * calls `getState().blocksById.has(id)` via `storeOwnsBlock`.
 */
function makePageStore(
  ownedBlocks: Array<{ id: string; content?: string }>,
): UseBlockTreeEventListenersOptions['pageStore'] {
  const blocks = ownedBlocks.map((b) => ({ content: '', ...b }))
  const blocksById = new Map(blocks.map((b) => [b.id, b]))
  return {
    setState: vi.fn(),
    getState: () => ({ blocksById, blocks }),
    getInitialState: vi.fn(),
    subscribe: vi.fn(),
  } as unknown as UseBlockTreeEventListenersOptions['pageStore']
}

function makeOptions(
  overrides: Partial<UseBlockTreeEventListenersOptions> = {},
): UseBlockTreeEventListenersOptions {
  return {
    focusedBlockId: 'BLOCK_1',
    rootParentId: 'PAGE_1',
    handleEscapeCancel: vi.fn(),
    handleToggleTodo: vi.fn(),
    handleTogglePriority: vi.fn(),
    handleShowProperties: vi.fn(),
    rovingEditor: {
      editor: null,
      mount: vi.fn(),
      unmount: vi.fn(),
    } as unknown as RovingEditorHandle,
    datePickerCursorPos: { current: undefined },
    setDatePickerMode: vi.fn(),
    setDatePickerOpen: vi.fn(),
    pageStore: makePageStore([{ id: 'BLOCK_1' }]),
    t: (key: string) => key,
    ...overrides,
  }
}

/** Set the GLOBAL focused block id the bus routes on. */
function setGlobalFocus(id: string | null): void {
  useBlockStore.setState({ focusedBlockId: id })
}

beforeEach(() => {
  vi.clearAllMocks()
  __resetBlockCommandBus()
  setGlobalFocus('BLOCK_1')
})

afterEach(() => {
  __resetBlockCommandBus()
  setGlobalFocus(null)
})

describe('useBlockTreeEventListeners', () => {
  describe('DISCARD_BLOCK_EDIT', () => {
    it('calls handleEscapeCancel when event is dispatched and block is focused', () => {
      const opts = makeOptions()
      renderHook(() => useBlockTreeEventListeners(opts))

      dispatchBlockEvent('DISCARD_BLOCK_EDIT')

      expect(opts.handleEscapeCancel).toHaveBeenCalledTimes(1)
    })

    it('does not call handleEscapeCancel when no block is focused', () => {
      setGlobalFocus(null)
      const opts = makeOptions({ focusedBlockId: null })
      renderHook(() => useBlockTreeEventListeners(opts))

      dispatchBlockEvent('DISCARD_BLOCK_EDIT')

      expect(opts.handleEscapeCancel).not.toHaveBeenCalled()
    })
  })

  describe('CYCLE_PRIORITY', () => {
    it('calls handleTogglePriority when event is dispatched', () => {
      const opts = makeOptions()
      renderHook(() => useBlockTreeEventListeners(opts))

      dispatchBlockEvent('CYCLE_PRIORITY')

      expect(opts.handleTogglePriority).toHaveBeenCalledWith('BLOCK_1')
    })

    it('does not call handleTogglePriority when no block is focused', () => {
      setGlobalFocus(null)
      const opts = makeOptions({ focusedBlockId: null })
      renderHook(() => useBlockTreeEventListeners(opts))

      dispatchBlockEvent('CYCLE_PRIORITY')

      expect(opts.handleTogglePriority).not.toHaveBeenCalled()
    })
  })

  describe('SET_PRIORITY_1/2/3', () => {
    it('calls setPriority for SET_PRIORITY_1 event', async () => {
      const { invoke } = await import('@tauri-apps/api/core')
      const mockedInvoke = vi.mocked(invoke)
      mockedInvoke.mockResolvedValue(undefined)

      const opts = makeOptions()
      renderHook(() => useBlockTreeEventListeners(opts))

      dispatchBlockEvent('SET_PRIORITY_1')

      // The handler is async — wait for it
      await vi.waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith('set_priority', {
          blockId: 'BLOCK_1',
          level: '1',
        })
      })
    })

    it('does not call setPriority when no block is focused', async () => {
      const { invoke } = await import('@tauri-apps/api/core')
      const mockedInvoke = vi.mocked(invoke)
      mockedInvoke.mockClear()

      setGlobalFocus(null)
      const opts = makeOptions({ focusedBlockId: null })
      renderHook(() => useBlockTreeEventListeners(opts))

      dispatchBlockEvent('SET_PRIORITY_1')

      // The bus is a no-op when nothing is focused, so the async handler never
      // runs. Flush one microtask for defensive determinism, then assert
      // absence of the side effect (TEST-FE-1).
      await Promise.resolve()

      const callsForSetPriority = mockedInvoke.mock.calls.filter(
        (c: unknown[]) => c[0] === 'set_priority',
      )
      expect(callsForSetPriority).toHaveLength(0)
    })
  })

  describe('OPEN_DATE_PICKER', () => {
    it('opens date picker with "date" mode when event is dispatched', () => {
      const opts = makeOptions()
      renderHook(() => useBlockTreeEventListeners(opts))

      dispatchBlockEvent('OPEN_DATE_PICKER')

      expect(opts.setDatePickerMode).toHaveBeenCalledWith('date')
      expect(opts.setDatePickerOpen).toHaveBeenCalledWith(true)
    })

    it('does not open when no block is focused', () => {
      setGlobalFocus(null)
      const opts = makeOptions({ focusedBlockId: null })
      renderHook(() => useBlockTreeEventListeners(opts))

      dispatchBlockEvent('OPEN_DATE_PICKER')

      expect(opts.setDatePickerOpen).not.toHaveBeenCalled()
    })

    it('does not install document listeners (no per-tree fan-out)', () => {
      const addSpy = vi.spyOn(document, 'addEventListener')

      const opts = makeOptions()
      const { unmount } = renderHook(() => useBlockTreeEventListeners(opts))

      // #1250 — the hook registers with the command bus, not `document`; no
      // block-event keydown/custom listeners are attached at the document level.
      const blockEventListenerAdds = addSpy.mock.calls.filter(([name]) =>
        typeof name === 'string' ? name.includes('-') || name === 'keydown' : false,
      )
      expect(blockEventListenerAdds).toHaveLength(0)

      unmount()
      addSpy.mockRestore()
    })
  })

  describe('OPEN_DUE_DATE_PICKER', () => {
    it('opens date picker with "due" mode', () => {
      const opts = makeOptions()
      renderHook(() => useBlockTreeEventListeners(opts))

      dispatchBlockEvent('OPEN_DUE_DATE_PICKER')

      expect(opts.setDatePickerMode).toHaveBeenCalledWith('due')
      expect(opts.setDatePickerOpen).toHaveBeenCalledWith(true)
    })
  })

  describe('OPEN_SCHEDULED_DATE_PICKER', () => {
    it('opens date picker with "schedule" mode', () => {
      const opts = makeOptions()
      renderHook(() => useBlockTreeEventListeners(opts))

      dispatchBlockEvent('OPEN_SCHEDULED_DATE_PICKER')

      expect(opts.setDatePickerMode).toHaveBeenCalledWith('schedule')
      expect(opts.setDatePickerOpen).toHaveBeenCalledWith(true)
    })
  })

  describe('TOGGLE_TODO_STATE', () => {
    it('calls handleToggleTodo when event is dispatched', () => {
      const opts = makeOptions()
      renderHook(() => useBlockTreeEventListeners(opts))

      dispatchBlockEvent('TOGGLE_TODO_STATE')

      expect(opts.handleToggleTodo).toHaveBeenCalledWith('BLOCK_1')
    })

    it('does not call handleToggleTodo when no block is focused', () => {
      setGlobalFocus(null)
      const opts = makeOptions({ focusedBlockId: null })
      renderHook(() => useBlockTreeEventListeners(opts))

      dispatchBlockEvent('TOGGLE_TODO_STATE')

      expect(opts.handleToggleTodo).not.toHaveBeenCalled()
    })
  })

  describe('OPEN_BLOCK_PROPERTIES', () => {
    it('calls handleShowProperties when event is dispatched', () => {
      const opts = makeOptions()
      renderHook(() => useBlockTreeEventListeners(opts))

      dispatchBlockEvent('OPEN_BLOCK_PROPERTIES')

      expect(opts.handleShowProperties).toHaveBeenCalledWith('BLOCK_1')
    })

    it('does not call handleShowProperties when no block is focused', () => {
      setGlobalFocus(null)
      const opts = makeOptions({ focusedBlockId: null })
      renderHook(() => useBlockTreeEventListeners(opts))

      dispatchBlockEvent('OPEN_BLOCK_PROPERTIES')

      expect(opts.handleShowProperties).not.toHaveBeenCalled()
    })
  })

  describe('Cleanup', () => {
    it('unregisters all command handlers on unmount', () => {
      const opts = makeOptions()
      const { unmount } = renderHook(() => useBlockTreeEventListeners(opts))

      unmount()

      // After unmount, commands should not trigger callbacks
      dispatchBlockEvent('DISCARD_BLOCK_EDIT')
      dispatchBlockEvent('CYCLE_PRIORITY')
      dispatchBlockEvent('TOGGLE_TODO_STATE')
      dispatchBlockEvent('OPEN_BLOCK_PROPERTIES')

      expect(opts.handleEscapeCancel).not.toHaveBeenCalled()
      expect(opts.handleTogglePriority).not.toHaveBeenCalled()
      expect(opts.handleToggleTodo).not.toHaveBeenCalled()
      expect(opts.handleShowProperties).not.toHaveBeenCalled()
    })
  })

  // #253 — these toolbar buttons previously dispatched events with no consumer.
  describe('structural toolbar inserts (#253)', () => {
    function structuralOpts(content: string) {
      const blocksById = new Map([['BLOCK_1', { id: 'BLOCK_1', content }]])
      const mount = vi.fn()
      const opts = makeOptions({
        rovingEditor: { editor: null, mount, unmount: vi.fn() } as unknown as RovingEditorHandle,
        pageStore: {
          setState: vi.fn(),
          getState: () => ({ blocksById, blocks: [{ id: 'BLOCK_1', content }] }),
          getInitialState: vi.fn(),
          subscribe: vi.fn(),
        } as unknown as UseBlockTreeEventListenersOptions['pageStore'],
      })
      return { opts, mount }
    }

    it.each([
      ['INSERT_DIVIDER', '---'],
      ['INSERT_ORDERED_LIST', '1. hello'],
      ['INSERT_CALLOUT', '> [!INFO] hello'],
    ] as const)('%s edits the focused block to "%s"', async (event, toText) => {
      const { invoke } = await import('@tauri-apps/api/core')
      const mockedInvoke = vi.mocked(invoke)
      mockedInvoke.mockResolvedValue(undefined)
      const { opts, mount } = structuralOpts('hello')
      renderHook(() => useBlockTreeEventListeners(opts))

      dispatchBlockEvent(event)

      await vi.waitFor(() =>
        expect(mockedInvoke).toHaveBeenCalledWith('edit_block', { blockId: 'BLOCK_1', toText }),
      )
      // The block is re-mounted with the new content (matches the slash path).
      await vi.waitFor(() => expect(mount).toHaveBeenCalledWith('BLOCK_1', toText))
    })

    it.each([
      ['warning', '> [!WARNING] hello'],
      ['tip', '> [!TIP] hello'],
      ['bogus', '> [!INFO] hello'], // unknown type falls back to info (#215)
    ] as const)('INSERT_CALLOUT { type: %s } → "%s"', async (type, toText) => {
      const { invoke } = await import('@tauri-apps/api/core')
      const mockedInvoke = vi.mocked(invoke)
      mockedInvoke.mockResolvedValue(undefined)
      const { opts } = structuralOpts('hello')
      renderHook(() => useBlockTreeEventListeners(opts))

      dispatchBlockEvent('INSERT_CALLOUT', { type })

      await vi.waitFor(() =>
        expect(mockedInvoke).toHaveBeenCalledWith('edit_block', { blockId: 'BLOCK_1', toText }),
      )
    })

    it('no-ops when no block is focused', async () => {
      const { invoke } = await import('@tauri-apps/api/core')
      const mockedInvoke = vi.mocked(invoke)
      mockedInvoke.mockClear()
      setGlobalFocus(null)
      const { opts } = structuralOpts('hello')
      renderHook(() => useBlockTreeEventListeners({ ...opts, focusedBlockId: null }))

      dispatchBlockEvent('INSERT_DIVIDER')

      expect(mockedInvoke).not.toHaveBeenCalledWith('edit_block', expect.anything())
    })

    it('removes the structural handlers on unmount', async () => {
      const { invoke } = await import('@tauri-apps/api/core')
      const mockedInvoke = vi.mocked(invoke)
      const { opts } = structuralOpts('hello')
      const { unmount } = renderHook(() => useBlockTreeEventListeners(opts))
      unmount()
      mockedInvoke.mockClear()

      dispatchBlockEvent('INSERT_DIVIDER')

      expect(mockedInvoke).not.toHaveBeenCalledWith('edit_block', expect.anything())
    })
  })

  // #713 — journal week/month mount one BlockTree (one registration here) per
  // day, all sharing the global focusedBlockId. Only the tree whose page store
  // owns the focused block may act; a non-owning tree must perform ZERO side
  // effects. The focus-keyed bus enforces this by construction (#1250).
  describe('#713 — multi-tree ownership gating', () => {
    /** Two trees with distinct page stores; the global focus is in tree A. */
    function renderTwoTrees() {
      setGlobalFocus('BLOCK_A')
      const treeA = makeOptions({
        focusedBlockId: 'BLOCK_A',
        pageStore: makePageStore([{ id: 'BLOCK_A', content: 'hello' }]),
      })
      const treeB = makeOptions({
        focusedBlockId: 'BLOCK_A', // global focus — foreign to tree B's store
        pageStore: makePageStore([{ id: 'BLOCK_B', content: 'other' }]),
      })
      renderHook(() => useBlockTreeEventListeners(treeA))
      renderHook(() => useBlockTreeEventListeners(treeB))
      return { treeA, treeB }
    }

    it('TOGGLE_TODO_STATE fires exactly once, in the owning tree only', () => {
      const { treeA, treeB } = renderTwoTrees()

      dispatchBlockEvent('TOGGLE_TODO_STATE')

      expect(treeA.handleToggleTodo).toHaveBeenCalledTimes(1)
      expect(treeA.handleToggleTodo).toHaveBeenCalledWith('BLOCK_A')
      expect(treeB.handleToggleTodo).not.toHaveBeenCalled()
    })

    it('CYCLE_PRIORITY fires exactly once, in the owning tree only', () => {
      const { treeA, treeB } = renderTwoTrees()

      dispatchBlockEvent('CYCLE_PRIORITY')

      expect(treeA.handleTogglePriority).toHaveBeenCalledTimes(1)
      expect(treeA.handleTogglePriority).toHaveBeenCalledWith('BLOCK_A')
      expect(treeB.handleTogglePriority).not.toHaveBeenCalled()
    })

    it('SET_PRIORITY_1 issues exactly ONE set_priority IPC and only updates the owning store', async () => {
      const { invoke } = await import('@tauri-apps/api/core')
      const mockedInvoke = vi.mocked(invoke)
      mockedInvoke.mockClear()
      mockedInvoke.mockResolvedValue(undefined)

      const { treeA, treeB } = renderTwoTrees()

      dispatchBlockEvent('SET_PRIORITY_1')

      await vi.waitFor(() => {
        const calls = mockedInvoke.mock.calls.filter((c: unknown[]) => c[0] === 'set_priority')
        expect(calls).toHaveLength(1)
        expect(calls[0]?.[1]).toEqual({ blockId: 'BLOCK_A', level: '1' })
      })
      // The optimistic store write lands after the awaited IPC resolves.
      await vi.waitFor(() => expect(treeA.pageStore.setState).toHaveBeenCalled())
      expect(treeB.pageStore.setState).not.toHaveBeenCalled()
    })

    it('OPEN_DATE_PICKER opens exactly one picker, in the owning tree only', () => {
      const { treeA, treeB } = renderTwoTrees()

      dispatchBlockEvent('OPEN_DATE_PICKER')

      expect(treeA.setDatePickerOpen).toHaveBeenCalledTimes(1)
      expect(treeA.setDatePickerOpen).toHaveBeenCalledWith(true)
      expect(treeB.setDatePickerOpen).not.toHaveBeenCalled()
    })

    it('INSERT_DIVIDER edits the block exactly once, via the owning tree only', async () => {
      const { invoke } = await import('@tauri-apps/api/core')
      const mockedInvoke = vi.mocked(invoke)
      mockedInvoke.mockClear()
      mockedInvoke.mockResolvedValue(undefined)

      renderTwoTrees()

      dispatchBlockEvent('INSERT_DIVIDER')

      await vi.waitFor(() => {
        const calls = mockedInvoke.mock.calls.filter((c: unknown[]) => c[0] === 'edit_block')
        expect(calls).toHaveLength(1)
        expect(calls[0]?.[1]).toEqual({ blockId: 'BLOCK_A', toText: '---' })
      })
    })

    it('a non-owning tree alone performs zero side effects', async () => {
      const { invoke } = await import('@tauri-apps/api/core')
      const mockedInvoke = vi.mocked(invoke)
      mockedInvoke.mockClear()

      // The global focus points at a block that does NOT live in this store.
      setGlobalFocus('BLOCK_A')
      const opts = makeOptions({
        focusedBlockId: 'BLOCK_A',
        pageStore: makePageStore([{ id: 'BLOCK_B' }]),
      })
      renderHook(() => useBlockTreeEventListeners(opts))

      dispatchBlockEvent('DISCARD_BLOCK_EDIT')
      dispatchBlockEvent('CYCLE_PRIORITY')
      dispatchBlockEvent('SET_PRIORITY_1')
      dispatchBlockEvent('OPEN_DATE_PICKER')
      dispatchBlockEvent('OPEN_DUE_DATE_PICKER')
      dispatchBlockEvent('OPEN_SCHEDULED_DATE_PICKER')
      dispatchBlockEvent('TOGGLE_TODO_STATE')
      dispatchBlockEvent('OPEN_BLOCK_PROPERTIES')
      dispatchBlockEvent('INSERT_DIVIDER')

      // Flush any async microtasks.
      await Promise.resolve()

      expect(opts.handleEscapeCancel).not.toHaveBeenCalled()
      expect(opts.handleTogglePriority).not.toHaveBeenCalled()
      expect(opts.handleToggleTodo).not.toHaveBeenCalled()
      expect(opts.handleShowProperties).not.toHaveBeenCalled()
      expect(opts.setDatePickerOpen).not.toHaveBeenCalled()
      expect(opts.pageStore.setState).not.toHaveBeenCalled()
      expect(mockedInvoke).not.toHaveBeenCalledWith('set_priority', expect.anything())
      expect(mockedInvoke).not.toHaveBeenCalledWith('edit_block', expect.anything())
    })

    it('todo toggle computes the next state from the OWNING store, not a foreign tree', async () => {
      const { invoke } = await import('@tauri-apps/api/core')
      const mockedInvoke = vi.mocked(invoke)
      mockedInvoke.mockClear()
      mockedInvoke.mockResolvedValue(undefined)

      // Real per-page stores + the real `useBlockProperties` cycle logic.
      // Tree A owns BLOCK_A in state DOING → next is DONE. Tree B's store
      // doesn't contain BLOCK_A; pre-#713 its handler computed
      // `current = null` → 'TODO' and raced a conflicting IPC.
      setGlobalFocus('BLOCK_A')
      const storeA = createPageBlockStore('PAGE_A')
      storeA.setState({ blocks: [makeBlock({ id: 'BLOCK_A', todo_state: 'DOING' })] })
      const storeB = createPageBlockStore('PAGE_B')
      storeB.setState({ blocks: [makeBlock({ id: 'BLOCK_B' })] })

      const renderTree = (store: typeof storeA) =>
        renderHook(
          () => {
            const { handleToggleTodo, handleTogglePriority } = useBlockProperties()
            useBlockTreeEventListeners(
              makeOptions({
                focusedBlockId: 'BLOCK_A',
                pageStore: store,
                handleToggleTodo,
                handleTogglePriority,
              }),
            )
          },
          {
            wrapper: ({ children }) =>
              createElement(PageBlockContext.Provider, { value: store }, children),
          },
        )

      renderTree(storeA)
      renderTree(storeB)

      dispatchBlockEvent('TOGGLE_TODO_STATE')

      await vi.waitFor(() => {
        const calls = mockedInvoke.mock.calls.filter((c: unknown[]) => c[0] === 'set_todo_state')
        expect(calls).toHaveLength(1)
        // DOING → DONE per the owning store; a foreign tree would send 'TODO'.
        expect(calls[0]?.[1]).toEqual({ blockId: 'BLOCK_A', state: 'DONE' })
      })
      expect(storeA.getState().blocksById.get('BLOCK_A')?.todo_state).toBe('DONE')
      expect(storeB.getState().blocksById.has('BLOCK_A')).toBe(false)
    })
  })
})
