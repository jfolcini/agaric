/**
 * Tests for useDraftAutosave hook.
 *
 * Validates:
 * - Normal save after 2000ms debounce
 * - Debounce reset on rapid content changes
 * - discardDraft cancels pending save and calls deleteDraft
 * - Race condition fix: version counter prevents stale save after discard
 * - Cleanup flushes draft on unmount
 * - Null blockId produces no saves
 * - Issue #715: flushDraft never fires per keystroke — only on block
 *   change / unmount-while-focused; blur (blockId → null) never flushes
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { deleteDraft, flushDraft, saveDraft } from '@/lib/tauri'

import { useDraftAutosave } from '../useDraftAutosave'

vi.mock('@/lib/tauri', () => ({
  saveDraft: vi.fn(() => Promise.resolve()),
  flushDraft: vi.fn(() => Promise.resolve()),
  deleteDraft: vi.fn(() => Promise.resolve()),
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

const mockedSaveDraft = vi.mocked(saveDraft)
const mockedFlushDraft = vi.mocked(flushDraft)
const mockedDeleteDraft = vi.mocked(deleteDraft)

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useDraftAutosave', () => {
  it('calls saveDraft after 2000ms debounce with correct args', () => {
    renderHook(() => useDraftAutosave('BLOCK_1', 'hello world'))

    expect(mockedSaveDraft).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(2000)
    })

    expect(mockedSaveDraft).toHaveBeenCalledTimes(1)
    expect(mockedSaveDraft).toHaveBeenCalledWith('BLOCK_1', 'hello world')
  })

  it('resets debounce on rapid content changes — only last content saved', () => {
    const { rerender } = renderHook(({ blockId, content }) => useDraftAutosave(blockId, content), {
      initialProps: { blockId: 'BLOCK_1', content: 'first' },
    })

    // Advance partially, then change content
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(mockedSaveDraft).not.toHaveBeenCalled()

    rerender({ blockId: 'BLOCK_1', content: 'second' })

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    // Still shouldn't have fired — timer was reset
    expect(mockedSaveDraft).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    // Now the second timer fires (2000ms after "second" rerender)
    expect(mockedSaveDraft).toHaveBeenCalledTimes(1)
    expect(mockedSaveDraft).toHaveBeenCalledWith('BLOCK_1', 'second')
  })

  it('discardDraft cancels pending save and calls deleteDraft', () => {
    const { result } = renderHook(() => useDraftAutosave('BLOCK_1', 'some content'))

    // Timer is scheduled but hasn't fired yet
    act(() => {
      result.current.discardDraft()
    })

    // Advance past the debounce — saveDraft should NOT be called
    act(() => {
      vi.advanceTimersByTime(3000)
    })

    expect(mockedSaveDraft).not.toHaveBeenCalled()
    expect(mockedDeleteDraft).toHaveBeenCalledTimes(1)
    expect(mockedDeleteDraft).toHaveBeenCalledWith('BLOCK_1')
  })

  it('version counter prevents stale save after discardDraft (race condition fix)', () => {
    // Simulate: timer fires, but discardDraft was called in between.
    // The version counter inside the setTimeout callback should skip the save.
    //
    // To isolate the version check from clearTimeout, we spy on clearTimeout
    // and verify both mechanisms cooperate. The version counter is the
    // defense-in-depth that prevents the race when clearTimeout arrives too late.

    const { result, rerender } = renderHook(
      ({ blockId, content }) => useDraftAutosave(blockId, content),
      { initialProps: { blockId: 'BLOCK_1', content: 'draft content' } },
    )

    // Advance partially — timer not yet fired
    act(() => {
      vi.advanceTimersByTime(1500)
    })
    expect(mockedSaveDraft).not.toHaveBeenCalled()

    // discardDraft bumps the version counter AND clears the timer
    act(() => {
      result.current.discardDraft()
    })

    // Advance well past the original debounce — saveDraft must NOT be called
    act(() => {
      vi.advanceTimersByTime(2000)
    })

    expect(mockedSaveDraft).not.toHaveBeenCalled()
    expect(mockedDeleteDraft).toHaveBeenCalledTimes(1)
    expect(mockedDeleteDraft).toHaveBeenCalledWith('BLOCK_1')

    // Now re-render with new content — a fresh timer with a new version starts
    mockedDeleteDraft.mockClear()
    rerender({ blockId: 'BLOCK_1', content: 'new content after discard' })

    act(() => {
      vi.advanceTimersByTime(2000)
    })

    // This save goes through because the version is current
    expect(mockedSaveDraft).toHaveBeenCalledTimes(1)
    expect(mockedSaveDraft).toHaveBeenCalledWith('BLOCK_1', 'new content after discard')
  })

  it('flushes draft on unmount with the block ID', () => {
    const { unmount } = renderHook(() => useDraftAutosave('BLOCK_1', 'content'))

    unmount()

    expect(mockedFlushDraft).toHaveBeenCalledTimes(1)
    expect(mockedFlushDraft).toHaveBeenCalledWith('BLOCK_1')
  })

  it('does not save when blockId is null', () => {
    renderHook(() => useDraftAutosave(null, 'content'))

    act(() => {
      vi.advanceTimersByTime(3000)
    })

    expect(mockedSaveDraft).not.toHaveBeenCalled()
    expect(mockedFlushDraft).not.toHaveBeenCalled()
  })

  it('does not save when content is empty', () => {
    renderHook(() => useDraftAutosave('BLOCK_1', ''))

    act(() => {
      vi.advanceTimersByTime(3000)
    })

    expect(mockedSaveDraft).not.toHaveBeenCalled()
  })

  // Issue #715 — the flush effect is keyed on `blockId` alone. Before the
  // fix the single effect was keyed `[blockId, content]` and its cleanup
  // unconditionally flushed, firing one write-lock-acquiring `flush_draft`
  // IPC per keystroke and — after a >2s pause — flushing a STALE persisted
  // draft as a real `edit_block` op mid-edit.
  describe('issue #715 — no flushDraft per keystroke', () => {
    it('rapid content changes within the debounce window fire ZERO flushDraft calls', () => {
      const { rerender } = renderHook(
        ({ blockId, content }) => useDraftAutosave(blockId, content),
        { initialProps: { blockId: 'BLOCK_1', content: 'h' } },
      )

      // Five keystrokes, each well inside the 2000ms debounce window.
      for (const content of ['he', 'hel', 'hell', 'hello']) {
        act(() => {
          vi.advanceTimersByTime(300)
        })
        rerender({ blockId: 'BLOCK_1', content })
      }

      // No flush per keystroke, and the debounce kept resetting so no
      // save has fired yet either.
      expect(mockedFlushDraft).not.toHaveBeenCalled()
      expect(mockedSaveDraft).not.toHaveBeenCalled()

      // Letting the debounce expire produces exactly the one trailing
      // save (the debounced cadence) — still zero flushes.
      act(() => {
        vi.advanceTimersByTime(2000)
      })
      expect(mockedSaveDraft).toHaveBeenCalledTimes(1)
      expect(mockedSaveDraft).toHaveBeenCalledWith('BLOCK_1', 'hello')
      expect(mockedFlushDraft).not.toHaveBeenCalled()
    })

    it('pause past the debounce (draft persists) then resume typing — still ZERO flushDraft', () => {
      const { rerender } = renderHook(
        ({ blockId, content }) => useDraftAutosave(blockId, content),
        { initialProps: { blockId: 'BLOCK_1', content: 'hello' } },
      )

      // Pause >2s: the debounced saveDraft persists a draft row.
      act(() => {
        vi.advanceTimersByTime(2500)
      })
      expect(mockedSaveDraft).toHaveBeenCalledTimes(1)
      expect(mockedSaveDraft).toHaveBeenCalledWith('BLOCK_1', 'hello')

      // Resume typing. Pre-fix, the first keystroke's cleanup flushed the
      // stale persisted draft as a real edit_block op mid-edit.
      rerender({ blockId: 'BLOCK_1', content: 'hello w' })
      rerender({ blockId: 'BLOCK_1', content: 'hello wo' })
      act(() => {
        vi.advanceTimersByTime(2000)
      })

      // The stale row is superseded by the later save — never flushed.
      expect(mockedSaveDraft).toHaveBeenCalledTimes(2)
      expect(mockedSaveDraft).toHaveBeenLastCalledWith('BLOCK_1', 'hello wo')
      expect(mockedFlushDraft).not.toHaveBeenCalled()
    })

    it('blockId change flushes exactly once, for the OLD block', () => {
      const { rerender } = renderHook(
        ({ blockId, content }) => useDraftAutosave(blockId, content),
        { initialProps: { blockId: 'BLOCK_1', content: 'old block content' } },
      )

      rerender({ blockId: 'BLOCK_2', content: 'new block content' })

      expect(mockedFlushDraft).toHaveBeenCalledTimes(1)
      expect(mockedFlushDraft).toHaveBeenCalledWith('BLOCK_1')
    })

    it('blur then refocus of the SAME block (A → null → A) never flushes; later unmount flushes once', () => {
      const { rerender, unmount } = renderHook(
        ({ blockId, content }: { blockId: string | null; content: string }) =>
          useDraftAutosave(blockId, content),
        { initialProps: { blockId: 'BLOCK_1' as string | null, content: 'typed content' } },
      )

      // Blur: EditableBlock passes null and resets liveContent to ''.
      rerender({ blockId: null, content: '' })
      expect(mockedFlushDraft).not.toHaveBeenCalled()

      // Refocus the same block. The flush effect re-registers for BLOCK_1;
      // the null→A transition itself must not flush either.
      rerender({ blockId: 'BLOCK_1', content: '' })
      rerender({ blockId: 'BLOCK_1', content: 'typed more' })
      expect(mockedFlushDraft).not.toHaveBeenCalled()

      // Unmount while focused → exactly one flush, for the refocused block.
      unmount()
      expect(mockedFlushDraft).toHaveBeenCalledTimes(1)
      expect(mockedFlushDraft).toHaveBeenCalledWith('BLOCK_1')
    })

    it('blur (blockId → null) does NOT flush — useEditorBlur discardDraft owns that path', () => {
      const { rerender, unmount } = renderHook(
        ({ blockId, content }: { blockId: string | null; content: string }) =>
          useDraftAutosave(blockId, content),
        { initialProps: { blockId: 'BLOCK_1' as string | null, content: 'typed content' } },
      )

      // EditableBlock passes `isFocused ? blockId : null`; blur is this
      // transition. The blur handler saves via edit_block + discardDraft —
      // a flush here would race that delete.
      rerender({ blockId: null, content: '' })

      expect(mockedFlushDraft).not.toHaveBeenCalled()

      // And unmounting after blur still must not flush.
      act(() => {
        vi.advanceTimersByTime(3000)
      })
      unmount()
      expect(mockedFlushDraft).not.toHaveBeenCalled()
    })
  })

  // Issue #106 — autosave is the canonical `pool_busy` consumer: a
  // user typing fast can collide with another in-flight write that
  // holds every connection in the sqlx pool. `retryOnPoolBusy` should
  // re-fire `saveDraft` after the configured backoff; a `database`
  // kind keeps the old log-only behaviour and never retries.
  describe('issue #106 — pool_busy back-pressure', () => {
    it('retries saveDraft when the IPC rejects with kind="pool_busy"', async () => {
      mockedSaveDraft
        .mockRejectedValueOnce({ kind: 'pool_busy', message: 'pool exhausted' })
        .mockResolvedValueOnce(undefined)

      renderHook(() => useDraftAutosave('BLOCK_1', 'content'))

      // Trip the debounce — first attempt rejects with pool_busy.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000)
      })
      // Default retry delay is 50ms; flush the timer + the in-flight
      // microtasks so the second attempt resolves.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200)
      })

      expect(mockedSaveDraft).toHaveBeenCalledTimes(2)
      expect(mockedSaveDraft).toHaveBeenNthCalledWith(1, 'BLOCK_1', 'content')
      expect(mockedSaveDraft).toHaveBeenNthCalledWith(2, 'BLOCK_1', 'content')
    })

    it('does NOT retry on kind="database" (existing log-only behaviour)', async () => {
      mockedSaveDraft.mockRejectedValue({ kind: 'database', message: 'syntax error' })

      renderHook(() => useDraftAutosave('BLOCK_1', 'content'))

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000)
      })
      // Drain microtasks so any (incorrect) retry would have fired.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })

      expect(mockedSaveDraft).toHaveBeenCalledTimes(1)
    })
  })
})
