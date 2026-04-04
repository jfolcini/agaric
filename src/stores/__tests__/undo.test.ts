import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_REDO_STACK,
  UNDO_GROUP_WINDOW_MS,
  isWithinUndoGroup,
  useUndoStore,
} from '../undo'

vi.mock('@/lib/tauri', () => ({
  undoPageOp: vi.fn(),
  redoPageOp: vi.fn(),
  listPageHistory: vi.fn(),
}))

import { listPageHistory, redoPageOp, undoPageOp } from '@/lib/tauri'

const mockedUndoPageOp = vi.mocked(undoPageOp)
const mockedRedoPageOp = vi.mocked(redoPageOp)
const mockedListPageHistory = vi.mocked(listPageHistory)

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
    new_op_ref: { device_id: deviceId, seq: newSeq },
    new_op_type: 'edit_block',
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

    it('caps redoStack at MAX_REDO_STACK entries', async () => {
      for (let i = 0; i < MAX_REDO_STACK + 10; i++) {
        mockedUndoPageOp.mockResolvedValueOnce(
          makeUndoResult({ deviceId: 'dev1', seq: 1000 - i, newSeq: 2000 + i }),
        )
        await useUndoStore.getState().undo('page1')
      }

      const pageState = useUndoStore.getState().pages.get('page1')
      expect(pageState?.redoStack).toHaveLength(MAX_REDO_STACK)
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

// ---------------------------------------------------------------------------
// isWithinUndoGroup
// ---------------------------------------------------------------------------

describe('isWithinUndoGroup', () => {
  it('returns true for timestamps 50ms apart', () => {
    expect(isWithinUndoGroup('2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.050Z')).toBe(true)
  })

  it('returns false for timestamps 500ms apart', () => {
    expect(isWithinUndoGroup('2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.500Z')).toBe(false)
  })

  it('returns true for timestamps exactly at the boundary (200ms)', () => {
    expect(isWithinUndoGroup('2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.200Z')).toBe(true)
  })

  it('returns false for timestamps 201ms apart', () => {
    expect(isWithinUndoGroup('2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.201Z')).toBe(false)
  })

  it('returns false when either timestamp is invalid', () => {
    expect(isWithinUndoGroup('not-a-date', '2024-01-01T00:00:00.000Z')).toBe(false)
    expect(isWithinUndoGroup('2024-01-01T00:00:00.000Z', 'also-invalid')).toBe(false)
  })

  it('is order-independent (uses absolute difference)', () => {
    // Reversed order should give the same result
    expect(isWithinUndoGroup('2024-01-01T00:00:00.100Z', '2024-01-01T00:00:00.000Z')).toBe(true)
  })

  it('uses UNDO_GROUP_WINDOW_MS constant (200ms)', () => {
    expect(UNDO_GROUP_WINDOW_MS).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Batch undo / redo
// ---------------------------------------------------------------------------

/** Helper — build a mock HistoryEntry. */
function makeHistoryEntry(
  overrides: Partial<{
    device_id: string
    seq: number
    op_type: string
    payload: string
    created_at: string
  }> = {},
) {
  return {
    device_id: overrides.device_id ?? 'device1',
    seq: overrides.seq ?? 1,
    op_type: overrides.op_type ?? 'edit_block',
    payload: overrides.payload ?? '{}',
    created_at: overrides.created_at ?? '2024-01-01T00:00:00.000Z',
  }
}

describe('batch undo', () => {
  beforeEach(() => {
    useUndoStore.setState({ pages: new Map() })
    vi.clearAllMocks()
  })

  it('groups consecutive ops within 200ms window', async () => {
    const t = '2024-01-01T00:00:00'
    mockedListPageHistory.mockResolvedValueOnce({
      items: [
        makeHistoryEntry({ seq: 3, created_at: `${t}.150Z` }),
        makeHistoryEntry({ seq: 2, created_at: `${t}.100Z` }),
        makeHistoryEntry({ seq: 1, created_at: `${t}.000Z` }),
      ],
      next_cursor: null,
      has_more: false,
    })

    mockedUndoPageOp
      .mockResolvedValueOnce(makeUndoResult({ seq: 3, newSeq: 4 }))
      .mockResolvedValueOnce(makeUndoResult({ seq: 2, newSeq: 5 }))
      .mockResolvedValueOnce(makeUndoResult({ seq: 1, newSeq: 6 }))

    const result = await useUndoStore.getState().undo('page1')

    expect(result).not.toBeNull()
    expect(mockedUndoPageOp).toHaveBeenCalledTimes(3)

    const pageState = useUndoStore.getState().pages.get('page1')
    expect(pageState?.undoDepth).toBe(3)
    expect(pageState?.redoStack).toHaveLength(3)
  })

  it('stops at group boundary (>200ms gap)', async () => {
    const t = '2024-01-01T00:00:00'
    mockedListPageHistory.mockResolvedValueOnce({
      items: [
        makeHistoryEntry({ seq: 3, created_at: `${t}.500Z` }), // 350ms gap to seq 2
        makeHistoryEntry({ seq: 2, created_at: `${t}.150Z` }),
        makeHistoryEntry({ seq: 1, created_at: `${t}.000Z` }),
      ],
      next_cursor: null,
      has_more: false,
    })

    mockedUndoPageOp.mockResolvedValueOnce(makeUndoResult({ seq: 3, newSeq: 4 }))

    await useUndoStore.getState().undo('page1')

    // Only the first undo — the 350ms gap stops the batch
    expect(mockedUndoPageOp).toHaveBeenCalledTimes(1)
    expect(useUndoStore.getState().pages.get('page1')?.undoDepth).toBe(1)
  })

  it('stops when device_id changes between consecutive ops', async () => {
    const t = '2024-01-01T00:00:00'
    mockedListPageHistory.mockResolvedValueOnce({
      items: [
        makeHistoryEntry({ device_id: 'dev1', seq: 2, created_at: `${t}.100Z` }),
        makeHistoryEntry({ device_id: 'dev2', seq: 1, created_at: `${t}.000Z` }),
      ],
      next_cursor: null,
      has_more: false,
    })

    mockedUndoPageOp.mockResolvedValueOnce(makeUndoResult({ seq: 2, newSeq: 3 }))

    await useUndoStore.getState().undo('page1')

    expect(mockedUndoPageOp).toHaveBeenCalledTimes(1)
  })

  it('falls back to single undo when listPageHistory rejects', async () => {
    mockedListPageHistory.mockRejectedValueOnce(new Error('network error'))
    mockedUndoPageOp.mockResolvedValueOnce(makeUndoResult({ seq: 5, newSeq: 6 }))

    const result = await useUndoStore.getState().undo('page1')

    expect(result).not.toBeNull()
    expect(mockedUndoPageOp).toHaveBeenCalledTimes(1)
    expect(useUndoStore.getState().pages.get('page1')?.undoDepth).toBe(1)
  })

  it('skips undo_/redo_ ops when determining groups', async () => {
    const t = '2024-01-01T00:00:00'
    mockedListPageHistory.mockResolvedValueOnce({
      items: [
        makeHistoryEntry({ seq: 5, op_type: 'undo_edit_block', created_at: `${t}.200Z` }),
        makeHistoryEntry({ seq: 4, op_type: 'edit_block', created_at: `${t}.100Z` }),
        makeHistoryEntry({ seq: 3, op_type: 'redo_edit_block', created_at: `${t}.080Z` }),
        makeHistoryEntry({ seq: 2, op_type: 'edit_block', created_at: `${t}.050Z` }),
        makeHistoryEntry({ seq: 1, op_type: 'edit_block', created_at: `${t}.000Z` }),
      ],
      next_cursor: null,
      has_more: false,
    })

    // After filtering: [seq4(100ms), seq2(50ms), seq1(0ms)] — all within 200ms
    mockedUndoPageOp
      .mockResolvedValueOnce(makeUndoResult({ seq: 4, newSeq: 6 }))
      .mockResolvedValueOnce(makeUndoResult({ seq: 2, newSeq: 7 }))
      .mockResolvedValueOnce(makeUndoResult({ seq: 1, newSeq: 8 }))

    await useUndoStore.getState().undo('page1')

    expect(mockedUndoPageOp).toHaveBeenCalledTimes(3)
    expect(useUndoStore.getState().pages.get('page1')?.undoDepth).toBe(3)
  })

  it('records group size in redoGroupSizes', async () => {
    const t = '2024-01-01T00:00:00'
    mockedListPageHistory.mockResolvedValueOnce({
      items: [
        makeHistoryEntry({ seq: 2, created_at: `${t}.050Z` }),
        makeHistoryEntry({ seq: 1, created_at: `${t}.000Z` }),
      ],
      next_cursor: null,
      has_more: false,
    })

    mockedUndoPageOp
      .mockResolvedValueOnce(makeUndoResult({ seq: 2, newSeq: 3 }))
      .mockResolvedValueOnce(makeUndoResult({ seq: 1, newSeq: 4 }))

    await useUndoStore.getState().undo('page1')

    const pageState = useUndoStore.getState().pages.get('page1')
    expect(pageState?.redoGroupSizes).toEqual([2])
  })
})

describe('batch redo', () => {
  beforeEach(() => {
    useUndoStore.setState({ pages: new Map() })
    vi.clearAllMocks()
  })

  it('replays the same group size as the batch undo', async () => {
    // Batch undo of 3 ops
    const t = '2024-01-01T00:00:00'
    mockedListPageHistory.mockResolvedValueOnce({
      items: [
        makeHistoryEntry({ seq: 3, created_at: `${t}.100Z` }),
        makeHistoryEntry({ seq: 2, created_at: `${t}.050Z` }),
        makeHistoryEntry({ seq: 1, created_at: `${t}.000Z` }),
      ],
      next_cursor: null,
      has_more: false,
    })

    mockedUndoPageOp
      .mockResolvedValueOnce(makeUndoResult({ deviceId: 'dev1', seq: 3, newSeq: 4 }))
      .mockResolvedValueOnce(makeUndoResult({ deviceId: 'dev1', seq: 2, newSeq: 5 }))
      .mockResolvedValueOnce(makeUndoResult({ deviceId: 'dev1', seq: 1, newSeq: 6 }))

    await useUndoStore.getState().undo('page1')
    expect(mockedUndoPageOp).toHaveBeenCalledTimes(3)

    // Now redo — should replay all 3
    mockedRedoPageOp
      .mockResolvedValueOnce(makeUndoResult({ isRedo: true, seq: 1 }))
      .mockResolvedValueOnce(makeUndoResult({ isRedo: true, seq: 2 }))
      .mockResolvedValueOnce(makeUndoResult({ isRedo: true, seq: 3 }))

    const result = await useUndoStore.getState().redo('page1')

    expect(result).not.toBeNull()
    expect(mockedRedoPageOp).toHaveBeenCalledTimes(3)

    const pageState = useUndoStore.getState().pages.get('page1')
    expect(pageState?.undoDepth).toBe(0)
    expect(pageState?.redoStack).toHaveLength(0)
    expect(pageState?.redoGroupSizes).toEqual([])
  })

  it('handles mixed group sizes correctly', async () => {
    const t = '2024-01-01T00:00:00'

    // First batch undo: 2 ops
    mockedListPageHistory.mockResolvedValueOnce({
      items: [
        makeHistoryEntry({ seq: 4, created_at: `${t}.050Z` }),
        makeHistoryEntry({ seq: 3, created_at: `${t}.000Z` }),
      ],
      next_cursor: null,
      has_more: false,
    })
    mockedUndoPageOp
      .mockResolvedValueOnce(makeUndoResult({ seq: 4, newSeq: 5 }))
      .mockResolvedValueOnce(makeUndoResult({ seq: 3, newSeq: 6 }))
    await useUndoStore.getState().undo('page1')

    // Second single undo (history fetch fails → group size 1)
    mockedListPageHistory.mockRejectedValueOnce(new Error('fail'))
    mockedUndoPageOp.mockResolvedValueOnce(makeUndoResult({ seq: 2, newSeq: 7 }))
    await useUndoStore.getState().undo('page1')

    const stateAfterUndos = useUndoStore.getState().pages.get('page1')
    expect(stateAfterUndos?.redoGroupSizes).toEqual([2, 1])
    expect(stateAfterUndos?.undoDepth).toBe(3)

    // Redo once — should redo 1 op (the single undo)
    mockedRedoPageOp.mockResolvedValueOnce(makeUndoResult({ isRedo: true }))
    await useUndoStore.getState().redo('page1')

    expect(mockedRedoPageOp).toHaveBeenCalledTimes(1)
    expect(useUndoStore.getState().pages.get('page1')?.undoDepth).toBe(2)
    expect(useUndoStore.getState().pages.get('page1')?.redoGroupSizes).toEqual([2])

    // Redo again — should redo 2 ops (the batch undo)
    mockedRedoPageOp
      .mockResolvedValueOnce(makeUndoResult({ isRedo: true }))
      .mockResolvedValueOnce(makeUndoResult({ isRedo: true }))
    await useUndoStore.getState().redo('page1')

    expect(mockedRedoPageOp).toHaveBeenCalledTimes(3) // 1 + 2
    expect(useUndoStore.getState().pages.get('page1')?.undoDepth).toBe(0)
    expect(useUndoStore.getState().pages.get('page1')?.redoGroupSizes).toEqual([])
  })

  it('defaults to single redo when no group size is recorded', async () => {
    // Manually set up a page with a redo stack but no group sizes
    // (simulates legacy state or edge case)
    useUndoStore.setState({
      pages: new Map([
        [
          'page1',
          {
            redoStack: [{ device_id: 'dev1', seq: 5 }],
            undoDepth: 1,
            redoGroupSizes: [],
          },
        ],
      ]),
    })

    mockedRedoPageOp.mockResolvedValueOnce(makeUndoResult({ isRedo: true, seq: 5 }))

    await useUndoStore.getState().redo('page1')

    expect(mockedRedoPageOp).toHaveBeenCalledTimes(1)
    expect(useUndoStore.getState().pages.get('page1')?.undoDepth).toBe(0)
  })

  it('onNewAction clears redoGroupSizes along with redoStack', async () => {
    const t = '2024-01-01T00:00:00'
    mockedListPageHistory.mockResolvedValueOnce({
      items: [
        makeHistoryEntry({ seq: 2, created_at: `${t}.050Z` }),
        makeHistoryEntry({ seq: 1, created_at: `${t}.000Z` }),
      ],
      next_cursor: null,
      has_more: false,
    })
    mockedUndoPageOp
      .mockResolvedValueOnce(makeUndoResult({ seq: 2, newSeq: 3 }))
      .mockResolvedValueOnce(makeUndoResult({ seq: 1, newSeq: 4 }))

    await useUndoStore.getState().undo('page1')
    expect(useUndoStore.getState().pages.get('page1')?.redoGroupSizes).toEqual([2])

    // New action clears everything
    useUndoStore.getState().onNewAction('page1')

    const pageState = useUndoStore.getState().pages.get('page1')
    expect(pageState?.redoStack).toEqual([])
    expect(pageState?.undoDepth).toBe(0)
    expect(pageState?.redoGroupSizes).toEqual([])
  })
})
