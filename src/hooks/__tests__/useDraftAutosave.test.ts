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

import { useDraftAutosave } from '@/hooks/useDraftAutosave'
import { deleteDraft, flushDraft, saveDraft } from '@/lib/tauri'

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

/**
 * Flush pending microtasks. Effect B's unmount cleanup chains the final
 * `flushDraft` on the `saveDraft` IPC promise (gap 2 — so the flush reads the
 * just-written row, defeating the write-pool race), so the flush only fires a
 * couple of microtask turns after `unmount()`. Awaiting this lets those
 * `.then`/`.catch` continuations settle under fake timers.
 */
async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

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

  it('flushes draft on unmount with the block ID', async () => {
    const { unmount } = renderHook(() => useDraftAutosave('BLOCK_1', 'content'))

    unmount()
    await flushMicrotasks()

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

    it('blockId change flushes exactly once, for the OLD block', async () => {
      const { rerender } = renderHook(
        ({ blockId, content }) => useDraftAutosave(blockId, content),
        { initialProps: { blockId: 'BLOCK_1', content: 'old block content' } },
      )

      rerender({ blockId: 'BLOCK_2', content: 'new block content' })
      await flushMicrotasks()

      expect(mockedFlushDraft).toHaveBeenCalledTimes(1)
      expect(mockedFlushDraft).toHaveBeenCalledWith('BLOCK_1')
    })

    // #770 gap 2 regression — the final `saveDraft` before flush must be
    // scoped to the UNMOUNT-WHILE-FOCUSED path. On a block SWITCH the live
    // `contentRef` has already advanced to the NEW block's text, so saving it
    // into the OLD block's draft row would corrupt the old block (flushed as
    // `edit_block(oldBlock, newBlockText)`). The block-switch cleanup must
    // flush the OLD block's stored row WITHOUT a preceding save.
    it('block switch does NOT save the new block content into the old draft (gap 2)', async () => {
      const { rerender } = renderHook(
        ({ blockId, content }) => useDraftAutosave(blockId, content),
        { initialProps: { blockId: 'BLOCK_1', content: 'old block content' } },
      )

      // Let the old block's debounced save land.
      act(() => {
        vi.advanceTimersByTime(2000)
      })
      expect(mockedSaveDraft).toHaveBeenLastCalledWith('BLOCK_1', 'old block content')
      mockedSaveDraft.mockClear()

      // Switch to BLOCK_2: contentRef now mirrors 'new block content'.
      rerender({ blockId: 'BLOCK_2', content: 'new block content' })
      await flushMicrotasks()

      // The OLD block's draft row must NOT be overwritten with the new text.
      expect(mockedSaveDraft).not.toHaveBeenCalledWith('BLOCK_1', 'new block content')
      // The OLD block is still flushed exactly once.
      expect(mockedFlushDraft).toHaveBeenCalledTimes(1)
      expect(mockedFlushDraft).toHaveBeenCalledWith('BLOCK_1')
    })

    it('blur then refocus of the SAME block (A → null → A) never flushes; later unmount flushes once', async () => {
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
      await flushMicrotasks()
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

  // Issue #1065 — discard-on-unmount race. When a component unmounts
  // coinciding with blur while `isFocused` is still true, Effect B's cleanup
  // runs with `blockIdRef.current` still equal to the block id and (pre-fix)
  // fired `flushDraft` while `discardDraft`'s `deleteDraft` was still in
  // flight — racing it and potentially materializing the ~2s-stale debounced
  // draft as the LATEST `edit_block` op. A synchronous `discardedRef` marker
  // closes the window regardless of unmount-vs-blur ordering.
  describe('issue #1065 — discard suppresses the unmount flush', () => {
    it('discardDraft then unmount WITHOUT re-rendering to null does NOT flush', () => {
      const { result, unmount } = renderHook(() =>
        useDraftAutosave('BLOCK_1', 'stale debounced content'),
      )

      // Discard (as the blur handler does) but stay focused — no re-render to
      // null. blockIdRef still holds BLOCK_1, so the null-ref guard alone
      // would NOT prevent the flush; the discarded marker must.
      act(() => {
        result.current.discardDraft()
      })

      // Unmount directly. Effect B's cleanup fires with blockIdRef === BLOCK_1.
      unmount()

      expect(mockedFlushDraft).not.toHaveBeenCalled()
      // discardDraft still issued exactly one deleteDraft for the block.
      expect(mockedDeleteDraft).toHaveBeenCalledTimes(1)
      expect(mockedDeleteDraft).toHaveBeenCalledWith('BLOCK_1')
    })

    it('a fresh save after discard re-enables flushing (marker cleared)', async () => {
      const { result, rerender, unmount } = renderHook(
        ({ blockId, content }) => useDraftAutosave(blockId, content),
        { initialProps: { blockId: 'BLOCK_1', content: 'first content' } },
      )

      // Discard marks BLOCK_1 as discarded.
      act(() => {
        result.current.discardDraft()
      })

      // The user keeps typing in the SAME block; a genuine fresh save fires
      // after the debounce, which must clear the discarded marker.
      rerender({ blockId: 'BLOCK_1', content: 'real edit after discard' })
      act(() => {
        vi.advanceTimersByTime(2000)
      })
      expect(mockedSaveDraft).toHaveBeenCalledTimes(1)
      expect(mockedSaveDraft).toHaveBeenCalledWith('BLOCK_1', 'real edit after discard')

      // Now an unmount-while-focused must flush again — the marker was cleared
      // by the fresh save, so the real post-discard edit is not suppressed.
      unmount()
      await flushMicrotasks()
      expect(mockedFlushDraft).toHaveBeenCalledTimes(1)
      expect(mockedFlushDraft).toHaveBeenCalledWith('BLOCK_1')
    })
  })

  // Issue #770 gap 2 — unmount-while-focused must persist the LATEST live
  // content, not just the ≤2s-stale debounced draft row. Effect B's cleanup
  // does a synchronous `saveDraft(blockId, latest)` before `flushDraft`, so
  // the flush (which opens BEGIN IMMEDIATE and serialises after the in-flight
  // saveDraft on the writer lock) materializes the most recent keystrokes.
  describe('issue #770 gap 2 — unmount-while-focused saves latest content', () => {
    it('persists live content via saveDraft before flushing on unmount', async () => {
      const { rerender, unmount } = renderHook(
        ({ blockId, content }) => useDraftAutosave(blockId, content),
        { initialProps: { blockId: 'BLOCK_1', content: 'hello' } },
      )

      // Persist a debounced draft row at "hello".
      act(() => {
        vi.advanceTimersByTime(2000)
      })
      expect(mockedSaveDraft).toHaveBeenCalledTimes(1)
      expect(mockedSaveDraft).toHaveBeenLastCalledWith('BLOCK_1', 'hello')

      // Type more WITHOUT letting the debounce fire — this is the <2s window
      // that pre-fix was lost on unmount.
      rerender({ blockId: 'BLOCK_1', content: 'hello world' })

      // Unmount while focused: cleanup must save the latest content FIRST,
      // and only dispatch the flush once that save's IPC has resolved (the
      // flush is chained on the save promise to defeat the write-pool race —
      // see the gap-2 comment in useDraftAutosave). So the save is observable
      // synchronously, but the flush only after a microtask turn.
      unmount()

      expect(mockedSaveDraft).toHaveBeenLastCalledWith('BLOCK_1', 'hello world')
      // Flush has NOT fired yet — it waits for the save promise to resolve.
      expect(mockedFlushDraft).not.toHaveBeenCalled()

      // Let the chained `.then()` run.
      await flushMicrotasks()

      expect(mockedFlushDraft).toHaveBeenCalledTimes(1)
      expect(mockedFlushDraft).toHaveBeenCalledWith('BLOCK_1')
    })

    it('does NOT save before flush when the block was discarded (respects #1065)', () => {
      const { result, unmount } = renderHook(() =>
        useDraftAutosave('BLOCK_1', 'stale debounced content'),
      )

      // Discard (blur handler) but stay focused — no re-render to null.
      act(() => {
        result.current.discardDraft()
      })
      mockedSaveDraft.mockClear()

      unmount()

      // The discarded marker suppresses BOTH the gap-2 final save and the
      // flush — no resurrection of stale content.
      expect(mockedSaveDraft).not.toHaveBeenCalled()
      expect(mockedFlushDraft).not.toHaveBeenCalled()
    })
  })

  // Issue #770 gap 3 — emptying a block's text must discard the draft row so
  // a hard kill cannot resurrect old text at boot. The debounce effect used
  // to early-return on empty content, stranding a stale row.
  describe('issue #770 gap 3 — emptying discards the draft row', () => {
    it('clearing typed text (non-empty → empty) discards the draft', () => {
      const { rerender } = renderHook(
        ({ blockId, content }) => useDraftAutosave(blockId, content),
        { initialProps: { blockId: 'BLOCK_1', content: 'hello' } },
      )

      // Persist a draft row first.
      act(() => {
        vi.advanceTimersByTime(2000)
      })
      expect(mockedSaveDraft).toHaveBeenCalledTimes(1)

      // User clears the block.
      rerender({ blockId: 'BLOCK_1', content: '' })

      // The stale row is deleted (not left to resurrect at boot)...
      expect(mockedDeleteDraft).toHaveBeenCalledTimes(1)
      expect(mockedDeleteDraft).toHaveBeenCalledWith('BLOCK_1')

      // ...and no further save fires for the now-empty block.
      act(() => {
        vi.advanceTimersByTime(3000)
      })
      expect(mockedSaveDraft).toHaveBeenCalledTimes(1)
    })

    it('a block that merely STARTS empty does NOT discard (no spurious deleteDraft)', () => {
      // Fresh focus on an empty block: previousContent === '' so this is not a
      // user-clear transition. Must not fire deleteDraft (would set the #1065
      // marker and wrongly suppress a later unmount flush).
      const { rerender } = renderHook(
        ({ blockId, content }) => useDraftAutosave(blockId, content),
        { initialProps: { blockId: 'BLOCK_1', content: '' } },
      )
      rerender({ blockId: 'BLOCK_1', content: '' })

      act(() => {
        vi.advanceTimersByTime(3000)
      })
      expect(mockedDeleteDraft).not.toHaveBeenCalled()
      expect(mockedSaveDraft).not.toHaveBeenCalled()
    })

    it('emptying then unmounting does NOT flush (discard marker set)', () => {
      const { rerender, unmount } = renderHook(
        ({ blockId, content }) => useDraftAutosave(blockId, content),
        { initialProps: { blockId: 'BLOCK_1', content: 'hello' } },
      )
      act(() => {
        vi.advanceTimersByTime(2000)
      })

      // Clear the text, then unmount while focused.
      rerender({ blockId: 'BLOCK_1', content: '' })
      mockedSaveDraft.mockClear()
      unmount()

      // The clear marked BLOCK_1 discarded, so the unmount cleanup neither
      // saves nor flushes stale content.
      expect(mockedSaveDraft).not.toHaveBeenCalled()
      expect(mockedFlushDraft).not.toHaveBeenCalled()
    })

    it('retyping after a clear re-enables saving (marker cleared on fresh save)', () => {
      const { rerender } = renderHook(
        ({ blockId, content }) => useDraftAutosave(blockId, content),
        { initialProps: { blockId: 'BLOCK_1', content: 'hello' } },
      )
      act(() => {
        vi.advanceTimersByTime(2000)
      })
      rerender({ blockId: 'BLOCK_1', content: '' }) // clear → discard + marker
      expect(mockedDeleteDraft).toHaveBeenCalledTimes(1)

      // User types again; the fresh save must go through and clear the marker.
      rerender({ blockId: 'BLOCK_1', content: 'new text' })
      act(() => {
        vi.advanceTimersByTime(2000)
      })
      expect(mockedSaveDraft).toHaveBeenLastCalledWith('BLOCK_1', 'new text')
    })
  })

  // Findings 2/48 — blur-path save failure must NOT destroy the draft row.
  // Pre-fix, `discardDraft()` fired `deleteDraft` immediately, concurrently
  // with the un-awaited `edit_block` IPC; when that IPC failed the store
  // rolled back AND the draft row (the boot-time `flush_all_drafts` recovery
  // net) was already gone — the typed text survived nowhere. The discard now
  // accepts the save's outcome promise (`edit` resolves `false` on failure,
  // it never rejects) and only deletes the row once the save succeeded.
  describe('findings 2/48 — draft deletion gated on save outcome', () => {
    it('deletes the draft only AFTER the save outcome resolves true', async () => {
      const { result } = renderHook(() => useDraftAutosave('BLOCK_1', 'typed paragraph'))

      let resolveOutcome: (ok: boolean) => void = () => {}
      const outcome = new Promise<boolean>((resolve) => {
        resolveOutcome = resolve
      })

      act(() => {
        result.current.discardDraft(outcome, 'typed paragraph')
      })

      // The row must survive while the edit IPC is still in flight.
      expect(mockedDeleteDraft).not.toHaveBeenCalled()

      await act(async () => {
        resolveOutcome(true)
      })
      await flushMicrotasks()

      expect(mockedDeleteDraft).toHaveBeenCalledTimes(1)
      expect(mockedDeleteDraft).toHaveBeenCalledWith('BLOCK_1')
    })

    it('keeps the draft row and re-saves the failed content when the save resolves false', async () => {
      const { result } = renderHook(() => useDraftAutosave('BLOCK_1', 'typed paragraph'))
      mockedSaveDraft.mockClear()

      act(() => {
        result.current.discardDraft(Promise.resolve(false), 'typed paragraph')
      })
      await flushMicrotasks()

      // Failed save: the draft row is the last surviving copy of the text —
      // it must NOT be deleted, and the exact failed content is re-saved so
      // recovery works even when no debounce tick ever wrote a row.
      expect(mockedDeleteDraft).not.toHaveBeenCalled()
      expect(mockedSaveDraft).toHaveBeenCalledTimes(1)
      expect(mockedSaveDraft).toHaveBeenCalledWith('BLOCK_1', 'typed paragraph')
    })

    it('treats a rejected save outcome as a failure (keeps the row)', async () => {
      const { result } = renderHook(() => useDraftAutosave('BLOCK_1', 'typed paragraph'))
      mockedSaveDraft.mockClear()

      act(() => {
        result.current.discardDraft(Promise.reject(new Error('escaped')), 'typed paragraph')
      })
      await flushMicrotasks()

      expect(mockedDeleteDraft).not.toHaveBeenCalled()
      expect(mockedSaveDraft).toHaveBeenCalledWith('BLOCK_1', 'typed paragraph')
    })

    it('still cancels the pending debounced save synchronously', () => {
      const { result } = renderHook(() => useDraftAutosave('BLOCK_1', 'typed paragraph'))

      act(() => {
        result.current.discardDraft(Promise.resolve(true), 'typed paragraph')
      })
      act(() => {
        vi.advanceTimersByTime(3000)
      })

      // The debounced saveDraft was cancelled at discard time even though the
      // deleteDraft itself is deferred until the outcome settles.
      expect(mockedSaveDraft).not.toHaveBeenCalled()
    })

    it('skips the deferred deleteDraft when a newer save superseded the discard', async () => {
      const { result, rerender } = renderHook(
        ({ blockId, content }) => useDraftAutosave(blockId, content),
        { initialProps: { blockId: 'BLOCK_1', content: 'first text' } },
      )

      let resolveOutcome: (ok: boolean) => void = () => {}
      const outcome = new Promise<boolean>((resolve) => {
        resolveOutcome = resolve
      })
      act(() => {
        result.current.discardDraft(outcome, 'first text')
      })

      // User refocuses the same block and types; the fresh debounced save
      // writes a NEW draft row that the late deleteDraft must not destroy.
      rerender({ blockId: 'BLOCK_1', content: 'newer text' })
      act(() => {
        vi.advanceTimersByTime(2000)
      })
      expect(mockedSaveDraft).toHaveBeenCalledWith('BLOCK_1', 'newer text')

      await act(async () => {
        resolveOutcome(true)
      })
      await flushMicrotasks()

      expect(mockedDeleteDraft).not.toHaveBeenCalled()
    })

    it('discardDraft with no outcome keeps the synchronous delete (legacy paths)', () => {
      const { result } = renderHook(() => useDraftAutosave('BLOCK_1', 'content'))

      act(() => {
        result.current.discardDraft()
      })

      expect(mockedDeleteDraft).toHaveBeenCalledTimes(1)
      expect(mockedDeleteDraft).toHaveBeenCalledWith('BLOCK_1')
    })
  })

  // Finding 3 — the debounced row is the ONLY crash/kill safety net, but a
  // trailing debounce means it is missing (continuous typing) or ~2s stale
  // when the OS backgrounds-then-kills the webview or the window closes.
  describe('finding 3 — background/close flush of the live content', () => {
    afterEach(() => {
      Object.defineProperty(document, 'visibilityState', {
        value: 'visible',
        configurable: true,
      })
    })

    function setVisibility(state: 'hidden' | 'visible') {
      Object.defineProperty(document, 'visibilityState', {
        value: state,
        configurable: true,
      })
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'))
      })
    }

    it('persists the latest live content when the document becomes hidden', () => {
      const { rerender } = renderHook(
        ({ blockId, content }) => useDraftAutosave(blockId, content),
        { initialProps: { blockId: 'BLOCK_1', content: 'hello' } },
      )

      // Keystroke inside the debounce window — no row written yet.
      rerender({ blockId: 'BLOCK_1', content: 'hello w' })
      expect(mockedSaveDraft).not.toHaveBeenCalled()

      setVisibility('hidden')

      expect(mockedSaveDraft).toHaveBeenCalledTimes(1)
      expect(mockedSaveDraft).toHaveBeenCalledWith('BLOCK_1', 'hello w')
    })

    it('does NOT save on visibilitychange back to visible', () => {
      renderHook(() => useDraftAutosave('BLOCK_1', 'hello'))

      setVisibility('visible')

      expect(mockedSaveDraft).not.toHaveBeenCalled()
    })

    it('persists the latest live content on pagehide', () => {
      const { rerender } = renderHook(
        ({ blockId, content }) => useDraftAutosave(blockId, content),
        { initialProps: { blockId: 'BLOCK_1', content: 'hello' } },
      )
      rerender({ blockId: 'BLOCK_1', content: 'hello world' })

      act(() => {
        window.dispatchEvent(new Event('pagehide'))
      })

      expect(mockedSaveDraft).toHaveBeenCalledTimes(1)
      expect(mockedSaveDraft).toHaveBeenCalledWith('BLOCK_1', 'hello world')
    })

    it('does not save empty content on hidden', () => {
      renderHook(() => useDraftAutosave('BLOCK_1', ''))

      setVisibility('hidden')

      expect(mockedSaveDraft).not.toHaveBeenCalled()
    })

    it('does not save when no block is focused (blockId null)', () => {
      renderHook(() => useDraftAutosave(null, 'stale content'))

      setVisibility('hidden')
      act(() => {
        window.dispatchEvent(new Event('pagehide'))
      })

      expect(mockedSaveDraft).not.toHaveBeenCalled()
    })
  })

  // Finding 3 (max-latency cap) — continuous typing resets the trailing
  // debounce on every keystroke, so pre-fix NO draft row was ever written
  // during an uninterrupted run and a kill lost the whole run. Once a save
  // has been pending longer than the cap, it fires immediately.
  describe('finding 3 — max-latency cap on the trailing debounce', () => {
    it('continuous typing (never pausing 2s) still persists a draft within the cap', () => {
      const { rerender } = renderHook(
        ({ blockId, content }) => useDraftAutosave(blockId, content),
        { initialProps: { blockId: 'BLOCK_1', content: 'c0' } },
      )

      // Keystrokes every second — each one resets the 2s trailing debounce.
      for (let i = 1; i <= 4; i++) {
        act(() => {
          vi.advanceTimersByTime(1000)
        })
        rerender({ blockId: 'BLOCK_1', content: `c${i}` })
      }
      expect(mockedSaveDraft).not.toHaveBeenCalled()

      // The 5th keystroke lands at the 5s cap — the save fires immediately
      // instead of re-arming another 2s trailing window.
      act(() => {
        vi.advanceTimersByTime(1000)
      })
      rerender({ blockId: 'BLOCK_1', content: 'c5' })
      act(() => {
        vi.advanceTimersByTime(0)
      })

      expect(mockedSaveDraft).toHaveBeenCalledTimes(1)
      expect(mockedSaveDraft).toHaveBeenCalledWith('BLOCK_1', 'c5')
    })

    it('the cap window resets after a capped save (no immediate re-fire)', () => {
      const { rerender } = renderHook(
        ({ blockId, content }) => useDraftAutosave(blockId, content),
        { initialProps: { blockId: 'BLOCK_1', content: 'c0' } },
      )

      for (let i = 1; i <= 5; i++) {
        act(() => {
          vi.advanceTimersByTime(1000)
        })
        rerender({ blockId: 'BLOCK_1', content: `c${i}` })
      }
      act(() => {
        vi.advanceTimersByTime(0)
      })
      expect(mockedSaveDraft).toHaveBeenCalledTimes(1)

      // Next keystroke starts a fresh run: an ordinary 2s trailing debounce.
      act(() => {
        vi.advanceTimersByTime(1000)
      })
      rerender({ blockId: 'BLOCK_1', content: 'c6' })
      act(() => {
        vi.advanceTimersByTime(1999)
      })
      expect(mockedSaveDraft).toHaveBeenCalledTimes(1)
      act(() => {
        vi.advanceTimersByTime(1)
      })
      expect(mockedSaveDraft).toHaveBeenCalledTimes(2)
      expect(mockedSaveDraft).toHaveBeenLastCalledWith('BLOCK_1', 'c6')
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
