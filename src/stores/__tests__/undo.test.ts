import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useUndoStore } from '../undo'

vi.mock('@/lib/tauri', () => ({
  undoPageOp: vi.fn(),
  redoPageOp: vi.fn(),
}))

import { redoPageOp, undoPageOp } from '@/lib/tauri'

const mockedUndoPageOp = vi.mocked(undoPageOp)
const mockedRedoPageOp = vi.mocked(redoPageOp)

/** Helper — build a mock UndoResult. */
function makeUndoResult(
  overrides: Partial<{
    deviceId: string
    seq: number
    newSeq: number
    isRedo: boolean
  }> = {},
) {
  const deviceId = overrides.deviceId ?? 'device1'
  const seq = overrides.seq ?? 1
  const newSeq = overrides.newSeq ?? seq + 1
  return {
    reversed_op: { device_id: deviceId, seq },
    new_op: {
      device_id: deviceId,
      seq: newSeq,
      op_type: 'edit_block',
      payload: '{}',
      created_at: '2025-01-01T00:00:00Z',
    },
    is_redo: overrides.isRedo ?? false,
  }
}

describe('useUndoStore', () => {
  beforeEach(() => {
    useUndoStore.setState({ pages: new Map() })
    vi.clearAllMocks()
  })

  // ---------------------------------------------------------------------------
  // initial state
  // ---------------------------------------------------------------------------
  describe('initial state', () => {
    it('canRedo returns false for an unknown page', () => {
      expect(useUndoStore.getState().canRedo('page1')).toBe(false)
    })

    it('canUndo returns true (backend decides)', () => {
      expect(useUndoStore.getState().canUndo('page1')).toBe(true)
    })

    it('pages map is empty', () => {
      expect(useUndoStore.getState().pages.size).toBe(0)
    })
  })

  // ---------------------------------------------------------------------------
  // undo
  // ---------------------------------------------------------------------------
  describe('undo', () => {
    it('calls undoPageOp with pageId and undoDepth=0 on first undo', async () => {
      const result = makeUndoResult({ seq: 5, newSeq: 6 })
      mockedUndoPageOp.mockResolvedValueOnce(result)

      const returned = await useUndoStore.getState().undo('page1')

      expect(mockedUndoPageOp).toHaveBeenCalledWith({
        pageId: 'page1',
        undoDepth: 0,
      })
      expect(returned).toEqual(result)
    })

    it('increments undoDepth to 1 after first undo', async () => {
      mockedUndoPageOp.mockResolvedValueOnce(makeUndoResult({ seq: 5 }))

      await useUndoStore.getState().undo('page1')

      const pageState = useUndoStore.getState().pages.get('page1')
      expect(pageState?.undoDepth).toBe(1)
    })

    it('pushes reversed_op onto redoStack after undo', async () => {
      const result = makeUndoResult({ deviceId: 'dev1', seq: 5 })
      mockedUndoPageOp.mockResolvedValueOnce(result)

      await useUndoStore.getState().undo('page1')

      const pageState = useUndoStore.getState().pages.get('page1')
      expect(pageState?.redoStack).toHaveLength(1)
      expect(pageState?.redoStack[0]).toEqual({ device_id: 'dev1', seq: 5 })
    })

    it('calls with undoDepth=1 on second undo, increments to 2', async () => {
      mockedUndoPageOp.mockResolvedValueOnce(makeUndoResult({ seq: 5 }))
      await useUndoStore.getState().undo('page1')

      mockedUndoPageOp.mockResolvedValueOnce(makeUndoResult({ seq: 4 }))
      await useUndoStore.getState().undo('page1')

      expect(mockedUndoPageOp).toHaveBeenCalledTimes(2)
      expect(mockedUndoPageOp).toHaveBeenLastCalledWith({
        pageId: 'page1',
        undoDepth: 1,
      })

      const pageState = useUndoStore.getState().pages.get('page1')
      expect(pageState?.undoDepth).toBe(2)
      expect(pageState?.redoStack).toHaveLength(2)
    })

    it('returns null on backend error without changing state', async () => {
      mockedUndoPageOp.mockRejectedValueOnce(new Error('no undoable ops'))

      const returned = await useUndoStore.getState().undo('page1')

      expect(returned).toBeNull()
      // Optimistic increment was rolled back — depth is back to 0
      const pageState = useUndoStore.getState().pages.get('page1')
      expect(pageState?.undoDepth).toBe(0)
      expect(pageState?.redoStack).toEqual([])
    })

    it('does not change state on backend error after previous undo', async () => {
      mockedUndoPageOp.mockResolvedValueOnce(makeUndoResult({ seq: 5 }))
      await useUndoStore.getState().undo('page1')

      mockedUndoPageOp.mockRejectedValueOnce(new Error('fail'))
      await useUndoStore.getState().undo('page1')

      const pageState = useUndoStore.getState().pages.get('page1')
      expect(pageState?.undoDepth).toBe(1)
      expect(pageState?.redoStack).toHaveLength(1)
    })

    it('handles rapid undo calls without race condition', async () => {
      // Set up two sequential mock responses
      const result1 = makeUndoResult({ deviceId: 'dev1', seq: 5, newSeq: 6 })
      const result2 = makeUndoResult({ deviceId: 'dev1', seq: 4, newSeq: 5 })
      mockedUndoPageOp.mockResolvedValueOnce(result1).mockResolvedValueOnce(result2)

      // Fire two undos simultaneously
      const [r1, r2] = await Promise.all([
        useUndoStore.getState().undo('page1'),
        useUndoStore.getState().undo('page1'),
      ])

      // Both should succeed
      expect(r1).not.toBeNull()
      expect(r2).not.toBeNull()

      // undoDepth should be 2 (not 1)
      const state = useUndoStore.getState().pages.get('page1')
      expect(state?.undoDepth).toBe(2)

      // Backend should have been called with different depths
      expect(mockedUndoPageOp).toHaveBeenCalledTimes(2)
      expect(mockedUndoPageOp).toHaveBeenNthCalledWith(1, { pageId: 'page1', undoDepth: 0 })
      expect(mockedUndoPageOp).toHaveBeenNthCalledWith(2, { pageId: 'page1', undoDepth: 1 })
    })
  })

  // ---------------------------------------------------------------------------
  // redo
  // ---------------------------------------------------------------------------
  describe('redo', () => {
    it('returns null immediately when redoStack is empty (no backend call)', async () => {
      const returned = await useUndoStore.getState().redo('page1')

      expect(returned).toBeNull()
      expect(mockedRedoPageOp).not.toHaveBeenCalled()
    })

    it('pops from redoStack and calls redoPageOp', async () => {
      // First undo to populate redoStack
      mockedUndoPageOp.mockResolvedValueOnce(makeUndoResult({ deviceId: 'dev1', seq: 5 }))
      await useUndoStore.getState().undo('page1')

      const redoResult = makeUndoResult({ deviceId: 'dev1', seq: 5, isRedo: true })
      mockedRedoPageOp.mockResolvedValueOnce(redoResult)

      const returned = await useUndoStore.getState().redo('page1')

      expect(mockedRedoPageOp).toHaveBeenCalledWith({
        undoDeviceId: 'dev1',
        undoSeq: 5,
      })
      expect(returned).toEqual(redoResult)
    })

    it('decrements undoDepth after successful redo', async () => {
      // Undo twice
      mockedUndoPageOp.mockResolvedValueOnce(makeUndoResult({ seq: 5 }))
      await useUndoStore.getState().undo('page1')
      mockedUndoPageOp.mockResolvedValueOnce(makeUndoResult({ seq: 4 }))
      await useUndoStore.getState().undo('page1')

      expect(useUndoStore.getState().pages.get('page1')?.undoDepth).toBe(2)

      // Redo once
      mockedRedoPageOp.mockResolvedValueOnce(makeUndoResult({ isRedo: true }))
      await useUndoStore.getState().redo('page1')

      const pageState = useUndoStore.getState().pages.get('page1')
      expect(pageState?.undoDepth).toBe(1)
      expect(pageState?.redoStack).toHaveLength(1)
    })

    it('returns null on backend error without changing state', async () => {
      mockedUndoPageOp.mockResolvedValueOnce(makeUndoResult({ deviceId: 'dev1', seq: 5 }))
      await useUndoStore.getState().undo('page1')

      mockedRedoPageOp.mockRejectedValueOnce(new Error('redo failed'))
      const returned = await useUndoStore.getState().redo('page1')

      expect(returned).toBeNull()
      // State should be unchanged — redo stack still has 1 entry
      const pageState = useUndoStore.getState().pages.get('page1')
      expect(pageState?.undoDepth).toBe(1)
      expect(pageState?.redoStack).toHaveLength(1)
    })
  })

  // ---------------------------------------------------------------------------
  // canRedo
  // ---------------------------------------------------------------------------
  describe('canRedo', () => {
    it('returns true after undo', async () => {
      mockedUndoPageOp.mockResolvedValueOnce(makeUndoResult({ seq: 5 }))
      await useUndoStore.getState().undo('page1')

      expect(useUndoStore.getState().canRedo('page1')).toBe(true)
    })

    it('returns false after undo then redo (stack empty)', async () => {
      mockedUndoPageOp.mockResolvedValueOnce(makeUndoResult({ seq: 5 }))
      await useUndoStore.getState().undo('page1')

      mockedRedoPageOp.mockResolvedValueOnce(makeUndoResult({ isRedo: true }))
      await useUndoStore.getState().redo('page1')

      expect(useUndoStore.getState().canRedo('page1')).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // onNewAction
  // ---------------------------------------------------------------------------
  describe('onNewAction', () => {
    it('clears redoStack and resets undoDepth to 0', async () => {
      mockedUndoPageOp.mockResolvedValueOnce(makeUndoResult({ seq: 5 }))
      await useUndoStore.getState().undo('page1')

      expect(useUndoStore.getState().pages.get('page1')?.redoStack).toHaveLength(1)

      useUndoStore.getState().onNewAction('page1')

      const pageState = useUndoStore.getState().pages.get('page1')
      expect(pageState?.redoStack).toEqual([])
      expect(pageState?.undoDepth).toBe(0)
    })

    it('is safe to call on a page with no prior state', () => {
      useUndoStore.getState().onNewAction('new-page')

      const pageState = useUndoStore.getState().pages.get('new-page')
      expect(pageState?.redoStack).toEqual([])
      expect(pageState?.undoDepth).toBe(0)
    })
  })

  // ---------------------------------------------------------------------------
  // clearPage
  // ---------------------------------------------------------------------------
  describe('clearPage', () => {
    it('removes page state entirely', async () => {
      mockedUndoPageOp.mockResolvedValueOnce(makeUndoResult({ seq: 5 }))
      await useUndoStore.getState().undo('page1')

      expect(useUndoStore.getState().pages.has('page1')).toBe(true)

      useUndoStore.getState().clearPage('page1')

      expect(useUndoStore.getState().pages.has('page1')).toBe(false)
    })

    it('is safe to call on a page with no state', () => {
      useUndoStore.getState().clearPage('nonexistent')
      expect(useUndoStore.getState().pages.has('nonexistent')).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // multiple pages tracked independently
  // ---------------------------------------------------------------------------
  describe('multiple pages', () => {
    it('tracks undo state for different pages independently', async () => {
      // Undo on page1
      mockedUndoPageOp.mockResolvedValueOnce(makeUndoResult({ deviceId: 'dev1', seq: 1 }))
      await useUndoStore.getState().undo('page1')

      // Undo twice on page2
      mockedUndoPageOp.mockResolvedValueOnce(makeUndoResult({ deviceId: 'dev2', seq: 10 }))
      await useUndoStore.getState().undo('page2')
      mockedUndoPageOp.mockResolvedValueOnce(makeUndoResult({ deviceId: 'dev2', seq: 9 }))
      await useUndoStore.getState().undo('page2')

      const page1State = useUndoStore.getState().pages.get('page1')
      const page2State = useUndoStore.getState().pages.get('page2')

      expect(page1State?.undoDepth).toBe(1)
      expect(page1State?.redoStack).toHaveLength(1)
      expect(page2State?.undoDepth).toBe(2)
      expect(page2State?.redoStack).toHaveLength(2)
    })

    it('onNewAction on page1 does not affect page2', async () => {
      mockedUndoPageOp.mockResolvedValueOnce(makeUndoResult({ seq: 1 }))
      await useUndoStore.getState().undo('page1')
      mockedUndoPageOp.mockResolvedValueOnce(makeUndoResult({ seq: 10 }))
      await useUndoStore.getState().undo('page2')

      useUndoStore.getState().onNewAction('page1')

      expect(useUndoStore.getState().pages.get('page1')?.redoStack).toEqual([])
      expect(useUndoStore.getState().pages.get('page2')?.redoStack).toHaveLength(1)
    })

    it('clearPage on page1 does not affect page2', async () => {
      mockedUndoPageOp.mockResolvedValueOnce(makeUndoResult({ seq: 1 }))
      await useUndoStore.getState().undo('page1')
      mockedUndoPageOp.mockResolvedValueOnce(makeUndoResult({ seq: 10 }))
      await useUndoStore.getState().undo('page2')

      useUndoStore.getState().clearPage('page1')

      expect(useUndoStore.getState().pages.has('page1')).toBe(false)
      expect(useUndoStore.getState().pages.has('page2')).toBe(true)
    })
  })
})
