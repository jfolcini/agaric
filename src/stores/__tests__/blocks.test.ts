import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useBlockStore } from '../blocks'

describe('useBlockStore', () => {
  beforeEach(() => {
    useBlockStore.setState({
      focusedBlockId: null,
      selectedBlockIds: [],
      pendingFocusId: null,
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
  // consumePendingFocus
  // ---------------------------------------------------------------------------
  describe('consumePendingFocus', () => {
    it('returns and clears pendingFocusId', () => {
      useBlockStore.setState({ pendingFocusId: 'BLOCK_X' })
      const id = useBlockStore.getState().consumePendingFocus()
      expect(id).toBe('BLOCK_X')
      expect(useBlockStore.getState().pendingFocusId).toBeNull()
    })

    it('returns null when no pending focus', () => {
      const id = useBlockStore.getState().consumePendingFocus()
      expect(id).toBeNull()
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
})
