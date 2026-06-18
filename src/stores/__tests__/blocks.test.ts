import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useBlockStore } from '../blocks'

describe('useBlockStore', () => {
  beforeEach(() => {
    useBlockStore.setState({
      focusedBlockId: null,
      selectedBlockIds: [],
    })
    vi.clearAllMocks()
  })

  // ---------------------------------------------------------------------------
  // setFocused
  // ---------------------------------------------------------------------------
  describe('setFocused', () => {
    it('sets the focused block id', () => {
      useBlockStore.getState().setFocused('BLOCK_A')
      expect(useBlockStore.getState().focusedBlockId).toBe('BLOCK_A')
    })

    it('clears the focused block id', () => {
      useBlockStore.setState({ focusedBlockId: 'BLOCK_A' })
      useBlockStore.getState().setFocused(null)
      expect(useBlockStore.getState().focusedBlockId).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // block selection (#657)
  // ---------------------------------------------------------------------------
  describe('block selection', () => {
    beforeEach(() => {
      useBlockStore.setState({
        selectedBlockIds: [],
        focusedBlockId: null,
      })
    })

    it('toggleSelected adds and removes block IDs', () => {
      useBlockStore.getState().toggleSelected('A')
      expect(useBlockStore.getState().selectedBlockIds).toEqual(['A'])
      useBlockStore.getState().toggleSelected('B')
      expect(useBlockStore.getState().selectedBlockIds).toEqual(['A', 'B'])
      useBlockStore.getState().toggleSelected('A')
      expect(useBlockStore.getState().selectedBlockIds).toEqual(['B'])
    })

    it('rangeSelect selects contiguous blocks', () => {
      useBlockStore.getState().toggleSelected('A')
      useBlockStore.getState().rangeSelect('C', ['A', 'B', 'C', 'D'])
      expect(useBlockStore.getState().selectedBlockIds).toEqual(['A', 'B', 'C'])
    })

    it('rangeSelect with empty selection starts from clicked block', () => {
      useBlockStore.getState().rangeSelect('B', ['A', 'B', 'C'])
      expect(useBlockStore.getState().selectedBlockIds).toEqual(['B'])
    })

    it('rangeSelect handles missing last selected block gracefully', () => {
      useBlockStore.setState({ selectedBlockIds: ['DELETED_BLOCK'] })
      useBlockStore.getState().rangeSelect('B', ['A', 'B', 'C'])
      expect(useBlockStore.getState().selectedBlockIds).toEqual(['B'])
    })

    // #1729 — Shift+Click adopts the anchor/focus REPLACE model (matches
    // Shift+Arrow in the same tree and Shift+Click in the list views) so the
    // gesture can SHRINK as well as grow, instead of the old union-only path.
    describe('rangeSelect anchor/focus model (#1729)', () => {
      const visible = ['A', 'B', 'C', 'D', 'E']

      it('seeds the anchor on a first click into an empty selection', () => {
        useBlockStore.getState().rangeSelect('C', visible)
        expect(useBlockStore.getState().selectedBlockIds).toEqual(['C'])
        expect(useBlockStore.getState().selectionAnchorId).toBe('C')
        expect(useBlockStore.getState().selectionFocusId).toBe('C')
      })

      it('SHRINKS the range when a second click lands nearer the anchor', () => {
        useBlockStore.getState().rangeSelect('A', visible) // anchor A
        useBlockStore.getState().rangeSelect('D', visible) // A..D
        expect(useBlockStore.getState().selectedBlockIds).toEqual(['A', 'B', 'C', 'D'])
        useBlockStore.getState().rangeSelect('B', visible) // shrink to A..B
        expect(useBlockStore.getState().selectedBlockIds).toEqual(['A', 'B'])
        // Anchor stays fixed; focus follows the click.
        expect(useBlockStore.getState().selectionAnchorId).toBe('A')
        expect(useBlockStore.getState().selectionFocusId).toBe('B')
      })

      it('REPLACES rather than unions a prior range (clicking the other side of the anchor)', () => {
        useBlockStore.getState().rangeSelect('C', visible) // anchor C
        useBlockStore.getState().rangeSelect('E', visible) // C..E
        expect(useBlockStore.getState().selectedBlockIds).toEqual(['C', 'D', 'E'])
        useBlockStore.getState().rangeSelect('A', visible) // flip below anchor
        // Union-only would have kept C,D,E; replace model yields A..C only.
        expect(useBlockStore.getState().selectedBlockIds).toEqual(['A', 'B', 'C'])
        expect(useBlockStore.getState().selectionAnchorId).toBe('C')
      })

      it('persists anchor + focus so a following Shift+Arrow continues from the click', () => {
        useBlockStore.getState().rangeSelect('B', visible) // anchor B
        useBlockStore.getState().rangeSelect('D', visible) // B..D, focus D
        useBlockStore.getState().extendSelection('down', visible) // → B..E
        expect(useBlockStore.getState().selectedBlockIds).toEqual(['B', 'C', 'D', 'E'])
        expect(useBlockStore.getState().selectionAnchorId).toBe('B')
        expect(useBlockStore.getState().selectionFocusId).toBe('E')
      })

      it('falls back to the last selected block when no anchor is set (legacy state)', () => {
        // No selectionAnchorId (e.g. selection seeded via toggle/Ctrl+Click).
        useBlockStore.setState({
          selectedBlockIds: ['A'],
          selectionAnchorId: null,
          selectionFocusId: null,
        })
        useBlockStore.getState().rangeSelect('C', visible)
        expect(useBlockStore.getState().selectedBlockIds).toEqual(['A', 'B', 'C'])
        expect(useBlockStore.getState().selectionAnchorId).toBe('A')
      })
    })

    it('selectAll selects all blocks', () => {
      useBlockStore.getState().selectAll(['A', 'B', 'C'])
      expect(useBlockStore.getState().selectedBlockIds).toEqual(['A', 'B', 'C'])
    })

    it('clearSelected empties selection', () => {
      useBlockStore.getState().selectAll(['A', 'B', 'C'])
      useBlockStore.getState().clearSelected()
      expect(useBlockStore.getState().selectedBlockIds).toEqual([])
    })

    it('setSelected replaces current selection', () => {
      useBlockStore.getState().setSelected(['B', 'C'])
      expect(useBlockStore.getState().selectedBlockIds).toEqual(['B', 'C'])
    })

    it('setFocused clears selection', () => {
      useBlockStore.getState().selectAll(['A', 'B', 'C'])
      useBlockStore.getState().setFocused('A')
      expect(useBlockStore.getState().selectedBlockIds).toEqual([])
    })
  })

  // ---------------------------------------------------------------------------
  // keyboard range extension (#922 — Shift+Arrow)
  // ---------------------------------------------------------------------------
  describe('extendSelection (#922)', () => {
    const visible = ['A', 'B', 'C', 'D']

    beforeEach(() => {
      useBlockStore.setState({
        selectedBlockIds: [],
        focusedBlockId: null,
        selectionAnchorId: null,
        selectionFocusId: null,
      })
    })

    it('seeds the anchor from a single selected block and extends down', () => {
      useBlockStore.setState({ selectedBlockIds: ['B'] })
      useBlockStore.getState().extendSelection('down', visible)
      expect(useBlockStore.getState().selectedBlockIds).toEqual(['B', 'C'])
      expect(useBlockStore.getState().selectionAnchorId).toBe('B')
      expect(useBlockStore.getState().selectionFocusId).toBe('C')
    })

    it('extends further down on a second press, keeping the anchor fixed', () => {
      useBlockStore.setState({ selectedBlockIds: ['A'] })
      const { extendSelection } = useBlockStore.getState()
      extendSelection('down', visible)
      extendSelection('down', visible)
      expect(useBlockStore.getState().selectedBlockIds).toEqual(['A', 'B', 'C'])
      expect(useBlockStore.getState().selectionAnchorId).toBe('A')
      expect(useBlockStore.getState().selectionFocusId).toBe('C')
    })

    it('shrinks back toward the anchor when the opposite direction is pressed', () => {
      useBlockStore.setState({ selectedBlockIds: ['A'] })
      const { extendSelection } = useBlockStore.getState()
      extendSelection('down', visible) // A,B
      extendSelection('down', visible) // A,B,C
      extendSelection('up', visible) // back to A,B
      expect(useBlockStore.getState().selectedBlockIds).toEqual(['A', 'B'])
      expect(useBlockStore.getState().selectionFocusId).toBe('B')
    })

    it('crosses the anchor — extending up past the start flips the range below→above', () => {
      useBlockStore.setState({ selectedBlockIds: ['C'] })
      const { extendSelection } = useBlockStore.getState()
      extendSelection('up', visible) // anchor C, focus B → B,C
      extendSelection('up', visible) // focus A → A,B,C
      expect(useBlockStore.getState().selectedBlockIds).toEqual(['A', 'B', 'C'])
      expect(useBlockStore.getState().selectionAnchorId).toBe('C')
      expect(useBlockStore.getState().selectionFocusId).toBe('A')
    })

    it('clamps at the bottom edge (no wrap, state unchanged)', () => {
      useBlockStore.setState({ selectedBlockIds: ['D'] })
      useBlockStore.getState().extendSelection('down', visible)
      expect(useBlockStore.getState().selectedBlockIds).toEqual(['D'])
    })

    it('clamps at the top edge (no wrap, state unchanged)', () => {
      useBlockStore.setState({ selectedBlockIds: ['A'] })
      useBlockStore.getState().extendSelection('up', visible)
      expect(useBlockStore.getState().selectedBlockIds).toEqual(['A'])
    })

    it('is a no-op when there is no selection to anchor on', () => {
      useBlockStore.getState().extendSelection('down', visible)
      expect(useBlockStore.getState().selectedBlockIds).toEqual([])
    })

    it('re-seeds the anchor after a toggle resets the keyboard range', () => {
      useBlockStore.setState({ selectedBlockIds: ['A'] })
      useBlockStore.getState().extendSelection('down', visible) // anchor A, focus B
      // A discrete toggle clears the keyboard anchor.
      useBlockStore.getState().toggleSelected('B') // now ['A'] (B removed)
      expect(useBlockStore.getState().selectionAnchorId).toBeNull()
      // Next Shift+Arrow re-seeds from the last selected (A).
      useBlockStore.getState().extendSelection('down', visible)
      expect(useBlockStore.getState().selectionAnchorId).toBe('A')
      expect(useBlockStore.getState().selectedBlockIds).toEqual(['A', 'B'])
    })

    it('setFocused / clearSelected / setSelected reset the keyboard anchor', () => {
      useBlockStore.setState({ selectedBlockIds: ['A'] })
      useBlockStore.getState().extendSelection('down', visible)
      expect(useBlockStore.getState().selectionAnchorId).not.toBeNull()

      useBlockStore.getState().clearSelected()
      expect(useBlockStore.getState().selectionAnchorId).toBeNull()
      expect(useBlockStore.getState().selectionFocusId).toBeNull()

      useBlockStore.setState({ selectedBlockIds: ['B'] })
      useBlockStore.getState().extendSelection('down', visible)
      useBlockStore.getState().setSelected(['C'])
      expect(useBlockStore.getState().selectionAnchorId).toBeNull()

      useBlockStore.setState({ selectedBlockIds: ['B'] })
      useBlockStore.getState().extendSelection('down', visible)
      useBlockStore.getState().setFocused('B')
      expect(useBlockStore.getState().selectionAnchorId).toBeNull()
    })
  })
})
