import { beforeEach, describe, expect, it, vi } from 'vitest'

import { isWithinUndoGroup, MAX_REDO_STACK, UNDO_GROUP_WINDOW_MS, useUndoStore } from '../undo'

vi.mock('@/lib/tauri', () => ({
  undoPageOp: vi.fn(),
  redoPageOp: vi.fn(),
  // PEND-35 Tier 4.4 — replaces the prior `listPageHistory`-based
  // grouping mock with a single-IPC `findUndoGroup` mock. The deprecated
  // mock is left as a `vi.fn()` so the regression assertions below can
  // verify the legacy IPC is no longer fired under the new undo path.
  findUndoGroup: vi.fn(),
  listPageHistory: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import { toast } from 'sonner'

import { logger } from '@/lib/logger'
import { findUndoGroup, listPageHistory, redoPageOp, undoPageOp } from '@/lib/tauri'

const mockedUndoPageOp = vi.mocked(undoPageOp)
const mockedRedoPageOp = vi.mocked(redoPageOp)
const mockedFindUndoGroup = vi.mocked(findUndoGroup)
const mockedListPageHistory = vi.mocked(listPageHistory)
const mockedLogger = vi.mocked(logger)
const mockedToastWarning = vi.mocked(toast.warning)

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
    reversed_op_type: 'edit_block',
    is_redo: overrides.isRedo ?? false,
  }
}

describe('useUndoStore', () => {
  beforeEach(() => {
    useUndoStore.setState({ pages: new Map() })
    vi.clearAllMocks()
    // PEND-35 Tier 4.4 — default `findUndoGroup` to 1 (no batch
    // extension) for tests that exercise the single-undo path. Tests
    // that exercise batch behaviour override this with a higher value.
    mockedFindUndoGroup.mockResolvedValue(1)
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

    it('logs error via logger.error when undo fails', async () => {
      const err = new Error('no undoable ops')
      mockedUndoPageOp.mockRejectedValueOnce(err)

      await useUndoStore.getState().undo('page1')

      expect(mockedLogger.error).toHaveBeenCalledWith(
        'UndoStore',
        'undo operation failed',
        { pageId: 'page1' },
        err,
      )
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

    it('rejects concurrent undo on the same page (re-entrancy guard)', async () => {
      // Set up one mock response (only the first undo executes)
      const result1 = makeUndoResult({ deviceId: 'dev1', seq: 5, newSeq: 6 })
      mockedUndoPageOp.mockResolvedValueOnce(result1)

      // Fire two undos simultaneously
      const [r1, r2] = await Promise.all([
        useUndoStore.getState().undo('page1'),
        useUndoStore.getState().undo('page1'),
      ])

      // First succeeds, second is rejected by re-entrancy guard
      expect(r1).not.toBeNull()
      expect(r2).toBeNull()

      // undoDepth should be 1 (only one undo executed)
      const state = useUndoStore.getState().pages.get('page1')
      expect(state?.undoDepth).toBe(1)

      // Backend should have been called once
      expect(mockedUndoPageOp).toHaveBeenCalledTimes(1)
      expect(mockedUndoPageOp).toHaveBeenCalledWith({ pageId: 'page1', undoDepth: 0 })
    })

    it('clears undo re-entrancy guard after completion — next undo works', async () => {
      // First undo
      mockedUndoPageOp.mockResolvedValueOnce(makeUndoResult({ seq: 5 }))
      await useUndoStore.getState().undo('page1')
      expect(useUndoStore.getState().pages.get('page1')?.undoDepth).toBe(1)

      // Second undo (sequential) — should work because guard is cleared
      mockedUndoPageOp.mockResolvedValueOnce(makeUndoResult({ seq: 4 }))
      await useUndoStore.getState().undo('page1')
      expect(useUndoStore.getState().pages.get('page1')?.undoDepth).toBe(2)
      expect(mockedUndoPageOp).toHaveBeenCalledTimes(2)
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

    it('logs error via logger.error when redo fails', async () => {
      mockedUndoPageOp.mockResolvedValueOnce(makeUndoResult({ deviceId: 'dev1', seq: 5 }))
      await useUndoStore.getState().undo('page1')

      const err = new Error('redo failed')
      mockedRedoPageOp.mockRejectedValueOnce(err)
      await useUndoStore.getState().redo('page1')

      expect(mockedLogger.error).toHaveBeenCalledWith(
        'UndoStore',
        'redo operation failed',
        { pageId: 'page1' },
        err,
      )
    })

    it('rejects concurrent redo on the same page (re-entrancy guard)', async () => {
      // Set up: undo twice to populate redo stack
      mockedUndoPageOp.mockResolvedValueOnce(makeUndoResult({ deviceId: 'dev1', seq: 5 }))
      await useUndoStore.getState().undo('page1')
      mockedUndoPageOp.mockResolvedValueOnce(makeUndoResult({ deviceId: 'dev1', seq: 4 }))
      await useUndoStore.getState().undo('page1')

      expect(useUndoStore.getState().pages.get('page1')?.redoStack).toHaveLength(2)

      // Set up one redo mock (only first redo executes)
      mockedRedoPageOp.mockResolvedValueOnce(makeUndoResult({ isRedo: true }))

      // Fire two redos simultaneously
      const [r1, r2] = await Promise.all([
        useUndoStore.getState().redo('page1'),
        useUndoStore.getState().redo('page1'),
      ])

      // First succeeds, second is rejected by re-entrancy guard
      expect(r1).not.toBeNull()
      expect(r2).toBeNull()

      // Only one redo executed
      expect(mockedRedoPageOp).toHaveBeenCalledTimes(1)
    })

    it('clears redo re-entrancy guard after completion — next redo works', async () => {
      // Set up: undo twice to populate redo stack
      mockedUndoPageOp.mockResolvedValueOnce(makeUndoResult({ deviceId: 'dev1', seq: 5 }))
      await useUndoStore.getState().undo('page1')
      mockedUndoPageOp.mockResolvedValueOnce(makeUndoResult({ deviceId: 'dev1', seq: 4 }))
      await useUndoStore.getState().undo('page1')

      // First redo
      mockedRedoPageOp.mockResolvedValueOnce(makeUndoResult({ isRedo: true }))
      await useUndoStore.getState().redo('page1')

      // Second redo (sequential) — should work because guard is cleared
      mockedRedoPageOp.mockResolvedValueOnce(makeUndoResult({ isRedo: true }))
      await useUndoStore.getState().redo('page1')

      expect(mockedRedoPageOp).toHaveBeenCalledTimes(2)
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
  // #731 — reanchorAfterRemoteOps (undo × sync coherence)
  // ---------------------------------------------------------------------------
  describe('reanchorAfterRemoteOps (#731)', () => {
    it('resets undoDepth and clears redoStack after remote ops land', async () => {
      // User performs two undos: the backend op-log is now addressed at
      // depth 2 and the redo stack holds two reversed-op refs.
      mockedUndoPageOp.mockResolvedValueOnce(makeUndoResult({ deviceId: 'dev1', seq: 5 }))
      await useUndoStore.getState().undo('page1')
      mockedUndoPageOp.mockResolvedValueOnce(makeUndoResult({ deviceId: 'dev1', seq: 4 }))
      await useUndoStore.getState().undo('page1')

      const before = useUndoStore.getState().pages.get('page1')
      expect(before?.undoDepth).toBe(2)
      expect(before?.redoStack).toHaveLength(2)

      // A sync applies remote ops to this page → re-anchor the positional
      // undo state so the next undo re-reads the newest op (depth 0) rather
      // than reversing the wrong op at the now-shifted depth 2.
      useUndoStore.getState().reanchorAfterRemoteOps('page1')

      const after = useUndoStore.getState().pages.get('page1')
      expect(after?.undoDepth).toBe(0)
      expect(after?.redoStack).toEqual([])
      expect(after?.redoGroupSizes).toEqual([])
    })

    it('the next undo after re-anchor addresses depth 0 (not the wrong op)', async () => {
      // Reproduces the #731 wrong-op-reversed scenario at the store level:
      // a remote op landing between two Ctrl+Z presses must not let the
      // second undo address a shifted positional depth.
      mockedUndoPageOp.mockResolvedValueOnce(makeUndoResult({ deviceId: 'dev1', seq: 5 }))
      await useUndoStore.getState().undo('page1') // depth 0 → 1

      // Sync applies a remote op + reloads the page → re-anchor.
      useUndoStore.getState().reanchorAfterRemoteOps('page1')

      // Next Ctrl+Z must hit depth 0 (the newest op, now the remote one's
      // predecessor in the re-read log) — NOT depth 1, which would reverse
      // a different op than the user intends.
      mockedUndoPageOp.mockClear()
      mockedUndoPageOp.mockResolvedValueOnce(makeUndoResult({ deviceId: 'dev2', seq: 99 }))
      await useUndoStore.getState().undo('page1')

      expect(mockedUndoPageOp).toHaveBeenCalledWith({ pageId: 'page1', undoDepth: 0 })
    })

    it('is a no-op for a page with no prior undo state', () => {
      useUndoStore.getState().reanchorAfterRemoteOps('untouched-page')
      // No entry created — nothing to re-anchor, so the Map stays clean.
      expect(useUndoStore.getState().pages.has('untouched-page')).toBe(false)
    })

    it('only re-anchors the named page, leaving others intact', async () => {
      mockedUndoPageOp.mockResolvedValueOnce(makeUndoResult({ deviceId: 'dev1', seq: 5 }))
      await useUndoStore.getState().undo('page1')
      mockedUndoPageOp.mockResolvedValueOnce(makeUndoResult({ deviceId: 'dev2', seq: 8 }))
      await useUndoStore.getState().undo('page2')

      useUndoStore.getState().reanchorAfterRemoteOps('page1')

      expect(useUndoStore.getState().pages.get('page1')?.undoDepth).toBe(0)
      expect(useUndoStore.getState().pages.get('page1')?.redoStack).toEqual([])
      // page2 had no remote ops — its undo anchor must survive.
      expect(useUndoStore.getState().pages.get('page2')?.undoDepth).toBe(1)
      expect(useUndoStore.getState().pages.get('page2')?.redoStack).toHaveLength(1)
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

  it('returns false for timestamps 800ms apart', () => {
    expect(isWithinUndoGroup('2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.800Z')).toBe(false)
  })

  it('returns true for timestamps exactly at the boundary (500ms)', () => {
    expect(isWithinUndoGroup('2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.500Z')).toBe(true)
  })

  it('returns false for timestamps 501ms apart', () => {
    expect(isWithinUndoGroup('2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.501Z')).toBe(false)
  })

  it('returns false when either timestamp is invalid', () => {
    expect(isWithinUndoGroup('not-a-date', '2024-01-01T00:00:00.000Z')).toBe(false)
    expect(isWithinUndoGroup('2024-01-01T00:00:00.000Z', 'also-invalid')).toBe(false)
  })

  it('is order-independent (uses absolute difference)', () => {
    // Reversed order should give the same result
    expect(isWithinUndoGroup('2024-01-01T00:00:00.100Z', '2024-01-01T00:00:00.000Z')).toBe(true)
  })

  it('uses UNDO_GROUP_WINDOW_MS constant (500ms)', () => {
    expect(UNDO_GROUP_WINDOW_MS).toBe(500)
  })
})

// ---------------------------------------------------------------------------
// Batch undo / redo
// ---------------------------------------------------------------------------

// PEND-35 Tier 4.4 — batch undo/redo previously re-fetched
// `listPageHistory` with a growing window after every Ctrl+Z to
// determine the group size. The new path delegates that decision to a
// single `findUndoGroup` IPC. These tests assert ONE `findUndoGroup`
// call per Ctrl+Z (was: one `listPageHistory` call with growing
// limit), and `listPageHistory` is NOT called under the undo path
// (regression assertion below).

describe('batch undo', () => {
  beforeEach(() => {
    useUndoStore.setState({ pages: new Map() })
    vi.clearAllMocks()
    // Default: single undo (no batch) — individual tests override.
    mockedFindUndoGroup.mockResolvedValue(1)
  })

  it('groups consecutive ops when findUndoGroup returns N', async () => {
    mockedFindUndoGroup.mockReset()
    mockedFindUndoGroup.mockResolvedValueOnce(3)

    mockedUndoPageOp
      .mockResolvedValueOnce(makeUndoResult({ seq: 3, newSeq: 4 }))
      .mockResolvedValueOnce(makeUndoResult({ seq: 2, newSeq: 5 }))
      .mockResolvedValueOnce(makeUndoResult({ seq: 1, newSeq: 6 }))

    const result = await useUndoStore.getState().undo('page1')

    expect(result).not.toBeNull()
    // Exactly ONE findUndoGroup IPC fires per Ctrl+Z (replaces the
    // previous growing-window listPageHistory loop).
    expect(mockedFindUndoGroup).toHaveBeenCalledTimes(1)
    expect(mockedFindUndoGroup).toHaveBeenCalledWith({
      pageId: 'page1',
      depth: 0,
      windowMs: UNDO_GROUP_WINDOW_MS,
    })
    expect(mockedUndoPageOp).toHaveBeenCalledTimes(3)

    const pageState = useUndoStore.getState().pages.get('page1')
    expect(pageState?.undoDepth).toBe(3)
    expect(pageState?.redoStack).toHaveLength(3)
  })

  it('does NOT call listPageHistory under the new undo path', async () => {
    mockedFindUndoGroup.mockResolvedValueOnce(2)
    mockedUndoPageOp
      .mockResolvedValueOnce(makeUndoResult({ seq: 2, newSeq: 3 }))
      .mockResolvedValueOnce(makeUndoResult({ seq: 1, newSeq: 4 }))

    await useUndoStore.getState().undo('page1')

    // Regression: the legacy listPageHistory growing-window fetch must
    // not fire under the new path.
    expect(mockedListPageHistory).not.toHaveBeenCalled()
  })

  it('stops at group boundary (findUndoGroup returns 1 for >500ms gap)', async () => {
    // Backend has the gap detection logic; FE just trusts the count.
    mockedFindUndoGroup.mockResolvedValueOnce(1)
    mockedUndoPageOp.mockResolvedValueOnce(makeUndoResult({ seq: 3, newSeq: 4 }))

    await useUndoStore.getState().undo('page1')

    expect(mockedUndoPageOp).toHaveBeenCalledTimes(1)
    expect(useUndoStore.getState().pages.get('page1')?.undoDepth).toBe(1)
  })

  it('stops when findUndoGroup returns 1 (device_id change)', async () => {
    mockedFindUndoGroup.mockResolvedValueOnce(1)
    mockedUndoPageOp.mockResolvedValueOnce(makeUndoResult({ seq: 2, newSeq: 3 }))

    await useUndoStore.getState().undo('page1')

    expect(mockedUndoPageOp).toHaveBeenCalledTimes(1)
  })

  it('falls back to single undo when findUndoGroup rejects', async () => {
    mockedFindUndoGroup.mockReset()
    mockedFindUndoGroup.mockRejectedValueOnce(new Error('network error'))
    mockedUndoPageOp.mockResolvedValueOnce(makeUndoResult({ seq: 5, newSeq: 6 }))

    const result = await useUndoStore.getState().undo('page1')

    expect(result).not.toBeNull()
    expect(mockedUndoPageOp).toHaveBeenCalledTimes(1)
    expect(useUndoStore.getState().pages.get('page1')?.undoDepth).toBe(1)
  })

  it('logs error via logger.error when find_undo_group fails', async () => {
    const err = new Error('network error')
    mockedFindUndoGroup.mockReset()
    mockedFindUndoGroup.mockRejectedValueOnce(err)
    mockedUndoPageOp.mockResolvedValueOnce(makeUndoResult({ seq: 5, newSeq: 6 }))

    await useUndoStore.getState().undo('page1')

    expect(mockedLogger.error).toHaveBeenCalledWith(
      'UndoStore',
      'find_undo_group failed',
      { pageId: 'page1' },
      err,
    )
  })

  it('shows toast warning when findUndoGroup fails (single undo still succeeds)', async () => {
    mockedFindUndoGroup.mockReset()
    mockedFindUndoGroup.mockRejectedValueOnce(new Error('IPC failed'))
    const firstUndo = makeUndoResult({ seq: 5, newSeq: 6 })
    mockedUndoPageOp.mockResolvedValueOnce(firstUndo)

    const result = await useUndoStore.getState().undo('page1')

    // Single undo still succeeds — no regression in core behavior
    expect(result).toEqual(firstUndo)
    expect(mockedUndoPageOp).toHaveBeenCalledTimes(1)
    expect(useUndoStore.getState().pages.get('page1')?.undoDepth).toBe(1)

    // User gets a warning that batch undo was unavailable
    expect(mockedToastWarning).toHaveBeenCalledTimes(1)
    expect(mockedToastWarning).toHaveBeenCalledWith(
      expect.stringContaining('Batch undo unavailable'),
    )
  })

  it('handles backend group size of 0 (seed op missing) by falling back to single undo', async () => {
    // Backend returns 0 when depth exceeds the page's undoable-op
    // count — FE treats it as "no batch extension" and just runs a
    // single undo. (The undoPageOp call itself will surface the
    // missing-op error if the seed truly doesn't exist.)
    mockedFindUndoGroup.mockReset()
    mockedFindUndoGroup.mockResolvedValueOnce(0)
    mockedUndoPageOp.mockResolvedValueOnce(makeUndoResult({ seq: 1, newSeq: 2 }))

    await useUndoStore.getState().undo('page1')

    expect(mockedUndoPageOp).toHaveBeenCalledTimes(1)
  })

  it('records group size in redoGroupSizes', async () => {
    mockedFindUndoGroup.mockReset()
    mockedFindUndoGroup.mockResolvedValueOnce(2)
    mockedUndoPageOp
      .mockResolvedValueOnce(makeUndoResult({ seq: 2, newSeq: 3 }))
      .mockResolvedValueOnce(makeUndoResult({ seq: 1, newSeq: 4 }))

    await useUndoStore.getState().undo('page1')

    const pageState = useUndoStore.getState().pages.get('page1')
    expect(pageState?.redoGroupSizes).toEqual([2])
  })

  it('passes the current undoDepth as `depth` to findUndoGroup on a second Ctrl+Z', async () => {
    // First Ctrl+Z (groupSize=1)
    mockedFindUndoGroup.mockResolvedValueOnce(1)
    mockedUndoPageOp.mockResolvedValueOnce(makeUndoResult({ seq: 2, newSeq: 3 }))
    await useUndoStore.getState().undo('page1')

    expect(useUndoStore.getState().pages.get('page1')?.undoDepth).toBe(1)

    // Second Ctrl+Z — depth should be 1 now.
    mockedFindUndoGroup.mockResolvedValueOnce(1)
    mockedUndoPageOp.mockResolvedValueOnce(makeUndoResult({ seq: 1, newSeq: 4 }))
    await useUndoStore.getState().undo('page1')

    expect(mockedFindUndoGroup).toHaveBeenLastCalledWith({
      pageId: 'page1',
      depth: 1,
      windowMs: UNDO_GROUP_WINDOW_MS,
    })
  })
})

describe('batch redo', () => {
  beforeEach(() => {
    useUndoStore.setState({ pages: new Map() })
    vi.clearAllMocks()
    mockedFindUndoGroup.mockResolvedValue(1)
  })

  it('replays the same group size as the batch undo', async () => {
    // Batch undo of 3 ops — backend returns 3 from findUndoGroup.
    mockedFindUndoGroup.mockReset()
    mockedFindUndoGroup.mockResolvedValueOnce(3)

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
    // First batch undo: 2 ops
    mockedFindUndoGroup.mockReset()
    mockedFindUndoGroup.mockResolvedValueOnce(2)
    mockedUndoPageOp
      .mockResolvedValueOnce(makeUndoResult({ seq: 4, newSeq: 5 }))
      .mockResolvedValueOnce(makeUndoResult({ seq: 3, newSeq: 6 }))
    await useUndoStore.getState().undo('page1')

    // Second single undo (findUndoGroup returns 1)
    mockedFindUndoGroup.mockResolvedValueOnce(1)
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
    mockedFindUndoGroup.mockReset()
    mockedFindUndoGroup.mockResolvedValueOnce(2)
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
