/**
 * Tests for useBlockTreeKeyboardShortcuts hook.
 *
 * Validates that each document-level keyboard shortcut dispatches
 * to the correct callback and that listeners are cleaned up.
 */

import { fireEvent, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { __resetLastInteractedTreeForTests } from '../../lib/last-interacted-tree'
import { useBlockStore } from '../../stores/blocks'
import type { UseBlockTreeKeyboardShortcutsOptions } from '../useBlockTreeKeyboardShortcuts'
import { useBlockTreeKeyboardShortcuts } from '../useBlockTreeKeyboardShortcuts'

// #913 — block cut/copy/paste reads/writes the system clipboard via the
// app's wrapper. Mock it so the tests assert the serialized markdown without
// touching a real clipboard.
const mockWriteText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
const mockReadText = vi.fn<() => Promise<string>>().mockResolvedValue('')
vi.mock('../../lib/clipboard', () => ({
  writeText: (text: string) => mockWriteText(text),
  readText: () => mockReadText(),
}))

/** A FlatBlock-shaped row for the page-store stub. */
interface StubRow {
  id: string
  depth: number
  parent_id: string | null
  content: string
}

/**
 * #713 — page-store stub for the ownership gate and the #913 cut/copy/paste
 * actions. `getState()` exposes `blocksById` (for `storeOwnsBlock`), `blocks`
 * (for serialization), and the `remove` / `pasteBlocks` action spies.
 */
function makePageStore(
  rows: Array<string | StubRow> = [],
): UseBlockTreeKeyboardShortcutsOptions['pageStore'] & {
  __remove: ReturnType<typeof vi.fn>
  __pasteBlocks: ReturnType<typeof vi.fn>
} {
  const blocks: StubRow[] = rows.map((r) =>
    typeof r === 'string' ? { id: r, depth: 0, parent_id: null, content: r } : r,
  )
  const blocksById = new Map(blocks.map((b) => [b.id, b]))
  const remove = vi.fn().mockResolvedValue(undefined)
  const pasteBlocks = vi.fn().mockResolvedValue([])
  const store = {
    getState: () => ({ blocksById, blocks, remove, pasteBlocks }),
    setState: vi.fn(),
    getInitialState: vi.fn(),
    subscribe: vi.fn(),
  } as unknown as UseBlockTreeKeyboardShortcutsOptions['pageStore']
  return Object.assign(store, { __remove: remove, __pasteBlocks: pasteBlocks })
}

function makeOptions(
  overrides: Partial<UseBlockTreeKeyboardShortcutsOptions> = {},
): UseBlockTreeKeyboardShortcutsOptions {
  return {
    focusedBlockId: 'BLOCK_1',
    pageStore: makePageStore(['BLOCK_1', 'BLOCK_2']),
    selectedBlockIds: [],
    hasChildrenSet: new Set(['BLOCK_1']),
    blocks: [{ id: 'BLOCK_1' }, { id: 'BLOCK_2' }],
    toggleCollapse: vi.fn(),
    rawSelectAll: vi.fn(),
    clearSelected: vi.fn(),
    handleFlush: vi.fn(() => null),
    setFocused: vi.fn(),
    handleToggleTodo: vi.fn(),
    handleSlashCommand: vi.fn(),
    rovingEditor: { editor: null },
    datePickerCursorPos: { current: undefined },
    setDatePickerMode: vi.fn(),
    setDatePickerOpen: vi.fn(),
    zoomedBlockId: null,
    zoomToRoot: vi.fn(),
    zoomIn: vi.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockWriteText.mockResolvedValue(undefined)
  mockReadText.mockResolvedValue('')
  useBlockStore.setState({ focusedBlockId: null, selectedBlockIds: [] })
  // #774 — clear the last-interacted-tree registry between tests so a
  // marker from a prior test can't leak into the tie-break assertions.
  __resetLastInteractedTreeForTests()
})

describe('useBlockTreeKeyboardShortcuts', () => {
  describe('Collapse toggle (Mod+.)', () => {
    it('calls toggleCollapse when Ctrl+. is pressed and block has children', () => {
      const opts = makeOptions()
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: '.', ctrlKey: true })

      expect(opts.toggleCollapse).toHaveBeenCalledWith('BLOCK_1')
    })

    it('does not call toggleCollapse when block has no children', () => {
      const opts = makeOptions({ hasChildrenSet: new Set() })
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: '.', ctrlKey: true })

      expect(opts.toggleCollapse).not.toHaveBeenCalled()
    })

    it('does not call toggleCollapse when no block is focused', () => {
      const opts = makeOptions({ focusedBlockId: null })
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: '.', ctrlKey: true })

      expect(opts.toggleCollapse).not.toHaveBeenCalled()
    })
  })

  describe('Multi-selection (Ctrl+A)', () => {
    it('calls rawSelectAll when Ctrl+A is pressed and no block is focused', () => {
      const opts = makeOptions({ focusedBlockId: null })
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: 'a', ctrlKey: true })

      expect(opts.rawSelectAll).toHaveBeenCalledWith(['BLOCK_1', 'BLOCK_2'])
    })

    it('does not select all when a block is focused', () => {
      const opts = makeOptions({ focusedBlockId: 'BLOCK_1' })
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: 'a', ctrlKey: true })

      expect(opts.rawSelectAll).not.toHaveBeenCalled()
    })
  })

  describe('Escape clears selection', () => {
    it('calls clearSelected when Escape is pressed with active selection', () => {
      const opts = makeOptions({
        focusedBlockId: null,
        selectedBlockIds: ['BLOCK_1'],
      })
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: 'Escape' })

      expect(opts.clearSelected).toHaveBeenCalledTimes(1)
    })

    it('does not clear selection when no blocks are selected', () => {
      const opts = makeOptions({ focusedBlockId: null, selectedBlockIds: [] })
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: 'Escape' })

      expect(opts.clearSelected).not.toHaveBeenCalled()
    })
  })

  describe('Block cut/copy/paste (#913)', () => {
    /** Two top-level blocks + one child, owned by this store. */
    function clipboardOpts(overrides: Partial<UseBlockTreeKeyboardShortcutsOptions> = {}) {
      const pageStore = makePageStore([
        { id: 'A', depth: 0, parent_id: 'PAGE_1', content: 'alpha' },
        { id: 'A1', depth: 1, parent_id: 'A', content: 'alpha-child' },
        { id: 'B', depth: 0, parent_id: 'PAGE_1', content: 'beta' },
      ])
      return {
        opts: makeOptions({ pageStore, focusedBlockId: null, ...overrides }),
        pageStore,
      }
    }

    it('Ctrl+C copies the selected roots + subtrees as indented markdown', () => {
      const { opts } = clipboardOpts({ selectedBlockIds: ['A', 'B'] })
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: 'c', ctrlKey: true })

      expect(mockWriteText).toHaveBeenCalledWith('alpha\n  alpha-child\nbeta')
    })

    it('Ctrl+X copies then removes the selection roots and clears selection', () => {
      const { opts, pageStore } = clipboardOpts({ selectedBlockIds: ['A', 'B'] })
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: 'x', ctrlKey: true })

      expect(mockWriteText).toHaveBeenCalledWith('alpha\n  alpha-child\nbeta')
      // Only the roots A and B are removed (A1 cascades with A).
      expect(pageStore.__remove).toHaveBeenCalledWith('A')
      expect(pageStore.__remove).toHaveBeenCalledWith('B')
      expect(pageStore.__remove).not.toHaveBeenCalledWith('A1')
      expect(opts.clearSelected).toHaveBeenCalled()
    })

    it('Ctrl+V reads the clipboard and inserts after the last selected block', async () => {
      mockReadText.mockResolvedValue('pasted\n  nested')
      const { opts, pageStore } = clipboardOpts({ selectedBlockIds: ['A', 'B'] })
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: 'v', ctrlKey: true })
      // The async readText().then(pasteBlocks) chain resolves on a microtask.
      await Promise.resolve()
      await Promise.resolve()

      expect(mockReadText).toHaveBeenCalled()
      // Anchor = last selected owned block (B).
      expect(pageStore.__pasteBlocks).toHaveBeenCalledWith('B', 'pasted\n  nested')
    })

    it('does not copy/cut when no blocks are selected', () => {
      const { opts } = clipboardOpts({ selectedBlockIds: [] })
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: 'c', ctrlKey: true })
      fireEvent.keyDown(document, { key: 'x', ctrlKey: true })

      expect(mockWriteText).not.toHaveBeenCalled()
    })

    it('does not fire when a block is focused (editor active — browser owns the chord)', async () => {
      const { opts, pageStore } = clipboardOpts({
        selectedBlockIds: ['A'],
        focusedBlockId: 'A',
      })
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: 'c', ctrlKey: true })
      fireEvent.keyDown(document, { key: 'x', ctrlKey: true })
      fireEvent.keyDown(document, { key: 'v', ctrlKey: true })
      await Promise.resolve()

      expect(mockWriteText).not.toHaveBeenCalled()
      expect(mockReadText).not.toHaveBeenCalled()
      expect(pageStore.__pasteBlocks).not.toHaveBeenCalled()
    })

    it('does not act when the selection belongs to another store (ownership gate)', () => {
      // Selected ids are NOT in this store's blocksById.
      const { opts } = clipboardOpts({ selectedBlockIds: ['OTHER_1', 'OTHER_2'] })
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: 'c', ctrlKey: true })

      expect(mockWriteText).not.toHaveBeenCalled()
    })
  })

  describe('Unfocused Escape closes editor (UX-M8)', () => {
    it('calls handleFlush and setFocused(null) when Escape is pressed and editor is unfocused', () => {
      const opts = makeOptions()
      // Simulate the store having a focused block but no selection
      useBlockStore.setState({ focusedBlockId: 'BLOCK_1', selectedBlockIds: [] })
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: 'Escape' })

      expect(opts.handleFlush).toHaveBeenCalled()
      expect(opts.setFocused).toHaveBeenCalledWith(null)
    })

    it('does not close editor when store has no focused block', () => {
      const opts = makeOptions()
      useBlockStore.setState({ focusedBlockId: null, selectedBlockIds: [] })
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: 'Escape' })

      expect(opts.handleFlush).not.toHaveBeenCalled()
    })
  })

  describe('Task cycling (Ctrl+Enter)', () => {
    it('calls handleToggleTodo when Ctrl+Enter is pressed and block is focused', () => {
      const opts = makeOptions()
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: 'Enter', ctrlKey: true })

      expect(opts.handleToggleTodo).toHaveBeenCalledWith('BLOCK_1')
    })

    it('does not call handleToggleTodo when no block is focused', () => {
      const opts = makeOptions({ focusedBlockId: null })
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: 'Enter', ctrlKey: true })

      expect(opts.handleToggleTodo).not.toHaveBeenCalled()
    })
  })

  describe('Date picker (Ctrl+Shift+D)', () => {
    it('opens date picker when Ctrl+Shift+D is pressed', () => {
      const opts = makeOptions()
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: 'D', ctrlKey: true, shiftKey: true })

      expect(opts.setDatePickerMode).toHaveBeenCalledWith('date')
      expect(opts.setDatePickerOpen).toHaveBeenCalledWith(true)
    })

    it('does not open date picker when no block is focused', () => {
      const opts = makeOptions({ focusedBlockId: null })
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: 'D', ctrlKey: true, shiftKey: true })

      expect(opts.setDatePickerOpen).not.toHaveBeenCalled()
    })
  })

  describe('Heading shortcut (Ctrl+1-6)', () => {
    it('calls handleSlashCommand with heading level for Ctrl+1', () => {
      const opts = makeOptions()
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: '1', ctrlKey: true })

      expect(opts.handleSlashCommand).toHaveBeenCalledWith({ id: 'h1', label: 'Heading 1' })
    })

    it('calls handleSlashCommand with heading level for Ctrl+6', () => {
      const opts = makeOptions()
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: '6', ctrlKey: true })

      expect(opts.handleSlashCommand).toHaveBeenCalledWith({ id: 'h6', label: 'Heading 6' })
    })

    it('ignores Ctrl+Shift+number (reserved for priority)', () => {
      const opts = makeOptions()
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: '1', ctrlKey: true, shiftKey: true })

      expect(opts.handleSlashCommand).not.toHaveBeenCalled()
    })

    it('does not fire heading shortcut when no block is focused', () => {
      const opts = makeOptions({ focusedBlockId: null })
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: '1', ctrlKey: true })

      expect(opts.handleSlashCommand).not.toHaveBeenCalled()
    })
  })

  describe('Zoom out (Escape) — UX-214', () => {
    it('calls zoomToRoot when Escape is pressed while zoomed and no editor/selection', () => {
      const opts = makeOptions({
        focusedBlockId: null,
        selectedBlockIds: [],
        zoomedBlockId: 'BLOCK_1',
      })
      useBlockStore.setState({ focusedBlockId: null, selectedBlockIds: [] })
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: 'Escape' })

      expect(opts.zoomToRoot).toHaveBeenCalledTimes(1)
    })

    it('does not call zoomToRoot when not zoomed in', () => {
      const opts = makeOptions({
        focusedBlockId: null,
        selectedBlockIds: [],
        zoomedBlockId: null,
      })
      useBlockStore.setState({ focusedBlockId: null, selectedBlockIds: [] })
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: 'Escape' })

      expect(opts.zoomToRoot).not.toHaveBeenCalled()
    })

    it('does not call zoomToRoot when a block is being edited', () => {
      const opts = makeOptions({
        focusedBlockId: 'BLOCK_1',
        selectedBlockIds: [],
        zoomedBlockId: 'BLOCK_1',
      })
      useBlockStore.setState({ focusedBlockId: 'BLOCK_1', selectedBlockIds: [] })
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: 'Escape' })

      expect(opts.zoomToRoot).not.toHaveBeenCalled()
    })

    it('does not call zoomToRoot when a multi-selection is active', () => {
      const opts = makeOptions({
        focusedBlockId: null,
        selectedBlockIds: ['BLOCK_1'],
        zoomedBlockId: 'BLOCK_1',
      })
      useBlockStore.setState({ focusedBlockId: null, selectedBlockIds: ['BLOCK_1'] })
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: 'Escape' })

      expect(opts.zoomToRoot).not.toHaveBeenCalled()
    })

    it('does not call zoomToRoot when a different key is pressed', () => {
      const opts = makeOptions({
        focusedBlockId: null,
        selectedBlockIds: [],
        zoomedBlockId: 'BLOCK_1',
      })
      useBlockStore.setState({ focusedBlockId: null, selectedBlockIds: [] })
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: 'Enter' })
      fireEvent.keyDown(document, { key: 'z', ctrlKey: true })

      expect(opts.zoomToRoot).not.toHaveBeenCalled()
    })

    it('#774 — only the last-interacted zoomed tree claims Escape (not mount-order-first)', () => {
      // Two zoomed trees mounted; tree1 mounts FIRST (its keydown listener
      // would win the old defaultPrevented race). The user last interacted
      // with tree2 (focus was in tree2). Escape must zoom out tree2 only.
      const tree1Store = makePageStore(['T1_BLOCK'])
      const tree2Store = makePageStore(['T2_BLOCK'])

      const tree1 = makeOptions({
        focusedBlockId: null,
        selectedBlockIds: [],
        zoomedBlockId: 'T1_BLOCK',
        pageStore: tree1Store,
        zoomToRoot: vi.fn(),
      })
      const tree2 = makeOptions({
        focusedBlockId: null,
        selectedBlockIds: [],
        zoomedBlockId: 'T2_BLOCK',
        pageStore: tree2Store,
        zoomToRoot: vi.fn(),
      })

      // Mount tree1 first (earliest mount → first keydown listener).
      renderHook(() => useBlockTreeKeyboardShortcuts(tree1))
      // Mount tree2, and simulate the user interacting with it: its store
      // owns the focused block, which marks tree2 as last-interacted via the
      // ownership effect. Then re-render with focus cleared (Escape requires
      // no focus) — the last-interacted marker persists.
      const tree2Focused: UseBlockTreeKeyboardShortcutsOptions = {
        ...tree2,
        focusedBlockId: 'T2_BLOCK',
      }
      const { rerender } = renderHook(
        (props: UseBlockTreeKeyboardShortcutsOptions) => useBlockTreeKeyboardShortcuts(props),
        { initialProps: tree2Focused },
      )
      useBlockStore.setState({ focusedBlockId: null, selectedBlockIds: [] })
      rerender({ ...tree2, focusedBlockId: null })

      fireEvent.keyDown(document, { key: 'Escape' })

      // Tie-break: tree2 (last-interacted) zooms out; tree1 (mounted first)
      // does NOT — the old mount-order race is fixed.
      expect(tree2.zoomToRoot).toHaveBeenCalledTimes(1)
      expect(tree1.zoomToRoot).not.toHaveBeenCalled()
    })

    it('#774 — a lone zoomed tree handles Escape even with no prior interaction (fail-open)', () => {
      // Single PageEditor, no interaction recorded yet → isLastInteractedTree
      // returns true so the common case still works without a prior focus.
      const opts = makeOptions({
        focusedBlockId: null,
        selectedBlockIds: [],
        zoomedBlockId: 'BLOCK_1',
      })
      useBlockStore.setState({ focusedBlockId: null, selectedBlockIds: [] })
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: 'Escape' })

      expect(opts.zoomToRoot).toHaveBeenCalledTimes(1)
    })
  })

  describe('Zoom in (Alt+.) — D1 (#217)', () => {
    it('calls zoomIn for the focused parent block when Alt+. is pressed', () => {
      const opts = makeOptions({ focusedBlockId: 'BLOCK_1', hasChildrenSet: new Set(['BLOCK_1']) })
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: '.', altKey: true })

      expect(opts.zoomIn).toHaveBeenCalledWith('BLOCK_1')
      // Flushes + clears focus before navigating, like the other zoom paths.
      expect(opts.handleFlush).toHaveBeenCalled()
      expect(opts.setFocused).toHaveBeenCalledWith(null)
    })

    it('#922 — zooms into a LEAF (childless) block too — the gate is gone', () => {
      // Previously childless blocks were rejected; #922 drops that gate so any
      // block can be zoomed (BlockTree seeds a first child under the leaf).
      const opts = makeOptions({ focusedBlockId: 'BLOCK_1', hasChildrenSet: new Set() })
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: '.', altKey: true })

      expect(opts.zoomIn).toHaveBeenCalledWith('BLOCK_1')
      expect(opts.handleFlush).toHaveBeenCalled()
      expect(opts.setFocused).toHaveBeenCalledWith(null)
    })

    it('does not zoom in when no block is focused', () => {
      const opts = makeOptions({ focusedBlockId: null })
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: '.', altKey: true })

      expect(opts.zoomIn).not.toHaveBeenCalled()
    })

    it('does not zoom in on a bare Ctrl+. (collapse) without Alt', () => {
      const opts = makeOptions({ focusedBlockId: 'BLOCK_1', hasChildrenSet: new Set(['BLOCK_1']) })
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      fireEvent.keyDown(document, { key: '.', ctrlKey: true })

      expect(opts.zoomIn).not.toHaveBeenCalled()
    })
  })

  // #713 — journal week/month mount one BlockTree (and one copy of these
  // document listeners) per day, all sharing the global focusedBlockId.
  // Only the tree whose page store owns the focused block may act, and a
  // non-handling tree must not swallow the chord via preventDefault.
  describe('#713 — multi-tree ownership gating', () => {
    /** Two trees with distinct page stores; the global focus is in tree A. */
    function renderTwoTrees() {
      const treeA = makeOptions({
        focusedBlockId: 'BLOCK_A',
        pageStore: makePageStore(['BLOCK_A']),
        hasChildrenSet: new Set(['BLOCK_A']),
      })
      const treeB = makeOptions({
        focusedBlockId: 'BLOCK_A', // global focus — foreign to tree B's store
        pageStore: makePageStore(['BLOCK_B']),
        hasChildrenSet: new Set(['BLOCK_B']),
      })
      renderHook(() => useBlockTreeKeyboardShortcuts(treeA))
      renderHook(() => useBlockTreeKeyboardShortcuts(treeB))
      return { treeA, treeB }
    }

    function dispatchKey(init: KeyboardEventInit): KeyboardEvent {
      const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
      document.dispatchEvent(e)
      return e
    }

    it('Ctrl+Enter cycles the todo exactly once, in the owning tree only', () => {
      const { treeA, treeB } = renderTwoTrees()

      const e = dispatchKey({ key: 'Enter', ctrlKey: true })

      expect(treeA.handleToggleTodo).toHaveBeenCalledTimes(1)
      expect(treeA.handleToggleTodo).toHaveBeenCalledWith('BLOCK_A')
      expect(treeB.handleToggleTodo).not.toHaveBeenCalled()
      expect(e.defaultPrevented).toBe(true)
    })

    it('Mod+. collapses exactly once, in the owning tree only', () => {
      const { treeA, treeB } = renderTwoTrees()

      const e = dispatchKey({ key: '.', ctrlKey: true })

      expect(treeA.toggleCollapse).toHaveBeenCalledTimes(1)
      expect(treeA.toggleCollapse).toHaveBeenCalledWith('BLOCK_A')
      expect(treeB.toggleCollapse).not.toHaveBeenCalled()
      expect(e.defaultPrevented).toBe(true)
    })

    it('date-picker chord opens exactly one picker, in the owning tree only', () => {
      const { treeA, treeB } = renderTwoTrees()

      dispatchKey({ key: 'D', ctrlKey: true, shiftKey: true })

      expect(treeA.setDatePickerOpen).toHaveBeenCalledTimes(1)
      expect(treeA.setDatePickerOpen).toHaveBeenCalledWith(true)
      expect(treeB.setDatePickerOpen).not.toHaveBeenCalled()
    })

    it('heading chord routes to the owning tree only', () => {
      const { treeA, treeB } = renderTwoTrees()

      dispatchKey({ key: '1', ctrlKey: true })

      expect(treeA.handleSlashCommand).toHaveBeenCalledTimes(1)
      expect(treeA.handleSlashCommand).toHaveBeenCalledWith({ id: 'h1', label: 'Heading 1' })
      expect(treeB.handleSlashCommand).not.toHaveBeenCalled()
    })

    it('Alt+. zooms in exactly once, in the owning tree only', () => {
      const { treeA, treeB } = renderTwoTrees()

      dispatchKey({ key: '.', altKey: true })

      expect(treeA.zoomIn).toHaveBeenCalledTimes(1)
      expect(treeA.zoomIn).toHaveBeenCalledWith('BLOCK_A')
      expect(treeB.zoomIn).not.toHaveBeenCalled()
      expect(treeB.handleFlush).not.toHaveBeenCalled()
    })

    it('unfocused Escape flushes only the owning tree (UX-M8)', () => {
      useBlockStore.setState({ focusedBlockId: 'BLOCK_A', selectedBlockIds: [] })
      const { treeA, treeB } = renderTwoTrees()

      fireEvent.keyDown(document, { key: 'Escape' })

      expect(treeA.handleFlush).toHaveBeenCalledTimes(1)
      expect(treeA.setFocused).toHaveBeenCalledWith(null)
      expect(treeB.handleFlush).not.toHaveBeenCalled()
      expect(treeB.setFocused).not.toHaveBeenCalled()
    })

    it('a non-owning tree alone performs zero side effects and never preventDefaults', () => {
      const opts = makeOptions({
        focusedBlockId: 'BLOCK_A', // foreign — not in this tree's store
        pageStore: makePageStore(['BLOCK_B']),
        hasChildrenSet: new Set(['BLOCK_B']),
      })
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      const events = [
        dispatchKey({ key: 'Enter', ctrlKey: true }),
        dispatchKey({ key: '.', ctrlKey: true }),
        dispatchKey({ key: '.', altKey: true }),
        dispatchKey({ key: 'D', ctrlKey: true, shiftKey: true }),
        dispatchKey({ key: '1', ctrlKey: true }),
      ]

      expect(opts.handleToggleTodo).not.toHaveBeenCalled()
      expect(opts.toggleCollapse).not.toHaveBeenCalled()
      expect(opts.zoomIn).not.toHaveBeenCalled()
      expect(opts.setDatePickerOpen).not.toHaveBeenCalled()
      expect(opts.handleSlashCommand).not.toHaveBeenCalled()
      for (const e of events) expect(e.defaultPrevented).toBe(false)
    })

    it('keeps the browser default when NO block is focused (chords pass through)', () => {
      const opts = makeOptions({ focusedBlockId: null })
      renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      const enter = dispatchKey({ key: 'Enter', ctrlKey: true })
      const dot = dispatchKey({ key: '.', ctrlKey: true })

      expect(enter.defaultPrevented).toBe(false)
      expect(dot.defaultPrevented).toBe(false)
    })
  })

  describe('Cleanup', () => {
    it('removes event listeners on unmount', () => {
      const opts = makeOptions()
      const { unmount } = renderHook(() => useBlockTreeKeyboardShortcuts(opts))

      unmount()

      // After unmount, keyboard events should not trigger callbacks
      fireEvent.keyDown(document, { key: '.', ctrlKey: true })
      fireEvent.keyDown(document, { key: 'Enter', ctrlKey: true })
      fireEvent.keyDown(document, { key: '1', ctrlKey: true })

      expect(opts.toggleCollapse).not.toHaveBeenCalled()
      expect(opts.handleToggleTodo).not.toHaveBeenCalled()
      expect(opts.handleSlashCommand).not.toHaveBeenCalled()
    })
  })
})
