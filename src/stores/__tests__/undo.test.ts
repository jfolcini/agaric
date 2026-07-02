import { beforeEach, describe, expect, it, vi } from 'vitest'

import { isWithinUndoGroup, MAX_REDO_STACK, UNDO_GROUP_WINDOW_MS, useUndoStore } from '../undo'

// #2190 — the undo store now reverts an entire Ctrl+Z group through a SINGLE
// `undoPageGroup` IPC (one IMMEDIATE tx) instead of the old `findUndoGroup` +
// N × `undoPageOp` loop. The mock therefore exposes `undoPageGroup` (returns
// the full `UndoResult[]` for the group, newest-first) and `redoPageOp` (redo
// still replays op-by-op from the recorded group size).
vi.mock('@/lib/tauri', () => ({
  undoPageGroup: vi.fn(),
  redoPageOp: vi.fn(),
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
import { redoPageOp, undoPageGroup } from '@/lib/tauri'

const mockedUndoPageGroup = vi.mocked(undoPageGroup)
const mockedRedoPageOp = vi.mocked(redoPageOp)
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

/**
 * Helper — build a group response (newest-first, as the backend returns). Seqs
 * descend from `newestSeq` so `group[0]` is the newest reverted op.
 */
function makeGroup(newestSeq: number, size: number, deviceId = 'device1') {
  return Array.from({ length: size }, (_, i) =>
    makeUndoResult({ deviceId, seq: newestSeq - i, newSeq: 1000 + i }),
  )
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
  // undo — single IPC per Ctrl+Z (#2190)
  // ---------------------------------------------------------------------------
  describe('undo', () => {
    it('issues ONE undoPageGroup IPC with depth=0 on the first undo', async () => {
      mockedUndoPageGroup.mockResolvedValueOnce([makeUndoResult({ seq: 5, newSeq: 6 })])

      const returned = await useUndoStore.getState().undo('page1')

      expect(mockedUndoPageGroup).toHaveBeenCalledTimes(1)
      expect(mockedUndoPageGroup).toHaveBeenCalledWith({
        pageId: 'page1',
        depth: 0,
        windowMs: UNDO_GROUP_WINDOW_MS,
      })
      // Returns the newest reverted op (group[0]).
      expect(returned).toEqual(makeUndoResult({ seq: 5, newSeq: 6 }))
    })

    it('single-op group: advances depth to 1, pushes one redo entry, records size 1', async () => {
      mockedUndoPageGroup.mockResolvedValueOnce([makeUndoResult({ deviceId: 'dev1', seq: 5 })])

      await useUndoStore.getState().undo('page1')

      const pageState = useUndoStore.getState().pages.get('page1')
      expect(pageState?.undoDepth).toBe(1)
      // The stack carries the undo's `new_op_ref` (the appended reverse op,
      // seq 6) — the ref `redo_page_op` accepts — NOT the forward op (seq 5),
      // which the backend's #659 provenance check rejects.
      expect(pageState?.redoStack).toEqual([{ device_id: 'dev1', seq: 6 }])
      expect(pageState?.redoGroupSizes).toEqual([1])
    })

    it('multi-op group: ONE IPC reverts the whole group and applies the response', async () => {
      // Newest-first group of 3 (seqs 3,2,1).
      const group = makeGroup(3, 3, 'dev1')
      mockedUndoPageGroup.mockResolvedValueOnce(group)

      const returned = await useUndoStore.getState().undo('page1')

      // Exactly one IPC for the whole group.
      expect(mockedUndoPageGroup).toHaveBeenCalledTimes(1)
      // undo() returns the newest reverted op.
      expect(returned).toEqual(group[0])

      const pageState = useUndoStore.getState().pages.get('page1')
      expect(pageState?.undoDepth).toBe(3)
      expect(pageState?.redoStack).toHaveLength(3)
      // Response order is newest-first; each `new_op_ref` (the appended
      // reverse op — the ref redo must reverse, #659) is prepended, so the
      // OLDEST original op's reverse (newSeq 1002) ends up at the FRONT — the
      // order redo pops for a correct oldest-first replay.
      expect(pageState?.redoStack).toEqual([
        { device_id: 'dev1', seq: 1002 },
        { device_id: 'dev1', seq: 1001 },
        { device_id: 'dev1', seq: 1000 },
      ])
      expect(pageState?.redoGroupSizes).toEqual([3])
    })

    it('passes the current undoDepth as `depth` on a second Ctrl+Z', async () => {
      mockedUndoPageGroup.mockResolvedValueOnce([makeUndoResult({ seq: 5 })])
      await useUndoStore.getState().undo('page1')
      expect(useUndoStore.getState().pages.get('page1')?.undoDepth).toBe(1)

      mockedUndoPageGroup.mockResolvedValueOnce([makeUndoResult({ seq: 4 })])
      await useUndoStore.getState().undo('page1')

      expect(mockedUndoPageGroup).toHaveBeenLastCalledWith({
        pageId: 'page1',
        depth: 1,
        windowMs: UNDO_GROUP_WINDOW_MS,
      })
      expect(useUndoStore.getState().pages.get('page1')?.undoDepth).toBe(2)
    })

    it('empty group (nothing to undo) returns null and leaves no redo', async () => {
      mockedUndoPageGroup.mockResolvedValueOnce([])

      const returned = await useUndoStore.getState().undo('page1')

      expect(returned).toBeNull()
      expect(useUndoStore.getState().canRedo('page1')).toBe(false)
      const pageState = useUndoStore.getState().pages.get('page1')
      expect(pageState?.undoDepth).toBe(0)
      expect(pageState?.redoStack).toEqual([])
    })

    it('returns null on backend error, logs it, and warns the user', async () => {
      const err = new Error('undo failed')
      mockedUndoPageGroup.mockRejectedValueOnce(err)

      const returned = await useUndoStore.getState().undo('page1')

      expect(returned).toBeNull()
      expect(mockedLogger.error).toHaveBeenCalledWith(
        'UndoStore',
        'undo_page_group failed',
        { pageId: 'page1' },
        err,
      )
      expect(mockedToastWarning).toHaveBeenCalledTimes(1)
      // No state mutation beyond the pristine optimistic marker.
      const pageState = useUndoStore.getState().pages.get('page1')
      expect(pageState?.undoDepth).toBe(0)
      expect(pageState?.redoStack).toEqual([])
    })

    it('does not corrupt prior state on a later backend error', async () => {
      mockedUndoPageGroup.mockResolvedValueOnce([makeUndoResult({ seq: 5 })])
      await useUndoStore.getState().undo('page1')

      mockedUndoPageGroup.mockRejectedValueOnce(new Error('fail'))
      await useUndoStore.getState().undo('page1')

      const pageState = useUndoStore.getState().pages.get('page1')
      expect(pageState?.undoDepth).toBe(1)
      expect(pageState?.redoStack).toHaveLength(1)
    })

    it('rejects concurrent undo on the same page (re-entrancy guard)', async () => {
      mockedUndoPageGroup.mockResolvedValueOnce([
        makeUndoResult({ deviceId: 'dev1', seq: 5, newSeq: 6 }),
      ])

      const [r1, r2] = await Promise.all([
        useUndoStore.getState().undo('page1'),
        useUndoStore.getState().undo('page1'),
      ])

      expect(r1).not.toBeNull()
      expect(r2).toBeNull()
      expect(useUndoStore.getState().pages.get('page1')?.undoDepth).toBe(1)
      expect(mockedUndoPageGroup).toHaveBeenCalledTimes(1)
    })

    it('clears the re-entrancy guard after completion — next undo works', async () => {
      mockedUndoPageGroup.mockResolvedValueOnce([makeUndoResult({ seq: 5 })])
      await useUndoStore.getState().undo('page1')
      expect(useUndoStore.getState().pages.get('page1')?.undoDepth).toBe(1)

      mockedUndoPageGroup.mockResolvedValueOnce([makeUndoResult({ seq: 4 })])
      await useUndoStore.getState().undo('page1')
      expect(useUndoStore.getState().pages.get('page1')?.undoDepth).toBe(2)
      expect(mockedUndoPageGroup).toHaveBeenCalledTimes(2)
    })

    it('caps redoStack at MAX_REDO_STACK entries even for a large group', async () => {
      const group = makeGroup(1000, MAX_REDO_STACK + 10, 'dev1')
      mockedUndoPageGroup.mockResolvedValueOnce(group)

      await useUndoStore.getState().undo('page1')

      const pageState = useUndoStore.getState().pages.get('page1')
      expect(pageState?.redoStack).toHaveLength(MAX_REDO_STACK)
      // The recorded group size is clamped to what the (capped) stack can back.
      const summed = (pageState?.redoGroupSizes ?? []).reduce((s, n) => s + n, 0)
      expect(summed).toBeLessThanOrEqual(pageState?.redoStack.length ?? 0)
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
      mockedUndoPageGroup.mockResolvedValueOnce([makeUndoResult({ deviceId: 'dev1', seq: 5 })])
      await useUndoStore.getState().undo('page1')

      const redoResult = makeUndoResult({ deviceId: 'dev1', seq: 5, isRedo: true })
      mockedRedoPageOp.mockResolvedValueOnce(redoResult)

      const returned = await useUndoStore.getState().redo('page1')

      // Redo targets the undo's `new_op_ref` (the reverse op, seq 6) — not the
      // original forward op (seq 5), which `redo_page_op` rejects (#659).
      expect(mockedRedoPageOp).toHaveBeenCalledWith({ undoDeviceId: 'dev1', undoSeq: 6 })
      expect(returned).toEqual(redoResult)
    })

    it('decrements undoDepth after successful redo', async () => {
      mockedUndoPageGroup.mockResolvedValueOnce([makeUndoResult({ seq: 5 })])
      await useUndoStore.getState().undo('page1')
      mockedUndoPageGroup.mockResolvedValueOnce([makeUndoResult({ seq: 4 })])
      await useUndoStore.getState().undo('page1')

      expect(useUndoStore.getState().pages.get('page1')?.undoDepth).toBe(2)

      mockedRedoPageOp.mockResolvedValueOnce(makeUndoResult({ isRedo: true }))
      await useUndoStore.getState().redo('page1')

      const pageState = useUndoStore.getState().pages.get('page1')
      expect(pageState?.undoDepth).toBe(1)
      expect(pageState?.redoStack).toHaveLength(1)
    })

    it('returns null on backend error without changing state', async () => {
      mockedUndoPageGroup.mockResolvedValueOnce([makeUndoResult({ deviceId: 'dev1', seq: 5 })])
      await useUndoStore.getState().undo('page1')

      mockedRedoPageOp.mockRejectedValueOnce(new Error('redo failed'))
      const returned = await useUndoStore.getState().redo('page1')

      expect(returned).toBeNull()
      const pageState = useUndoStore.getState().pages.get('page1')
      expect(pageState?.undoDepth).toBe(1)
      expect(pageState?.redoStack).toHaveLength(1)
    })

    it('logs error via logger.error when redo fails', async () => {
      mockedUndoPageGroup.mockResolvedValueOnce([makeUndoResult({ deviceId: 'dev1', seq: 5 })])
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
      mockedUndoPageGroup.mockResolvedValueOnce(makeGroup(5, 2, 'dev1'))
      await useUndoStore.getState().undo('page1')
      expect(useUndoStore.getState().pages.get('page1')?.redoStack).toHaveLength(2)

      // Group size 2 → the redo replays two ops; hold both open across the
      // concurrent calls by resolving them, but the guard blocks the 2nd redo().
      mockedRedoPageOp.mockResolvedValue(makeUndoResult({ isRedo: true }))

      const [r1, r2] = await Promise.all([
        useUndoStore.getState().redo('page1'),
        useUndoStore.getState().redo('page1'),
      ])

      expect(r1).not.toBeNull()
      expect(r2).toBeNull()
    })

    it('replays the whole group size recorded by a batch undo', async () => {
      mockedUndoPageGroup.mockResolvedValueOnce(makeGroup(3, 3, 'dev1'))
      await useUndoStore.getState().undo('page1')
      expect(useUndoStore.getState().pages.get('page1')?.redoGroupSizes).toEqual([3])

      mockedRedoPageOp
        .mockResolvedValueOnce(makeUndoResult({ isRedo: true, seq: 1 }))
        .mockResolvedValueOnce(makeUndoResult({ isRedo: true, seq: 2 }))
        .mockResolvedValueOnce(makeUndoResult({ isRedo: true, seq: 3 }))

      const result = await useUndoStore.getState().redo('page1')

      expect(result).not.toBeNull()
      expect(mockedRedoPageOp).toHaveBeenCalledTimes(3)
      // Redo replays oldest-first, popping each undo's `new_op_ref` (the
      // reverse ops, #659): the oldest original op's reverse was appended LAST
      // (newSeq 1002), so it pops first, then 1001, then 1000.
      expect(mockedRedoPageOp).toHaveBeenNthCalledWith(1, { undoDeviceId: 'dev1', undoSeq: 1002 })
      expect(mockedRedoPageOp).toHaveBeenNthCalledWith(3, { undoDeviceId: 'dev1', undoSeq: 1000 })

      const pageState = useUndoStore.getState().pages.get('page1')
      expect(pageState?.undoDepth).toBe(0)
      expect(pageState?.redoStack).toHaveLength(0)
      expect(pageState?.redoGroupSizes).toEqual([])
    })

    it('handles mixed group sizes correctly', async () => {
      // First batch undo of 2, then a single undo.
      mockedUndoPageGroup.mockResolvedValueOnce(makeGroup(4, 2, 'dev1'))
      await useUndoStore.getState().undo('page1')
      mockedUndoPageGroup.mockResolvedValueOnce([makeUndoResult({ deviceId: 'dev1', seq: 2 })])
      await useUndoStore.getState().undo('page1')

      expect(useUndoStore.getState().pages.get('page1')?.redoGroupSizes).toEqual([2, 1])

      // First redo replays the most-recent group (size 1).
      mockedRedoPageOp.mockResolvedValueOnce(makeUndoResult({ isRedo: true, seq: 2 }))
      await useUndoStore.getState().redo('page1')
      expect(mockedRedoPageOp).toHaveBeenCalledTimes(1)
      expect(useUndoStore.getState().pages.get('page1')?.redoGroupSizes).toEqual([2])

      // Second redo replays the earlier group (size 2).
      mockedRedoPageOp
        .mockResolvedValueOnce(makeUndoResult({ isRedo: true, seq: 3 }))
        .mockResolvedValueOnce(makeUndoResult({ isRedo: true, seq: 4 }))
      await useUndoStore.getState().redo('page1')
      expect(mockedRedoPageOp).toHaveBeenCalledTimes(3)
      expect(useUndoStore.getState().pages.get('page1')?.redoGroupSizes).toEqual([])
    })
  })

  // ---------------------------------------------------------------------------
  // canRedo
  // ---------------------------------------------------------------------------
  describe('canRedo', () => {
    it('returns true after undo', async () => {
      mockedUndoPageGroup.mockResolvedValueOnce([makeUndoResult({ seq: 5 })])
      await useUndoStore.getState().undo('page1')

      expect(useUndoStore.getState().canRedo('page1')).toBe(true)
    })

    it('returns false after undo then redo (stack empty)', async () => {
      mockedUndoPageGroup.mockResolvedValueOnce([makeUndoResult({ seq: 5 })])
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
      mockedUndoPageGroup.mockResolvedValueOnce([makeUndoResult({ seq: 5 })])
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
      mockedUndoPageGroup.mockResolvedValueOnce([makeUndoResult({ seq: 5 })])
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
  // #1677 — undo result for a page cleared mid-flight must be DROPPED, not
  // re-seeded. If clearPage runs during the undoPageGroup await (provider
  // unmounts mid-undo), the success updater must not fabricate a fresh entry
  // and re-grow the pages Map after an explicit clear (#753 memory-growth).
  // ---------------------------------------------------------------------------
  describe('clearPage mid-flight (#1677)', () => {
    it('does not re-seed a page entry when clearPage runs during the undo await', async () => {
      // undoPageGroup stays pending until we resolve it; clearPage fires while
      // it is in flight to simulate the provider unmounting mid-undo.
      let resolveUndo: (r: ReturnType<typeof makeUndoResult>[]) => void = () => {}
      mockedUndoPageGroup.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveUndo = resolve
          }),
      )

      // Kick off the undo; the optimistic marker creates the entry before the
      // await, so it exists mid-flight.
      const undoPromise = useUndoStore.getState().undo('page1')
      await Promise.resolve()
      expect(useUndoStore.getState().pages.has('page1')).toBe(true)

      // Provider unmounts mid-undo → page state cleared.
      useUndoStore.getState().clearPage('page1')
      expect(useUndoStore.getState().pages.has('page1')).toBe(false)

      // Backend resolves — the success updater must NOT recreate the entry.
      resolveUndo([makeUndoResult({ deviceId: 'dev1', seq: 5 })])
      await undoPromise

      expect(useUndoStore.getState().pages.has('page1')).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // #731 — reanchorAfterRemoteOps (undo × sync coherence)
  // ---------------------------------------------------------------------------
  describe('reanchorAfterRemoteOps (#731)', () => {
    it('resets undoDepth and clears redoStack after remote ops land', async () => {
      mockedUndoPageGroup.mockResolvedValueOnce([makeUndoResult({ deviceId: 'dev1', seq: 5 })])
      await useUndoStore.getState().undo('page1')
      mockedUndoPageGroup.mockResolvedValueOnce([makeUndoResult({ deviceId: 'dev1', seq: 4 })])
      await useUndoStore.getState().undo('page1')

      const before = useUndoStore.getState().pages.get('page1')
      expect(before?.undoDepth).toBe(2)
      expect(before?.redoStack).toHaveLength(2)

      useUndoStore.getState().reanchorAfterRemoteOps('page1')

      const after = useUndoStore.getState().pages.get('page1')
      expect(after?.undoDepth).toBe(0)
      expect(after?.redoStack).toEqual([])
      expect(after?.redoGroupSizes).toEqual([])
    })

    it('the next undo after re-anchor addresses depth 0 (not the wrong op)', async () => {
      mockedUndoPageGroup.mockResolvedValueOnce([makeUndoResult({ deviceId: 'dev1', seq: 5 })])
      await useUndoStore.getState().undo('page1') // depth 0 → 1

      useUndoStore.getState().reanchorAfterRemoteOps('page1')

      mockedUndoPageGroup.mockClear()
      mockedUndoPageGroup.mockResolvedValueOnce([makeUndoResult({ deviceId: 'dev2', seq: 99 })])
      await useUndoStore.getState().undo('page1')

      expect(mockedUndoPageGroup).toHaveBeenCalledWith({
        pageId: 'page1',
        depth: 0,
        windowMs: UNDO_GROUP_WINDOW_MS,
      })
    })

    it('is a no-op for a page with no prior undo state', () => {
      useUndoStore.getState().reanchorAfterRemoteOps('untouched-page')
      expect(useUndoStore.getState().pages.has('untouched-page')).toBe(false)
    })

    it('only re-anchors the named page, leaving others intact', async () => {
      mockedUndoPageGroup.mockResolvedValueOnce([makeUndoResult({ deviceId: 'dev1', seq: 5 })])
      await useUndoStore.getState().undo('page1')
      mockedUndoPageGroup.mockResolvedValueOnce([makeUndoResult({ deviceId: 'dev2', seq: 8 })])
      await useUndoStore.getState().undo('page2')

      useUndoStore.getState().reanchorAfterRemoteOps('page1')

      expect(useUndoStore.getState().pages.get('page1')?.undoDepth).toBe(0)
      expect(useUndoStore.getState().pages.get('page1')?.redoStack).toEqual([])
      expect(useUndoStore.getState().pages.get('page2')?.undoDepth).toBe(1)
      expect(useUndoStore.getState().pages.get('page2')?.redoStack).toHaveLength(1)
    })

    // -------------------------------------------------------------------------
    // #1692 / #1561 — reanchor / onNewAction interleaving with an IN-FLIGHT
    // undo. Under the single-IPC design the whole group is applied in ONE `set`
    // after the await, so there is no per-op window in which a reanchor can
    // strand an orphan `redoGroupSizes` entry. These tests pin the post-resolve
    // state across the seam: reanchor resets the live entry, then the batch
    // response is applied cleanly onto the reanchored baseline.
    // -------------------------------------------------------------------------
    describe('#1692 — interleaving with an in-flight undo', () => {
      it('reanchor fired mid-undo: the batch result still applies onto the reanchored entry', async () => {
        let resolveUndo: (r: ReturnType<typeof makeUndoResult>[]) => void = () => {}
        mockedUndoPageGroup.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveUndo = resolve
            }),
        )

        const undoPromise = useUndoStore.getState().undo('page1')
        await Promise.resolve()
        // Optimistic marker exists; depth unchanged until the response lands.
        expect(useUndoStore.getState().pages.get('page1')?.undoDepth).toBe(0)

        // A sync lands remote ops mid-undo → re-anchor resets the live entry.
        useUndoStore.getState().reanchorAfterRemoteOps('page1')
        const midFlight = useUndoStore.getState().pages.get('page1')
        expect(midFlight?.undoDepth).toBe(0)
        expect(midFlight?.redoStack).toEqual([])
        expect(midFlight?.redoGroupSizes).toEqual([])

        // Backend resolves with a single-op group; applied onto the reanchored
        // baseline.
        resolveUndo([makeUndoResult({ deviceId: 'dev1', seq: 5 })])
        await undoPromise

        const after = useUndoStore.getState().pages.get('page1')
        expect(after?.undoDepth).toBe(1)
        expect(after?.redoStack).toHaveLength(1)
        expect(after?.redoGroupSizes).toEqual([1])
      })

      it('onNewAction fired mid-undo behaves like reanchor across the seam', async () => {
        let resolveUndo: (r: ReturnType<typeof makeUndoResult>[]) => void = () => {}
        mockedUndoPageGroup.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveUndo = resolve
            }),
        )

        const undoPromise = useUndoStore.getState().undo('page1')
        await Promise.resolve()

        useUndoStore.getState().onNewAction('page1')
        expect(useUndoStore.getState().pages.get('page1')?.redoStack).toEqual([])

        resolveUndo([makeUndoResult({ deviceId: 'dev1', seq: 5 })])
        await undoPromise

        const after = useUndoStore.getState().pages.get('page1')
        expect(after?.redoStack).toHaveLength(1)
        expect(after?.redoGroupSizes).toEqual([1])
      })

      it('reanchor mid batch-undo keeps the redoGroupSizes invariant (#1561)', async () => {
        // A 3-op group held open; reanchor wipes the live entry before it
        // resolves. The single post-await set then applies all 3 cleanly onto
        // the pristine baseline — no orphan size entry, invariant preserved.
        let resolveUndo: (r: ReturnType<typeof makeUndoResult>[]) => void = () => {}
        mockedUndoPageGroup.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveUndo = resolve
            }),
        )

        const undoPromise = useUndoStore.getState().undo('page1')
        await Promise.resolve()

        useUndoStore.getState().reanchorAfterRemoteOps('page1')
        expect(useUndoStore.getState().pages.get('page1')?.redoStack).toEqual([])

        resolveUndo(makeGroup(3, 3, 'dev1'))
        await undoPromise

        const after = useUndoStore.getState().pages.get('page1')
        expect(after?.redoStack).toHaveLength(3)
        const summed = (after?.redoGroupSizes ?? []).reduce((s, n) => s + n, 0)
        expect(summed).toBeLessThanOrEqual(after?.redoStack.length ?? 0)
        expect(after?.redoGroupSizes).toEqual([3])

        // Redo replays exactly the recorded group with no stranded entry.
        mockedRedoPageOp.mockResolvedValue(makeUndoResult({ isRedo: true }))
        const redone = await useUndoStore.getState().redo('page1')
        expect(redone).not.toBeNull()
        expect(mockedRedoPageOp).toHaveBeenCalledTimes(3)

        const settled = useUndoStore.getState().pages.get('page1')
        expect(settled?.redoStack).toEqual([])
        expect(settled?.redoGroupSizes).toEqual([])
      })
    })
  })

  // ---------------------------------------------------------------------------
  // multiple pages tracked independently
  // ---------------------------------------------------------------------------
  describe('multiple pages', () => {
    it('tracks undo state for different pages independently', async () => {
      mockedUndoPageGroup.mockResolvedValueOnce([makeUndoResult({ deviceId: 'dev1', seq: 1 })])
      await useUndoStore.getState().undo('page1')

      mockedUndoPageGroup.mockResolvedValueOnce([makeUndoResult({ deviceId: 'dev2', seq: 10 })])
      await useUndoStore.getState().undo('page2')
      mockedUndoPageGroup.mockResolvedValueOnce([makeUndoResult({ deviceId: 'dev2', seq: 9 })])
      await useUndoStore.getState().undo('page2')

      const page1State = useUndoStore.getState().pages.get('page1')
      const page2State = useUndoStore.getState().pages.get('page2')

      expect(page1State?.undoDepth).toBe(1)
      expect(page1State?.redoStack).toHaveLength(1)
      expect(page2State?.undoDepth).toBe(2)
      expect(page2State?.redoStack).toHaveLength(2)
    })

    it('onNewAction on page1 does not affect page2', async () => {
      mockedUndoPageGroup.mockResolvedValueOnce([makeUndoResult({ seq: 1 })])
      await useUndoStore.getState().undo('page1')
      mockedUndoPageGroup.mockResolvedValueOnce([makeUndoResult({ seq: 10 })])
      await useUndoStore.getState().undo('page2')

      useUndoStore.getState().onNewAction('page1')

      expect(useUndoStore.getState().pages.get('page1')?.redoStack).toEqual([])
      expect(useUndoStore.getState().pages.get('page2')?.redoStack).toHaveLength(1)
    })

    it('clearPage on page1 does not affect page2', async () => {
      mockedUndoPageGroup.mockResolvedValueOnce([makeUndoResult({ seq: 1 })])
      await useUndoStore.getState().undo('page1')
      mockedUndoPageGroup.mockResolvedValueOnce([makeUndoResult({ seq: 10 })])
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
    expect(isWithinUndoGroup('2024-01-01T00:00:00.100Z', '2024-01-01T00:00:00.000Z')).toBe(true)
  })

  it('uses UNDO_GROUP_WINDOW_MS constant (500ms)', () => {
    expect(UNDO_GROUP_WINDOW_MS).toBe(500)
  })
})
