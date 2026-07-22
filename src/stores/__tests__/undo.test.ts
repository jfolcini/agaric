import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  isWithinUndoGroup,
  MAX_REDO_STACK,
  UNDO_GROUP_WINDOW_MS,
  useUndoStore,
} from '@/stores/undo'

// #2190 — the undo store reverts an entire Ctrl+Z group through a SINGLE
// `undoPageGroup` IPC (one IMMEDIATE tx) instead of the old `findUndoGroup` +
// N × `undoPageOp` loop. #2468 — entries whose refs were captured at
// `onNewAction` time are reverted by exact ref instead (`undoOp` for a single
// op, ONE atomic `undoOps` for a coalesced group); `undoPageGroup` remains
// the positional fallback for ref-less entries and pre-tracking history.
// #2901 — `listPageHistory` / `undoPageOp` (singular, positional-by-depth)
// back `undoDeleteOf`, moved in from SortableBlock's old `undoSwipeDelete`.
vi.mock('@/lib/tauri', () => ({
  undoPageGroup: vi.fn(),
  undoOp: vi.fn(),
  undoOps: vi.fn(),
  redoPageOp: vi.fn(),
  listPageHistory: vi.fn(),
  undoPageOp: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

// #2901 — `announce` touches a singleton DOM node; mock it so store tests stay
// DOM-side-effect-free (matches the `vi.mock('@/lib/announcer', ...)`
// convention used throughout the component test suites).
vi.mock('@/lib/announcer', () => ({
  announce: vi.fn(),
}))

import { toast } from 'sonner'

import { announce } from '@/lib/announcer'
import { logger } from '@/lib/logger'
import type { HistoryEntry, PageResponse } from '@/lib/tauri'
import {
  listPageHistory,
  redoPageOp,
  undoOp,
  undoOps,
  undoPageGroup,
  undoPageOp,
} from '@/lib/tauri'

const mockedUndoPageGroup = vi.mocked(undoPageGroup)
const mockedUndoOp = vi.mocked(undoOp)
const mockedUndoOps = vi.mocked(undoOps)
const mockedRedoPageOp = vi.mocked(redoPageOp)
const mockedListPageHistory = vi.mocked(listPageHistory)
const mockedUndoPageOp = vi.mocked(undoPageOp)
const mockedAnnounce = vi.mocked(announce)
const mockedLogger = vi.mocked(logger)
const mockedToastWarning = vi.mocked(toast.warning)
const mockedToastError = vi.mocked(toast.error)
const mockedToastDefault = vi.mocked(toast)

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

    it('partial redo keeps a residual group-size entry for the ops still pending (#2276)', async () => {
      // Batch-undo a group of 3 → redoStack length 3, redoGroupSizes [3].
      mockedUndoPageGroup.mockResolvedValueOnce(makeGroup(3, 3, 'dev1'))
      await useUndoStore.getState().undo('page1')
      expect(useUndoStore.getState().pages.get('page1')?.redoStack).toHaveLength(3)
      expect(useUndoStore.getState().pages.get('page1')?.redoGroupSizes).toEqual([3])

      // First op redoes; the second fails mid-group so the loop breaks. The
      // failed op is rolled back onto the stack, so 2 group ops remain pending.
      mockedRedoPageOp
        .mockResolvedValueOnce(makeUndoResult({ isRedo: true }))
        .mockRejectedValueOnce(new Error('redo failed'))

      await useUndoStore.getState().redo('page1')

      expect(mockedRedoPageOp).toHaveBeenCalledTimes(2)
      const pageState = useUndoStore.getState().pages.get('page1')
      // Only the one successful op left the stack; the other two remain.
      expect(pageState?.redoStack).toHaveLength(2)
      // The group-size entry is trimmed to the residual (2), NOT dropped whole
      // — so the invariant sum(redoGroupSizes) <= redoStack.length holds and a
      // later redo replays exactly the ops still pending.
      expect(pageState?.redoGroupSizes).toEqual([2])
      const summed = (pageState?.redoGroupSizes ?? []).reduce((s, n) => s + n, 0)
      expect(summed).toBeLessThanOrEqual(pageState?.redoStack.length ?? 0)
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

  // ---------------------------------------------------------------------------
  // #2468 — ref-addressed undo: refs captured from the mutation response at
  // `onNewAction` time are the undo targets; `undoOp` / `undoOps` submit the
  // EXACT captured refs (killing the #2446 positional race), and the
  // positional `undoPageGroup` path survives only as the documented fallback
  // for ref-less entries (batch commands) and pre-tracking history.
  // ---------------------------------------------------------------------------
  describe('#2468 — ref-addressed undo', () => {
    const ref = (seq: number, deviceId = 'dev1') => ({ device_id: deviceId, seq })

    describe('capture (onNewAction with op_refs)', () => {
      it('pushes a ref entry onto the undo stack and clears redo state', () => {
        useUndoStore.getState().onNewAction('page1', [ref(5)])

        const pageState = useUndoStore.getState().pages.get('page1')
        expect(pageState?.undoStack).toHaveLength(1)
        expect(pageState?.undoStack[0]?.refs).toEqual([ref(5)])
        expect(pageState?.redoStack).toEqual([])
        expect(pageState?.undoDepth).toBe(0)
        expect(pageState?.redoGroupSizes).toEqual([])
      })

      it('a ref-less onNewAction pushes a positional-fallback entry (refs: null)', () => {
        useUndoStore.getState().onNewAction('page1')

        const pageState = useUndoStore.getState().pages.get('page1')
        expect(pageState?.undoStack).toHaveLength(1)
        expect(pageState?.undoStack[0]?.refs).toBeNull()
      })

      it('an EMPTY op_refs array (idempotent no-op) pushes nothing and preserves redo state', async () => {
        // Seed redo state via an undo first.
        mockedUndoPageGroup.mockResolvedValueOnce([makeUndoResult({ deviceId: 'dev1', seq: 5 })])
        await useUndoStore.getState().undo('page1')
        expect(useUndoStore.getState().canRedo('page1')).toBe(true)

        // e.g. add_tag on an already-tagged block: the backend appended NO op
        // (`op_refs: []`) — nothing to undo, and the redo history of an
        // action that changed nothing must survive.
        useUndoStore.getState().onNewAction('page1', [])

        const pageState = useUndoStore.getState().pages.get('page1')
        expect(pageState?.undoStack).toEqual([])
        expect(pageState?.redoStack).toHaveLength(1)
        expect(pageState?.undoDepth).toBe(1)
        expect(pageState?.redoGroupSizes).toEqual([1])
      })
    })

    describe('#2600 — coalesceKey session grouping (block-level undo for debounced commits)', () => {
      it('same coalesceKey merges into ONE entry even long past the timed window', () => {
        vi.useFakeTimers()
        try {
          vi.setSystemTime(1_000_000)
          useUndoStore.getState().onNewAction('page1', [ref(1)], 'edit:A')
          // Ten windows later — a keyless action would start a NEW entry, but a
          // block's next debounced commit must still fold into the same undo.
          vi.setSystemTime(1_000_000 + UNDO_GROUP_WINDOW_MS * 10)
          useUndoStore.getState().onNewAction('page1', [ref(2)], 'edit:A')

          const stack = useUndoStore.getState().pages.get('page1')?.undoStack
          expect(stack).toHaveLength(1)
          expect(stack?.[0]?.refs).toEqual([ref(1), ref(2)])
          expect(stack?.[0]?.coalesceKey).toBe('edit:A')
        } finally {
          vi.useRealTimers()
        }
      })

      it('a DIFFERENT coalesceKey (another block) does NOT merge across the window gap', () => {
        vi.useFakeTimers()
        try {
          vi.setSystemTime(2_000_000)
          useUndoStore.getState().onNewAction('page1', [ref(1)], 'edit:A')
          // Past the timed window: `edit:A` would still fold in by key, but a
          // different block's commit must start its own undo entry.
          vi.setSystemTime(2_000_000 + UNDO_GROUP_WINDOW_MS + 1)
          useUndoStore.getState().onNewAction('page1', [ref(2)], 'edit:B')

          const stack = useUndoStore.getState().pages.get('page1')?.undoStack
          expect(stack).toHaveLength(2)
          expect(stack?.[0]?.refs).toEqual([ref(2)])
          expect(stack?.[1]?.refs).toEqual([ref(1)])
        } finally {
          vi.useRealTimers()
        }
      })

      it('within the timed window, coalescing stays key-agnostic (legacy #2468 burst grouping preserved)', () => {
        vi.useFakeTimers()
        try {
          vi.setSystemTime(2_500_000)
          useUndoStore.getState().onNewAction('page1', [ref(1)], 'edit:A')
          // Two DIFFERENT keys inside the 500ms window still merge — the change
          // only EXTENDS grouping for same-key sessions, never narrows the
          // existing burst window.
          vi.setSystemTime(2_500_000 + 10)
          useUndoStore.getState().onNewAction('page1', [ref(2)], 'edit:B')

          expect(useUndoStore.getState().pages.get('page1')?.undoStack).toHaveLength(1)
        } finally {
          vi.useRealTimers()
        }
      })

      it('a keyless action still coalesces ONLY within the timed window (unchanged #2468 behavior)', () => {
        vi.useFakeTimers()
        try {
          vi.setSystemTime(3_000_000)
          useUndoStore.getState().onNewAction('page1', [ref(1)])
          vi.setSystemTime(3_000_000 + UNDO_GROUP_WINDOW_MS + 1)
          useUndoStore.getState().onNewAction('page1', [ref(2)])

          expect(useUndoStore.getState().pages.get('page1')?.undoStack).toHaveLength(2)
        } finally {
          vi.useRealTimers()
        }
      })

      it('a coalesced same-key session reverts as ONE atomic undoOps (newest-first)', async () => {
        vi.useFakeTimers()
        try {
          vi.setSystemTime(4_000_000)
          useUndoStore.getState().onNewAction('page1', [ref(1)], 'edit:A')
          vi.setSystemTime(4_000_000 + UNDO_GROUP_WINDOW_MS * 5)
          useUndoStore.getState().onNewAction('page1', [ref(2)], 'edit:A')
        } finally {
          vi.useRealTimers()
        }

        mockedUndoOps.mockResolvedValueOnce([
          makeUndoResult({ deviceId: 'dev1', seq: 2 }),
          makeUndoResult({ deviceId: 'dev1', seq: 1 }),
        ])
        await useUndoStore.getState().undo('page1')

        expect(mockedUndoOps).toHaveBeenCalledTimes(1)
        expect(mockedUndoOps).toHaveBeenCalledWith({ ops: [ref(2), ref(1)] })
        expect(mockedUndoOp).not.toHaveBeenCalled()
        expect(useUndoStore.getState().pages.get('page1')?.undoStack).toEqual([])
      })
    })

    describe('undo submits the CAPTURED ref (#2446 race)', () => {
      it('uses undoOp with the exact captured ref even when newer ops landed in between', async () => {
        useUndoStore.getState().onNewAction('page1', [ref(5)])

        // A newer op (seq 6+) lands in the backend op log WITHOUT a local
        // notification (a sync flush, another pane's debounced edit) — a
        // positional depth-0 undo would now target the WRONG op. Ref
        // addressing is immune: nothing in the store shifts, and undo
        // submits exactly the ref captured at action time.
        mockedUndoOp.mockResolvedValueOnce(
          makeUndoResult({ deviceId: 'dev1', seq: 5, newSeq: 100 }),
        )

        const returned = await useUndoStore.getState().undo('page1')

        expect(mockedUndoOp).toHaveBeenCalledTimes(1)
        expect(mockedUndoOp).toHaveBeenCalledWith({ opRef: ref(5) })
        expect(mockedUndoOps).not.toHaveBeenCalled()
        expect(mockedUndoPageGroup).not.toHaveBeenCalled()
        expect(returned).toEqual(makeUndoResult({ deviceId: 'dev1', seq: 5, newSeq: 100 }))

        const pageState = useUndoStore.getState().pages.get('page1')
        expect(pageState?.undoStack).toEqual([])
        // Display/fallback anchor still advances so a later positional
        // fallback stays coherent.
        expect(pageState?.undoDepth).toBe(1)
        // Redo carries the undo's new_op_ref (the appended reverse op).
        expect(pageState?.redoStack).toEqual([ref(100)])
        expect(pageState?.redoGroupSizes).toEqual([1])
      })

      it('separate entries keep their own captured refs (LIFO)', async () => {
        vi.useFakeTimers()
        try {
          vi.setSystemTime(1_000_000)
          useUndoStore.getState().onNewAction('page1', [ref(5)])
          // Past the window → a distinct entry.
          vi.setSystemTime(1_000_000 + UNDO_GROUP_WINDOW_MS + 1)
          useUndoStore.getState().onNewAction('page1', [ref(9)])
          expect(useUndoStore.getState().pages.get('page1')?.undoStack).toHaveLength(2)

          mockedUndoOp.mockResolvedValueOnce(makeUndoResult({ deviceId: 'dev1', seq: 9 }))
          await useUndoStore.getState().undo('page1')
          expect(mockedUndoOp).toHaveBeenLastCalledWith({ opRef: ref(9) })

          mockedUndoOp.mockResolvedValueOnce(makeUndoResult({ deviceId: 'dev1', seq: 5 }))
          await useUndoStore.getState().undo('page1')
          expect(mockedUndoOp).toHaveBeenLastCalledWith({ opRef: ref(5) })

          expect(useUndoStore.getState().pages.get('page1')?.undoStack).toEqual([])
          expect(useUndoStore.getState().pages.get('page1')?.undoDepth).toBe(2)
        } finally {
          vi.useRealTimers()
        }
      })

      it('after the ref stack drains, undo falls back to positional with the advanced depth', async () => {
        useUndoStore.getState().onNewAction('page1', [ref(5)])
        mockedUndoOp.mockResolvedValueOnce(makeUndoResult({ deviceId: 'dev1', seq: 5 }))
        await useUndoStore.getState().undo('page1')

        // Stack empty → pre-tracking history → positional fallback, seeded
        // PAST the ref-undone op (depth 1).
        mockedUndoPageGroup.mockResolvedValueOnce([makeUndoResult({ deviceId: 'dev1', seq: 4 })])
        await useUndoStore.getState().undo('page1')

        expect(mockedUndoPageGroup).toHaveBeenCalledTimes(1)
        expect(mockedUndoPageGroup).toHaveBeenCalledWith({
          pageId: 'page1',
          depth: 1,
          windowMs: UNDO_GROUP_WINDOW_MS,
        })
        expect(useUndoStore.getState().pages.get('page1')?.undoDepth).toBe(2)
      })
    })

    describe('capture-time coalescing (one undoOps call per group)', () => {
      it('actions within the window accumulate ONE entry; undo issues ONE atomic undoOps (newest-first)', async () => {
        vi.useFakeTimers()
        try {
          vi.setSystemTime(1_000_000)
          // One action appending two ops (e.g. a recurrence burst)…
          useUndoStore.getState().onNewAction('page1', [ref(1), ref(2)])
          // …and a second action 300ms later — inside the window.
          vi.setSystemTime(1_000_300)
          useUndoStore.getState().onNewAction('page1', [ref(3)])

          const pageState = useUndoStore.getState().pages.get('page1')
          expect(pageState?.undoStack).toHaveLength(1)
          expect(pageState?.undoStack[0]?.refs).toEqual([ref(1), ref(2), ref(3)])

          mockedUndoOps.mockResolvedValueOnce([
            makeUndoResult({ deviceId: 'dev1', seq: 3, newSeq: 103 }),
            makeUndoResult({ deviceId: 'dev1', seq: 2, newSeq: 102 }),
            makeUndoResult({ deviceId: 'dev1', seq: 1, newSeq: 101 }),
          ])

          const returned = await useUndoStore.getState().undo('page1')

          // ONE atomic IPC for the whole coalesced group, refs newest-first.
          expect(mockedUndoOps).toHaveBeenCalledTimes(1)
          expect(mockedUndoOps).toHaveBeenCalledWith({ ops: [ref(3), ref(2), ref(1)] })
          expect(mockedUndoOp).not.toHaveBeenCalled()
          expect(mockedUndoPageGroup).not.toHaveBeenCalled()
          expect(returned).toEqual(makeUndoResult({ deviceId: 'dev1', seq: 3, newSeq: 103 }))

          const after = useUndoStore.getState().pages.get('page1')
          expect(after?.undoStack).toEqual([])
          expect(after?.undoDepth).toBe(3)
          // Newest-first results prepended in order → OLDEST op's reverse at
          // the front, the order redo pops for oldest-first replay.
          expect(after?.redoStack).toEqual([ref(101), ref(102), ref(103)])
          expect(after?.redoGroupSizes).toEqual([3])
        } finally {
          vi.useRealTimers()
        }
      })

      it('the coalescing window SLIDES with each action', () => {
        vi.useFakeTimers()
        try {
          vi.setSystemTime(1_000_000)
          useUndoStore.getState().onNewAction('page1', [ref(1)])
          vi.setSystemTime(1_000_400)
          useUndoStore.getState().onNewAction('page1', [ref(2)])
          // 800ms after the FIRST action but only 400ms after the second —
          // still one group (mirrors the backend's consecutive-gap rule).
          vi.setSystemTime(1_000_800)
          useUndoStore.getState().onNewAction('page1', [ref(3)])

          const pageState = useUndoStore.getState().pages.get('page1')
          expect(pageState?.undoStack).toHaveLength(1)
          expect(pageState?.undoStack[0]?.refs).toEqual([ref(1), ref(2), ref(3)])
        } finally {
          vi.useRealTimers()
        }
      })

      it('a ref-less action inside the window degrades the merged entry to the positional fallback', async () => {
        vi.useFakeTimers()
        try {
          vi.setSystemTime(1_000_000)
          useUndoStore.getState().onNewAction('page1', [ref(5)])
          // A batch command (no refs) lands 100ms later — same burst.
          vi.setSystemTime(1_000_100)
          useUndoStore.getState().onNewAction('page1')

          const pageState = useUndoStore.getState().pages.get('page1')
          expect(pageState?.undoStack).toHaveLength(1)
          expect(pageState?.undoStack[0]?.refs).toBeNull()

          // Undo of the mixed burst goes through the positional group path,
          // which the backend coalesces over the SAME window — one Ctrl+Z
          // still reverts the whole burst.
          mockedUndoPageGroup.mockResolvedValueOnce(makeGroup(6, 2, 'dev1'))
          await useUndoStore.getState().undo('page1')

          expect(mockedUndoPageGroup).toHaveBeenCalledWith({
            pageId: 'page1',
            depth: 0,
            windowMs: UNDO_GROUP_WINDOW_MS,
          })
          expect(mockedUndoOp).not.toHaveBeenCalled()
          expect(mockedUndoOps).not.toHaveBeenCalled()
          expect(useUndoStore.getState().pages.get('page1')?.undoStack).toEqual([])
        } finally {
          vi.useRealTimers()
        }
      })
    })

    describe('redo → undo target cycling', () => {
      it('a redone op re-enters the undo stack as a ref entry targeting the redo op (new_op_ref)', async () => {
        useUndoStore.getState().onNewAction('page1', [ref(5)])
        mockedUndoOp.mockResolvedValueOnce(makeUndoResult({ deviceId: 'dev1', seq: 5, newSeq: 6 }))
        await useUndoStore.getState().undo('page1')
        expect(useUndoStore.getState().pages.get('page1')?.undoStack).toEqual([])

        // Redo reverses the undo op (seq 6) and appends a redo op (seq 7) —
        // per the #2468 contract, that redo op's ref is the NEW undo target.
        mockedRedoPageOp.mockResolvedValueOnce(
          makeUndoResult({ deviceId: 'dev1', seq: 6, newSeq: 7, isRedo: true }),
        )
        await useUndoStore.getState().redo('page1')

        const pageState = useUndoStore.getState().pages.get('page1')
        expect(pageState?.undoStack).toHaveLength(1)
        expect(pageState?.undoStack[0]?.refs).toEqual([ref(7)])
        expect(pageState?.redoStack).toEqual([])

        // The next Ctrl+Z re-undoes the redone action BY REF.
        mockedUndoOp.mockResolvedValueOnce(makeUndoResult({ deviceId: 'dev1', seq: 7, newSeq: 8 }))
        await useUndoStore.getState().undo('page1')
        expect(mockedUndoOp).toHaveBeenLastCalledWith({ opRef: ref(7) })
      })

      it('a group redo collects every redone op ref into ONE coalesced undo entry', async () => {
        vi.useFakeTimers()
        try {
          vi.setSystemTime(1_000_000)
          useUndoStore.getState().onNewAction('page1', [ref(1), ref(2), ref(3)])
          mockedUndoOps.mockResolvedValueOnce([
            makeUndoResult({ deviceId: 'dev1', seq: 3, newSeq: 103 }),
            makeUndoResult({ deviceId: 'dev1', seq: 2, newSeq: 102 }),
            makeUndoResult({ deviceId: 'dev1', seq: 1, newSeq: 101 }),
          ])
          await useUndoStore.getState().undo('page1')

          // Redo replays oldest-first (101, 102, 103); each appends a redo op
          // (201, 202, 203) whose ref becomes part of the next undo target.
          mockedRedoPageOp
            .mockResolvedValueOnce(
              makeUndoResult({ deviceId: 'dev1', seq: 101, newSeq: 201, isRedo: true }),
            )
            .mockResolvedValueOnce(
              makeUndoResult({ deviceId: 'dev1', seq: 102, newSeq: 202, isRedo: true }),
            )
            .mockResolvedValueOnce(
              makeUndoResult({ deviceId: 'dev1', seq: 103, newSeq: 203, isRedo: true }),
            )
          await useUndoStore.getState().redo('page1')

          const pageState = useUndoStore.getState().pages.get('page1')
          expect(pageState?.undoStack).toHaveLength(1)
          expect(pageState?.undoStack[0]?.refs).toEqual([ref(201), ref(202), ref(203)])

          // And the whole redone group re-undoes with ONE atomic undoOps
          // call, newest-first.
          mockedUndoOps.mockResolvedValueOnce([
            makeUndoResult({ deviceId: 'dev1', seq: 203, newSeq: 303 }),
            makeUndoResult({ deviceId: 'dev1', seq: 202, newSeq: 302 }),
            makeUndoResult({ deviceId: 'dev1', seq: 201, newSeq: 301 }),
          ])
          await useUndoStore.getState().undo('page1')
          expect(mockedUndoOps).toHaveBeenLastCalledWith({ ops: [ref(203), ref(202), ref(201)] })
        } finally {
          vi.useRealTimers()
        }
      })
    })

    describe('error surfaces (Validation rejection leaves the stack consistent)', () => {
      it('undoOp rejection mutates nothing, warns, and the SAME ref is retried next time', async () => {
        useUndoStore.getState().onNewAction('page1', [ref(5)])

        const err = new Error('op (dev1, 5) is already reversed')
        mockedUndoOp.mockRejectedValueOnce(err)

        const returned = await useUndoStore.getState().undo('page1')

        expect(returned).toBeNull()
        expect(mockedLogger.error).toHaveBeenCalledWith(
          'UndoStore',
          'undo_op failed',
          { pageId: 'page1', refCount: 1 },
          err,
        )
        expect(mockedToastWarning).toHaveBeenCalledTimes(1)

        // Stack consistent: the entry was NOT consumed, no redo entry was
        // fabricated, the positional anchor did not move.
        const pageState = useUndoStore.getState().pages.get('page1')
        expect(pageState?.undoStack).toHaveLength(1)
        expect(pageState?.undoStack[0]?.refs).toEqual([ref(5)])
        expect(pageState?.undoDepth).toBe(0)
        expect(pageState?.redoStack).toEqual([])
        expect(pageState?.redoGroupSizes).toEqual([])

        // A retry resubmits the SAME captured ref.
        mockedUndoOp.mockResolvedValueOnce(makeUndoResult({ deviceId: 'dev1', seq: 5 }))
        await useUndoStore.getState().undo('page1')
        expect(mockedUndoOp).toHaveBeenLastCalledWith({ opRef: ref(5) })
        expect(useUndoStore.getState().pages.get('page1')?.undoStack).toEqual([])
      })

      it('undoOps rejection (atomic-abort) leaves the coalesced entry intact', async () => {
        vi.useFakeTimers()
        try {
          vi.setSystemTime(1_000_000)
          useUndoStore.getState().onNewAction('page1', [ref(1), ref(2)])
        } finally {
          vi.useRealTimers()
        }

        mockedUndoOps.mockRejectedValueOnce(new Error('validation: bad ref in set'))
        const returned = await useUndoStore.getState().undo('page1')

        expect(returned).toBeNull()
        expect(mockedToastWarning).toHaveBeenCalledTimes(1)
        const pageState = useUndoStore.getState().pages.get('page1')
        expect(pageState?.undoStack).toHaveLength(1)
        expect(pageState?.undoStack[0]?.refs).toEqual([ref(1), ref(2)])
        expect(pageState?.undoDepth).toBe(0)
        expect(pageState?.redoStack).toEqual([])
      })
    })

    describe('positional fallback preserved for ref-less flows (batch commands)', () => {
      it('a ref-less entry undoes via undoPageGroup (depth/window) and pops the entry', async () => {
        // moveBlocksBatch / createBlocksBatch don't surface refs yet — their
        // notification pushes a fallback entry.
        useUndoStore.getState().onNewAction('page1')

        mockedUndoPageGroup.mockResolvedValueOnce(makeGroup(3, 3, 'dev1'))
        await useUndoStore.getState().undo('page1')

        expect(mockedUndoPageGroup).toHaveBeenCalledWith({
          pageId: 'page1',
          depth: 0,
          windowMs: UNDO_GROUP_WINDOW_MS,
        })
        expect(mockedUndoOp).not.toHaveBeenCalled()
        expect(mockedUndoOps).not.toHaveBeenCalled()

        const pageState = useUndoStore.getState().pages.get('page1')
        expect(pageState?.undoStack).toEqual([])
        expect(pageState?.undoDepth).toBe(3)
        expect(pageState?.redoStack).toHaveLength(3)
        expect(pageState?.redoGroupSizes).toEqual([3])
      })

      it('mixed stack: positional fallback for the newer batch entry, then ref undo for the older entry', async () => {
        vi.useFakeTimers()
        try {
          vi.setSystemTime(1_000_000)
          useUndoStore.getState().onNewAction('page1', [ref(5)])
          // A batch action lands well past the window — its OWN entry.
          vi.setSystemTime(1_002_000)
          useUndoStore.getState().onNewAction('page1')
          expect(useUndoStore.getState().pages.get('page1')?.undoStack).toHaveLength(2)
        } finally {
          vi.useRealTimers()
        }

        // First Ctrl+Z: the batch entry → positional path.
        mockedUndoPageGroup.mockResolvedValueOnce([makeUndoResult({ deviceId: 'dev1', seq: 9 })])
        await useUndoStore.getState().undo('page1')
        expect(mockedUndoPageGroup).toHaveBeenCalledTimes(1)

        // Second Ctrl+Z: the ref entry beneath → exact captured ref.
        mockedUndoOp.mockResolvedValueOnce(makeUndoResult({ deviceId: 'dev1', seq: 5 }))
        await useUndoStore.getState().undo('page1')
        expect(mockedUndoOp).toHaveBeenCalledWith({ opRef: ref(5) })

        const pageState = useUndoStore.getState().pages.get('page1')
        expect(pageState?.undoStack).toEqual([])
        expect(pageState?.undoDepth).toBe(2)
      })
    })

    describe('resets drop captured refs', () => {
      it('reanchorAfterRemoteOps clears the ref stack (#731 conservative reset)', async () => {
        useUndoStore.getState().onNewAction('page1', [ref(5)])
        useUndoStore.getState().reanchorAfterRemoteOps('page1')

        const pageState = useUndoStore.getState().pages.get('page1')
        expect(pageState?.undoStack).toEqual([])
        expect(pageState?.undoDepth).toBe(0)
      })

      it('clearPage mid-flight drops the ref-undo result without re-seeding (#1677)', async () => {
        useUndoStore.getState().onNewAction('page1', [ref(5)])

        let resolveUndo: (r: ReturnType<typeof makeUndoResult>) => void = () => {}
        mockedUndoOp.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveUndo = resolve
            }),
        )

        const undoPromise = useUndoStore.getState().undo('page1')
        await Promise.resolve()
        useUndoStore.getState().clearPage('page1')

        resolveUndo(makeUndoResult({ deviceId: 'dev1', seq: 5 }))
        await undoPromise

        expect(useUndoStore.getState().pages.has('page1')).toBe(false)
      })
    })

    // -------------------------------------------------------------------------
    // #2912 — a debounced blur-commit resolving mid-undo must NOT coalesce into
    // the entry the in-flight undo is reverting. Pre-fix `onNewAction` merged it
    // (same coalesceKey) into a NEW `{ refs: [...] }` object; the undo's
    // identity-based `withoutEntry` then missed it, stranding an already-
    // reversed ref on the surviving entry → every later Ctrl+Z atomically
    // aborted (`undo.batchUnavailable`), killing undo for the page.
    // -------------------------------------------------------------------------
    describe('#2912 — no coalescing into an in-flight-undo entry', () => {
      it('onNewAction (same coalesceKey) mid-undo pushes a FRESH entry, leaving the reverting entry intact', async () => {
        // E = the entry Ctrl+Z reverts: one captured ref, a content-edit key.
        useUndoStore.getState().onNewAction('page1', [ref(1)], 'edit:B')
        const E = useUndoStore.getState().pages.get('page1')?.undoStack[0]
        expect(E?.refs).toEqual([ref(1)])

        // Hold undoOp(E) pending → undoByRefs is in flight.
        let resolveUndo: (r: ReturnType<typeof makeUndoResult>) => void = () => {}
        mockedUndoOp.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveUndo = resolve
            }),
        )

        const undoPromise = useUndoStore.getState().undo('page1')
        await Promise.resolve()

        // A prior debounced blur-commit resolves DURING the in-flight undo,
        // carrying the SAME coalesceKey. Pre-fix this merged into E (E' =
        // { refs:[r1,r2] }); the fix pushes a fresh entry ABOVE E instead.
        useUndoStore.getState().onNewAction('page1', [ref(2)], 'edit:B')

        const midStack = useUndoStore.getState().pages.get('page1')?.undoStack
        expect(midStack).toHaveLength(2)
        // Fresh entry on top carries ONLY the new op (no merge).
        expect(midStack?.[0]?.refs).toEqual([ref(2)])
        // E survives UNMUTATED at index 1 — its identity is preserved so the
        // in-flight reconcile can still find and remove it.
        expect(midStack?.[1]).toBe(E)
        expect(midStack?.[1]?.refs).toEqual([ref(1)])

        // Undo settles: reverse of r1. E is removed by identity.
        resolveUndo(makeUndoResult({ deviceId: 'dev1', seq: 1, newSeq: 100 }))
        await undoPromise

        const after = useUndoStore.getState().pages.get('page1')?.undoStack
        expect(after).toHaveLength(1)
        expect(after?.[0]?.refs).toEqual([ref(2)])

        // Follow-up Ctrl+Z reverts ONLY r2 — the already-reversed r1 is never
        // resubmitted, so no atomic-abort / undo.batchUnavailable.
        mockedUndoOp.mockResolvedValueOnce(
          makeUndoResult({ deviceId: 'dev1', seq: 2, newSeq: 101 }),
        )
        await useUndoStore.getState().undo('page1')
        expect(mockedUndoOp).toHaveBeenLastCalledWith({ opRef: ref(2) })
        expect(mockedUndoOps).not.toHaveBeenCalled()
      })

      it('resumes normal same-key coalescing once the in-flight undo settles (guard is cleared)', async () => {
        useUndoStore.getState().onNewAction('page1', [ref(1)], 'edit:B')

        mockedUndoOp.mockResolvedValueOnce(
          makeUndoResult({ deviceId: 'dev1', seq: 1, newSeq: 100 }),
        )
        await useUndoStore.getState().undo('page1')
        expect(useUndoStore.getState().pages.get('page1')?.undoStack).toEqual([])

        // No undo in flight now → same-key actions coalesce again as usual.
        useUndoStore.getState().onNewAction('page1', [ref(2)], 'edit:B')
        useUndoStore.getState().onNewAction('page1', [ref(3)], 'edit:B')

        const stack = useUndoStore.getState().pages.get('page1')?.undoStack
        expect(stack).toHaveLength(1)
        expect(stack?.[0]?.refs).toEqual([ref(2), ref(3)])
      })

      it('normal same-key coalescing is untouched when NO undo is in flight', () => {
        useUndoStore.getState().onNewAction('page1', [ref(1)], 'edit:B')
        useUndoStore.getState().onNewAction('page1', [ref(2)], 'edit:B')

        const stack = useUndoStore.getState().pages.get('page1')?.undoStack
        expect(stack).toHaveLength(1)
        expect(stack?.[0]?.refs).toEqual([ref(1), ref(2)])
      })
    })
  })

  // ---------------------------------------------------------------------------
  // undoDeleteOf (#2901, finding 42)
  //
  // Moved wholesale from SortableBlock's `undoSwipeDelete`: the swipe-delete
  // toast's Undo is pinned to the delete op it promises to reverse, not a
  // positional depth-0 group undo. Tapping the toast first blurs any dirty
  // roving editor, whose flush lands a fresh `edit_block` op ON TOP of the
  // delete — a naive depth-0 undo would reverse that edit (or group it with
  // the delete) instead. The fix: locate the block's newest `delete_block` op
  // in the page history, undo at ITS depth, verify the reversed ref, and roll
  // a mis-undo back (redo) before probing one deeper.
  // ---------------------------------------------------------------------------
  describe('undoDeleteOf (#2901, finding 42)', () => {
    const DELETE_REF = { device_id: 'dev-1', seq: 5 }
    // `undoDeleteOf` does not reach into `@/stores/page-blocks` itself (that
    // would close an `undo.ts <-> page-blocks.ts` import cycle, #761/#2465);
    // the caller supplies the page reload as a callback, so tests pass this
    // mock directly as the third argument instead of mocking `getPageStore`.
    const mockLoad = vi.fn().mockResolvedValue(undefined)

    function historyEntry(
      opType: string,
      blockId: string,
      opRef: { device_id: string; seq: number },
    ): HistoryEntry {
      return {
        device_id: opRef.device_id,
        seq: opRef.seq,
        op_type: opType,
        payload: JSON.stringify({ block_id: blockId }),
        created_at: 1000 + opRef.seq,
        is_replicated: false,
      }
    }

    function historyPage(items: HistoryEntry[]): PageResponse<HistoryEntry> {
      return { items, next_cursor: null, has_more: false, total_count: null }
    }

    beforeEach(() => {
      mockLoad.mockClear()
    })

    it('undoes at depth 0 when the delete is still the newest op', async () => {
      mockedListPageHistory.mockResolvedValue(
        historyPage([historyEntry('delete_block', 'BLOCK_SWIPE', DELETE_REF)]),
      )
      mockedUndoPageOp.mockResolvedValue(makeUndoResult({ deviceId: 'dev-1', seq: 5 }))

      await useUndoStore.getState().undoDeleteOf('page1', 'BLOCK_SWIPE', mockLoad)

      expect(mockedUndoPageOp).toHaveBeenCalledExactlyOnceWith({ pageId: 'page1', undoDepth: 0 })
      expect(mockedRedoPageOp).not.toHaveBeenCalled()
    })

    // Non-tautology: this only passes if the depth argument is actually
    // computed from the delete op's INDEX in the history — a hardcoded
    // `undoDepth: 0` (the bug this whole mechanism exists to prevent) fails
    // this assertion.
    it('undoes at the delete op depth (NOT depth 0) when a tap-time flush landed an edit on top', async () => {
      // Newest-first page history at tap time: the tap's own blur-flush edit
      // of ANOTHER block sits above the delete.
      mockedListPageHistory.mockResolvedValue(
        historyPage([
          historyEntry('edit_block', 'BLOCK_EDITED', { device_id: 'dev-1', seq: 6 }),
          historyEntry('delete_block', 'BLOCK_SWIPE', DELETE_REF),
        ]),
      )
      mockedUndoPageOp.mockResolvedValue(makeUndoResult({ deviceId: 'dev-1', seq: 5 }))

      await useUndoStore.getState().undoDeleteOf('page1', 'BLOCK_SWIPE', mockLoad)

      expect(mockedUndoPageOp).toHaveBeenCalledExactlyOnceWith({ pageId: 'page1', undoDepth: 1 })
      expect(mockedRedoPageOp).not.toHaveBeenCalled()
    })

    // Non-tautology: this only passes if a mis-targeted undo is actually
    // rolled back via `redoPageOp` and the delete re-targeted one depth
    // deeper — removing the rollback probe (or not re-trying) fails this.
    it('rolls a mis-undo back (redo) and probes one deeper when the undo reversed a racing edit', async () => {
      // The history read raced the tap's flush: the edit is NOT visible yet,
      // so the delete looks like depth 0 …
      mockedListPageHistory.mockResolvedValue(
        historyPage([historyEntry('delete_block', 'BLOCK_SWIPE', DELETE_REF)]),
      )
      // … but by the time the undo transaction runs, the edit committed on
      // top: depth 0 reverses the EDIT, not the delete.
      const editRef = { device_id: 'dev-1', seq: 6 }
      const misUndo = makeUndoResult({ deviceId: editRef.device_id, seq: editRef.seq, newSeq: 200 })
      mockedUndoPageOp
        .mockResolvedValueOnce(misUndo)
        .mockResolvedValueOnce(makeUndoResult({ deviceId: 'dev-1', seq: 5, newSeq: 201 }))
      mockedRedoPageOp.mockResolvedValue(makeUndoResult({ deviceId: editRef.device_id, seq: 200 }))

      await useUndoStore.getState().undoDeleteOf('page1', 'BLOCK_SWIPE', mockLoad)

      expect(mockedUndoPageOp).toHaveBeenCalledTimes(2)
      // The wrong undo was rolled back by reversing ITS reverse op…
      expect(mockedRedoPageOp).toHaveBeenCalledExactlyOnceWith({
        undoDeviceId: misUndo.new_op_ref.device_id,
        undoSeq: misUndo.new_op_ref.seq,
      })
      // …then the delete was re-targeted one depth deeper.
      expect(mockedUndoPageOp).toHaveBeenLastCalledWith({ pageId: 'page1', undoDepth: 1 })
    })

    it('on success: resets redo/positional bookkeeping via onNewAction, notifies + announces, and refreshes the page store', async () => {
      mockedListPageHistory.mockResolvedValue(
        historyPage([historyEntry('delete_block', 'BLOCK_SWIPE', DELETE_REF)]),
      )
      mockedUndoPageOp.mockResolvedValue(makeUndoResult({ deviceId: 'dev-1', seq: 5 }))

      // Seed stale redo/positional bookkeeping the way a prior Ctrl+Z would
      // leave behind, to prove `undoDeleteOf`'s internal `onNewAction(pageId)`
      // call actually invalidates it — this targeted undo bypasses the normal
      // ref/positional undo paths that would otherwise do so (the "bypasses
      // the undo store's positional bookkeeping" comment this move resolves).
      useUndoStore.setState({
        pages: new Map([
          [
            'page1',
            {
              undoStack: [],
              redoStack: [{ device_id: 'dev-1', seq: 99 }],
              undoDepth: 3,
              redoGroupSizes: [1],
            },
          ],
        ]),
      })

      await useUndoStore.getState().undoDeleteOf('page1', 'BLOCK_SWIPE', mockLoad)

      const pageState = useUndoStore.getState().pages.get('page1')
      expect(pageState?.redoStack).toEqual([])
      expect(pageState?.undoDepth).toBe(0)
      expect(pageState?.redoGroupSizes).toEqual([])

      expect(mockedToastDefault).toHaveBeenCalledTimes(1)
      expect(mockedAnnounce).toHaveBeenCalledTimes(1)
      expect(mockedToastError).not.toHaveBeenCalled()
      expect(mockLoad).toHaveBeenCalledTimes(1)
    })

    it('surfaces an error (and does not undo) when the delete op cannot be found', async () => {
      mockedListPageHistory.mockResolvedValue(
        historyPage([historyEntry('edit_block', 'BLOCK_OTHER', { device_id: 'dev-1', seq: 9 })]),
      )

      await useUndoStore.getState().undoDeleteOf('page1', 'BLOCK_SWIPE', mockLoad)

      expect(mockedUndoPageOp).not.toHaveBeenCalled()
      expect(mockedToastError).toHaveBeenCalledTimes(1)
      expect(mockedLogger.warn).toHaveBeenCalledWith(
        'UndoStore',
        'swipe-delete undo: delete op not found in page history',
        { pageId: 'page1', blockId: 'BLOCK_SWIPE' },
      )
    })

    it('surfaces an error when the history read rejects (IPC failure path)', async () => {
      const err = new Error('backend down')
      mockedListPageHistory.mockRejectedValue(err)

      await useUndoStore.getState().undoDeleteOf('page1', 'BLOCK_SWIPE', mockLoad)

      expect(mockedUndoPageOp).not.toHaveBeenCalled()
      expect(mockedToastError).toHaveBeenCalledTimes(1)
      expect(mockedLogger.error).toHaveBeenCalledWith(
        'UndoStore',
        'swipe-delete undo failed',
        { pageId: 'page1', blockId: 'BLOCK_SWIPE' },
        err,
      )
    })

    it('surfaces an error when both probed depths reverse the wrong op', async () => {
      mockedListPageHistory.mockResolvedValue(
        historyPage([historyEntry('delete_block', 'BLOCK_SWIPE', DELETE_REF)]),
      )
      // Neither probed depth (0, then 1) reverses the target op — each wrong
      // probe is rolled back via redoPageOp before the next (or before giving
      // up), so both iterations roll back: redoPageOp is called TWICE.
      mockedUndoPageOp
        .mockResolvedValueOnce(makeUndoResult({ deviceId: 'dev-1', seq: 6, newSeq: 200 }))
        .mockResolvedValueOnce(makeUndoResult({ deviceId: 'dev-1', seq: 7, newSeq: 201 }))
      mockedRedoPageOp
        .mockResolvedValueOnce(makeUndoResult({ deviceId: 'dev-1', seq: 200 }))
        .mockResolvedValueOnce(makeUndoResult({ deviceId: 'dev-1', seq: 201 }))

      await useUndoStore.getState().undoDeleteOf('page1', 'BLOCK_SWIPE', mockLoad)

      expect(mockedUndoPageOp).toHaveBeenCalledTimes(2)
      expect(mockedRedoPageOp).toHaveBeenCalledTimes(2)
      expect(mockedToastError).toHaveBeenCalledTimes(1)
      expect(mockedLogger.warn).toHaveBeenCalledWith(
        'UndoStore',
        'swipe-delete undo: could not pin the delete op',
        { pageId: 'page1', blockId: 'BLOCK_SWIPE' },
      )
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
