/**
 * Tests for useDraftAutosave hook.
 *
 * #2938 — the hook is driven by a change SIGNAL (`onContentChange`, called from
 * the editor's `update` event) instead of a per-frame mirrored `liveContent`
 * prop. The block markdown is serialized ON DEMAND from a mock roving-editor
 * handle (`getMarkdown()`) at debounce-fire and flush time; emptiness for the
 * clear-detection path is read from the mock's `editor.isEmpty`.
 *
 * Validates:
 * - Serialization happens ONLY at debounce-fire time, never per signal
 * - Normal save after 2000ms debounce
 * - Debounce reset on rapid content changes
 * - discardDraft cancels pending save and calls deleteDraft
 * - Race condition fix: version counter prevents stale save after discard
 * - Cleanup flushes draft on unmount (serializing the live editor)
 * - Null blockId produces no saves
 * - Issue #715: flushDraft never fires per keystroke — only on block
 *   change / unmount-while-focused; blur (blockId → null) never flushes
 */

import { act, renderHook } from '@testing-library/react'
import type { RefObject } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RovingEditorHandle } from '@/editor/use-roving-editor'
import { useDraftAutosave } from '@/hooks/useDraftAutosave'

// The hook calls `commands.{saveDraft,flushDraft,deleteDraft}` from
// `@/lib/bindings` and unwraps the `Result`-shaped response with the helper
// from `@/lib/app-error`, so the mocks resolve the `{ status: 'ok', data }`
// envelope (data is `null` — these commands return `void`).
const { mockSaveDraft, mockFlushDraft, mockDeleteDraft } = vi.hoisted(() => ({
  mockSaveDraft: vi.fn(() => Promise.resolve({ status: 'ok', data: null })),
  mockFlushDraft: vi.fn(() => Promise.resolve({ status: 'ok', data: null })),
  mockDeleteDraft: vi.fn(() => Promise.resolve({ status: 'ok', data: null })),
}))

vi.mock('@/lib/bindings', () => ({
  commands: {
    saveDraft: mockSaveDraft,
    flushDraft: mockFlushDraft,
    deleteDraft: mockDeleteDraft,
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

const mockedSaveDraft = mockSaveDraft
const mockedFlushDraft = mockFlushDraft
const mockedDeleteDraft = mockDeleteDraft

/**
 * A controllable roving-editor handle. `state.markdown` is what `getMarkdown()`
 * serializes to on demand (simulating the live editor); `editor.isEmpty` is
 * derived from it (mirrors the real serializer: an empty doc → '' markdown).
 * `activeBlockId` gates cross-block fires/flushes.
 */
function makeEditor(init: { activeBlockId?: string | null; markdown?: string } = {}) {
  const getSpy = vi.fn(() => state.markdown)
  const state = {
    activeBlockId: init.activeBlockId ?? 'BLOCK_1',
    markdown: init.markdown ?? '',
  }
  const handle = {
    get activeBlockId() {
      return state.activeBlockId
    },
    getMarkdown: getSpy,
    editor: {
      get isEmpty() {
        return state.markdown === ''
      },
    },
    mount: vi.fn(),
    unmount: vi.fn(() => null),
    originalMarkdown: '',
    splitAtCaret: vi.fn(() => null),
    setOnUpdate: vi.fn(),
    markCommitted: vi.fn(),
  } as unknown as RovingEditorHandle
  const ref: RefObject<RovingEditorHandle> = { current: handle }
  return { handle, state, ref, getSpy }
}

/** Render the hook against a mock editor ref; `blockId` is reroutable via rerender. */
function renderAutosave(ref: RefObject<RovingEditorHandle>, blockId: string | null = 'BLOCK_1') {
  return renderHook((props: { blockId: string | null }) => useDraftAutosave(props.blockId, ref), {
    initialProps: { blockId },
  })
}

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
  // #2938 — the core inversion: typing (many `update` signals) must NOT
  // serialize per event; serialization happens only when the debounce fires.
  it('does NOT serialize per signal — only once when the debounce fires', () => {
    const { ref, state, getSpy } = makeEditor({ markdown: 'a' })
    const { result } = renderAutosave(ref)

    // Simulate a typing burst of many `update` signals within the debounce.
    for (const md of ['ab', 'abc', 'abcd', 'abcde']) {
      state.markdown = md
      act(() => {
        result.current.onContentChange()
      })
    }
    // No serialize and no save yet — the signal only (re)arms the timer.
    expect(getSpy).not.toHaveBeenCalled()
    expect(mockedSaveDraft).not.toHaveBeenCalled()

    // Idle pause → a SINGLE serialize + save of the final content.
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(getSpy).toHaveBeenCalledTimes(1)
    expect(mockedSaveDraft).toHaveBeenCalledTimes(1)
    expect(mockedSaveDraft).toHaveBeenCalledWith('BLOCK_1', 'abcde')
  })

  it('calls saveDraft after 2000ms debounce with correct args', () => {
    const { ref } = makeEditor({ markdown: 'hello world' })
    const { result } = renderAutosave(ref)
    act(() => {
      result.current.onContentChange()
    })

    expect(mockedSaveDraft).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(2000)
    })

    expect(mockedSaveDraft).toHaveBeenCalledTimes(1)
    expect(mockedSaveDraft).toHaveBeenCalledWith('BLOCK_1', 'hello world')
  })

  it('resets debounce on rapid content changes — only last content saved', () => {
    const { ref, state } = makeEditor({ markdown: 'first' })
    const { result } = renderAutosave(ref)
    act(() => {
      result.current.onContentChange()
    })

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(mockedSaveDraft).not.toHaveBeenCalled()

    state.markdown = 'second'
    act(() => {
      result.current.onContentChange()
    })

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    // Still shouldn't have fired — the timer was reset.
    expect(mockedSaveDraft).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    // Now the second timer fires and serializes the FINAL content.
    expect(mockedSaveDraft).toHaveBeenCalledTimes(1)
    expect(mockedSaveDraft).toHaveBeenCalledWith('BLOCK_1', 'second')
  })

  it('discardDraft cancels pending save and calls deleteDraft', () => {
    const { ref } = makeEditor({ markdown: 'some content' })
    const { result } = renderAutosave(ref)
    act(() => {
      result.current.onContentChange()
    })

    act(() => {
      result.current.discardDraft()
    })

    // Advance past debounce — saveDraft should NOT be called.
    act(() => {
      vi.advanceTimersByTime(3000)
    })

    expect(mockedSaveDraft).not.toHaveBeenCalled()
    expect(mockedDeleteDraft).toHaveBeenCalledTimes(1)
    expect(mockedDeleteDraft).toHaveBeenCalledWith('BLOCK_1')
  })

  it('version counter prevents stale save after discardDraft (race condition fix)', () => {
    const { ref, state } = makeEditor({ markdown: 'content' })
    const { result } = renderAutosave(ref)
    act(() => {
      result.current.onContentChange()
    })

    act(() => {
      result.current.discardDraft()
    })

    act(() => {
      vi.advanceTimersByTime(2000)
    })

    expect(mockedSaveDraft).not.toHaveBeenCalled()
    expect(mockedDeleteDraft).toHaveBeenCalledTimes(1)
    expect(mockedDeleteDraft).toHaveBeenCalledWith('BLOCK_1')

    // Now a fresh edit — new timer with a new version starts.
    mockedDeleteDraft.mockClear()
    state.markdown = 'new content after discard'
    act(() => {
      result.current.onContentChange()
    })

    act(() => {
      vi.advanceTimersByTime(2000)
    })

    expect(mockedSaveDraft).toHaveBeenCalledTimes(1)
    expect(mockedSaveDraft).toHaveBeenCalledWith('BLOCK_1', 'new content after discard')
  })

  it('flushes draft on unmount with block ID', async () => {
    const { ref } = makeEditor({ markdown: 'content' })
    const { result, unmount } = renderAutosave(ref)
    act(() => {
      result.current.onContentChange()
    })

    unmount()
    await flushMicrotasks()

    expect(mockedFlushDraft).toHaveBeenCalledTimes(1)
    expect(mockedFlushDraft).toHaveBeenCalledWith('BLOCK_1')
  })

  it('does not save when blockId is null', () => {
    const { ref } = makeEditor({ markdown: 'content' })
    const { result } = renderAutosave(ref, null)
    act(() => {
      result.current.onContentChange()
    })

    act(() => {
      vi.advanceTimersByTime(3000)
    })

    expect(mockedSaveDraft).not.toHaveBeenCalled()
    expect(mockedFlushDraft).not.toHaveBeenCalled()
  })

  it('does not save when content is empty', () => {
    const { ref } = makeEditor({ markdown: '' })
    const { result } = renderAutosave(ref)
    act(() => {
      result.current.onContentChange()
    })

    act(() => {
      vi.advanceTimersByTime(3000)
    })

    expect(mockedSaveDraft).not.toHaveBeenCalled()
  })

  // Issue #715 — the flush effect is keyed on `blockId` alone. Content changes
  // while the same block stays focused must never trigger a flush.
  describe('issue #715 — flush only on block change / unmount', () => {
    it('typing then idle produces exactly one trailing save and ZERO flushes', () => {
      const { ref, state } = makeEditor({ markdown: 'hello' })
      const { result } = renderAutosave(ref)

      state.markdown = 'hello'
      act(() => {
        result.current.onContentChange()
      })
      expect(mockedFlushDraft).not.toHaveBeenCalled()
      expect(mockedSaveDraft).not.toHaveBeenCalled()

      act(() => {
        vi.advanceTimersByTime(2000)
      })
      expect(mockedSaveDraft).toHaveBeenCalledTimes(1)
      expect(mockedSaveDraft).toHaveBeenCalledWith('BLOCK_1', 'hello')
      expect(mockedFlushDraft).not.toHaveBeenCalled()
    })

    it('pause past debounce (draft persists) then resume typing — still ZERO flushDraft', () => {
      const { ref, state } = makeEditor({ markdown: 'hello' })
      const { result } = renderAutosave(ref)
      act(() => {
        result.current.onContentChange()
      })

      // Pause >2s: debounced saveDraft persists the draft row.
      act(() => {
        vi.advanceTimersByTime(2500)
      })
      expect(mockedSaveDraft).toHaveBeenCalledTimes(1)
      expect(mockedSaveDraft).toHaveBeenCalledWith('BLOCK_1', 'hello')

      // Resume typing. Pre-fix, the first keystroke's cleanup flushed the
      // stale persisted draft as a real edit_block op mid-edit.
      state.markdown = 'hello w'
      act(() => {
        result.current.onContentChange()
      })
      state.markdown = 'hello wo'
      act(() => {
        result.current.onContentChange()
      })
      act(() => {
        vi.advanceTimersByTime(2000)
      })

      // The stale row is superseded by a later save — never flushed.
      expect(mockedSaveDraft).toHaveBeenCalledTimes(2)
      expect(mockedSaveDraft).toHaveBeenLastCalledWith('BLOCK_1', 'hello wo')
      expect(mockedFlushDraft).not.toHaveBeenCalled()
    })

    it('blockId change flushes exactly once, old block row untouched', async () => {
      const { ref, state } = makeEditor({ markdown: 'old block content' })
      const { result, rerender } = renderAutosave(ref)
      act(() => {
        result.current.onContentChange()
      })

      // Let the old block's debounced save land.
      act(() => {
        vi.advanceTimersByTime(2000)
      })
      expect(mockedSaveDraft).toHaveBeenLastCalledWith('BLOCK_1', 'old block content')
      mockedSaveDraft.mockClear()

      // Switch to BLOCK_2: the live editor now holds the new block's content.
      state.activeBlockId = 'BLOCK_2'
      state.markdown = 'new block content'
      rerender({ blockId: 'BLOCK_2' })
      await flushMicrotasks()

      // The OLD block's draft row must NOT be overwritten with the new text.
      expect(mockedSaveDraft).not.toHaveBeenCalledWith('BLOCK_1', 'new block content')
      // The OLD block is still flushed exactly once.
      expect(mockedFlushDraft).toHaveBeenCalledTimes(1)
      expect(mockedFlushDraft).toHaveBeenCalledWith('BLOCK_1')
    })

    it('blur then refocus SAME block (A → null → A) never flushes', async () => {
      const { ref, state } = makeEditor({ markdown: 'typed content' })
      const { result, rerender, unmount } = renderAutosave(ref)
      act(() => {
        result.current.onContentChange()
      })

      // Blur: EditableBlock passes null.
      rerender({ blockId: null })
      expect(mockedFlushDraft).not.toHaveBeenCalled()

      // Refocus same block; the null→A transition itself must not flush.
      rerender({ blockId: 'BLOCK_1' })
      state.markdown = 'typed more'
      act(() => {
        result.current.onContentChange()
      })
      expect(mockedFlushDraft).not.toHaveBeenCalled()

      // Blur again — the caller's blur handler owns the edit_block + discard,
      // so a flush here would race that delete.
      rerender({ blockId: null })
      expect(mockedFlushDraft).not.toHaveBeenCalled()

      // And unmounting after blur still must not flush.
      act(() => {
        vi.advanceTimersByTime(3000)
      })
      unmount()
      await flushMicrotasks()
      expect(mockedFlushDraft).not.toHaveBeenCalled()
    })
  })

  // Issue #1065 — discard-on-unmount race. A synchronous `discardedRef` marker
  // suppresses the unmount flush regardless of unmount-vs-blur ordering.
  describe('issue #1065 — discard suppresses unmount flush', () => {
    it('discardDraft then unmount WITHOUT re-rendering to null does NOT flush', async () => {
      const { ref } = makeEditor({ markdown: 'stale debounced content' })
      const { result, unmount } = renderAutosave(ref)
      act(() => {
        result.current.onContentChange()
      })

      // Discard (as the blur handler does) but stay focused — no re-render to
      // null. blockIdRef still holds BLOCK_1, so the null-ref guard alone would
      // NOT prevent the flush; the discarded marker must.
      act(() => {
        result.current.discardDraft()
      })

      unmount()
      await flushMicrotasks()

      expect(mockedFlushDraft).not.toHaveBeenCalled()
      expect(mockedDeleteDraft).toHaveBeenCalledTimes(1)
      expect(mockedDeleteDraft).toHaveBeenCalledWith('BLOCK_1')
    })

    it('a real edit after a discard re-enables the unmount flush (marker cleared)', async () => {
      const { ref, state } = makeEditor({ markdown: 'content' })
      const { result, unmount } = renderAutosave(ref)
      act(() => {
        result.current.onContentChange()
      })

      act(() => {
        result.current.discardDraft()
      })

      // Real edit after the discard: a fresh save clears the marker.
      state.markdown = 'real edit after discard'
      act(() => {
        result.current.onContentChange()
      })
      act(() => {
        vi.advanceTimersByTime(2000)
      })
      expect(mockedSaveDraft).toHaveBeenCalledTimes(1)
      expect(mockedSaveDraft).toHaveBeenCalledWith('BLOCK_1', 'real edit after discard')

      // Now an unmount-while-focused must flush again.
      unmount()
      await flushMicrotasks()
      expect(mockedFlushDraft).toHaveBeenCalledTimes(1)
      expect(mockedFlushDraft).toHaveBeenCalledWith('BLOCK_1')
    })
  })

  // Issue #770 gap 2 — unmount-while-focused must persist the LATEST live
  // content (serialized on demand), not just the ≤2s-stale debounced row.
  describe('issue #770 gap 2 — unmount-while-focused saves latest content', () => {
    it('serializes and persists live content via saveDraft before flushing on unmount', async () => {
      const { ref, state } = makeEditor({ markdown: 'hello' })
      const { result, unmount } = renderAutosave(ref)
      act(() => {
        result.current.onContentChange()
      })

      // Persist a debounced draft row at "hello".
      act(() => {
        vi.advanceTimersByTime(2000)
      })
      expect(mockedSaveDraft).toHaveBeenCalledTimes(1)
      expect(mockedSaveDraft).toHaveBeenLastCalledWith('BLOCK_1', 'hello')

      // Type more WITHOUT letting the debounce fire — this <2s window was lost
      // on unmount pre-fix.
      state.markdown = 'hello world'
      act(() => {
        result.current.onContentChange()
      })

      // Unmount while focused: cleanup serializes the live editor and saves it.
      unmount()
      await flushMicrotasks()

      expect(mockedSaveDraft).toHaveBeenLastCalledWith('BLOCK_1', 'hello world')
      expect(mockedFlushDraft).toHaveBeenCalledTimes(1)
      expect(mockedFlushDraft).toHaveBeenCalledWith('BLOCK_1')
    })

    it('unmount save respects #1065 (a discarded block is not resurrected)', async () => {
      const { ref } = makeEditor({ markdown: 'stale debounced content' })
      const { result, unmount } = renderAutosave(ref)
      act(() => {
        result.current.onContentChange()
      })

      act(() => {
        result.current.discardDraft()
      })
      mockedSaveDraft.mockClear()

      unmount()
      await flushMicrotasks()

      // The discarded marker suppresses BOTH the gap-2 final save and the flush.
      expect(mockedSaveDraft).not.toHaveBeenCalled()
      expect(mockedFlushDraft).not.toHaveBeenCalled()
    })
  })

  // Issue #770 gap 3 — emptying a block's text must discard the draft row so a
  // hard kill cannot resurrect old text at boot.
  describe('issue #770 gap 3 — emptying discards the draft row', () => {
    it('clearing typed text (non-empty → empty) discards the draft', () => {
      const { ref, state } = makeEditor({ markdown: 'hello' })
      const { result } = renderAutosave(ref)
      act(() => {
        result.current.onContentChange()
      })

      // Persist a draft row first.
      act(() => {
        vi.advanceTimersByTime(2000)
      })
      expect(mockedSaveDraft).toHaveBeenCalledTimes(1)

      // User clears the block.
      state.markdown = ''
      act(() => {
        result.current.onContentChange()
      })

      // The stale row is deleted (not left to resurrect at boot)...
      expect(mockedDeleteDraft).toHaveBeenCalledTimes(1)
      expect(mockedDeleteDraft).toHaveBeenCalledWith('BLOCK_1')

      // ...and no further save fires for the now-empty block.
      act(() => {
        vi.advanceTimersByTime(3000)
      })
      expect(mockedSaveDraft).toHaveBeenCalledTimes(1)
    })

    it('a block that merely STARTED empty does NOT discard', () => {
      const { ref } = makeEditor({ markdown: '' })
      const { result } = renderAutosave(ref)
      act(() => {
        result.current.onContentChange()
      })

      expect(mockedDeleteDraft).not.toHaveBeenCalled()
      expect(mockedSaveDraft).not.toHaveBeenCalled()
    })

    it('emptying then unmounting does NOT flush (discard marker set)', async () => {
      const { ref, state } = makeEditor({ markdown: 'hello' })
      const { result, unmount } = renderAutosave(ref)
      act(() => {
        result.current.onContentChange()
      })
      act(() => {
        vi.advanceTimersByTime(2000)
      })

      // Clear text, then unmount while focused.
      state.markdown = ''
      act(() => {
        result.current.onContentChange()
      })
      mockedSaveDraft.mockClear()
      unmount()
      await flushMicrotasks()

      // The clear marked BLOCK_1 discarded, so unmount cleanup neither saves
      // nor flushes stale content.
      expect(mockedSaveDraft).not.toHaveBeenCalled()
      expect(mockedFlushDraft).not.toHaveBeenCalled()
    })

    it('retyping after a clear re-enables saving (marker cleared on fresh save)', () => {
      const { ref, state } = makeEditor({ markdown: 'hello' })
      const { result } = renderAutosave(ref)
      act(() => {
        result.current.onContentChange()
      })
      act(() => {
        vi.advanceTimersByTime(2000)
      })

      state.markdown = ''
      act(() => {
        result.current.onContentChange()
      }) // clear → discard + marker
      expect(mockedDeleteDraft).toHaveBeenCalledTimes(1)

      // User types again; a fresh save must go through, clearing the marker.
      state.markdown = 'new text'
      act(() => {
        result.current.onContentChange()
      })
      act(() => {
        vi.advanceTimersByTime(2000)
      })
      expect(mockedSaveDraft).toHaveBeenLastCalledWith('BLOCK_1', 'new text')
    })
  })

  // Findings 2/48 — blur-path save failure must NOT destroy the draft row.
  describe('findings 2/48 — deferred delete keyed on save outcome', () => {
    it('keeps the row while the edit IPC is in flight, deletes on resolve(true)', async () => {
      const { ref } = makeEditor({ markdown: 'typed paragraph' })
      const { result } = renderAutosave(ref)

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

    it('keeps the row and re-saves failed content when the save resolves false', async () => {
      const { ref } = makeEditor({ markdown: 'typed paragraph' })
      const { result } = renderAutosave(ref)
      mockedSaveDraft.mockClear()

      act(() => {
        result.current.discardDraft(Promise.resolve(false), 'typed paragraph')
      })
      await flushMicrotasks()

      // Failed save: the draft row is the last surviving copy — it must NOT be
      // deleted, and the exact failed content is re-saved.
      expect(mockedDeleteDraft).not.toHaveBeenCalled()
      expect(mockedSaveDraft).toHaveBeenCalledTimes(1)
      expect(mockedSaveDraft).toHaveBeenCalledWith('BLOCK_1', 'typed paragraph')
    })

    it('treats a rejected save outcome as failure (keeps the row)', async () => {
      const { ref } = makeEditor({ markdown: 'typed paragraph' })
      const { result } = renderAutosave(ref)
      mockedSaveDraft.mockClear()

      act(() => {
        result.current.discardDraft(Promise.reject(new Error('escaped')), 'typed paragraph')
      })
      await flushMicrotasks()

      expect(mockedDeleteDraft).not.toHaveBeenCalled()
      expect(mockedSaveDraft).toHaveBeenCalledWith('BLOCK_1', 'typed paragraph')
    })

    it('does not delete when a newer debounced save has superseded the discard', async () => {
      const { ref, state } = makeEditor({ markdown: 'first text' })
      const { result } = renderAutosave(ref)

      let resolveOutcome: (ok: boolean) => void = () => {}
      const outcome = new Promise<boolean>((resolve) => {
        resolveOutcome = resolve
      })
      act(() => {
        result.current.discardDraft(outcome, 'first text')
      })

      // User refocuses the same block and types; a fresh debounced save writes
      // a NEW draft row that the late deleteDraft must not destroy.
      state.markdown = 'newer text'
      act(() => {
        result.current.onContentChange()
      })
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
      const { ref } = makeEditor({ markdown: 'content' })
      const { result } = renderAutosave(ref)

      act(() => {
        result.current.discardDraft()
      })

      expect(mockedDeleteDraft).toHaveBeenCalledTimes(1)
      expect(mockedDeleteDraft).toHaveBeenCalledWith('BLOCK_1')
    })
  })

  // Finding 3 — the debounced row is the ONLY crash/kill safety net, but a
  // trailing debounce can be missing or ~2s stale when the OS backgrounds then
  // kills the webview. Effect C serializes the live editor on demand at that
  // moment.
  describe('finding 3 — background/close flush of live content', () => {
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

    it('serializes and persists latest live content when the document becomes hidden', () => {
      const { ref, state } = makeEditor({ markdown: 'hello' })
      renderAutosave(ref)
      state.markdown = 'hello world'

      setVisibility('hidden')

      expect(mockedSaveDraft).toHaveBeenCalledTimes(1)
      expect(mockedSaveDraft).toHaveBeenCalledWith('BLOCK_1', 'hello world')
    })

    it('persists latest live content on pagehide', () => {
      const { ref, state } = makeEditor({ markdown: 'hello' })
      renderAutosave(ref)
      state.markdown = 'hello world'

      act(() => {
        window.dispatchEvent(new Event('pagehide'))
      })

      expect(mockedSaveDraft).toHaveBeenCalledTimes(1)
      expect(mockedSaveDraft).toHaveBeenCalledWith('BLOCK_1', 'hello world')
    })

    it('does not save empty content on hidden', () => {
      const { ref } = makeEditor({ markdown: '' })
      renderAutosave(ref)

      setVisibility('hidden')

      expect(mockedSaveDraft).not.toHaveBeenCalled()
    })

    it('does not save when no block is focused (blockId null)', () => {
      const { ref } = makeEditor({ markdown: 'stale content' })
      renderAutosave(ref, null)

      setVisibility('hidden')
      act(() => {
        window.dispatchEvent(new Event('pagehide'))
      })

      expect(mockedSaveDraft).not.toHaveBeenCalled()
    })

    it('does not save when the live editor switched to another block', () => {
      const { ref, state } = makeEditor({ markdown: 'hello world' })
      renderAutosave(ref)
      // Editor re-mounted elsewhere: the live doc no longer belongs to BLOCK_1.
      state.activeBlockId = 'OTHER'

      setVisibility('hidden')

      expect(mockedSaveDraft).not.toHaveBeenCalled()
    })
  })

  // Finding 3 (max-latency cap) — continuous typing resets the trailing
  // debounce on every keystroke; once a save has been pending longer than the
  // cap it fires immediately.
  describe('finding 3 — max-latency cap on the trailing debounce', () => {
    it('continuous typing (never pausing 2s) still persists a draft within the cap', () => {
      const { ref, state } = makeEditor({ markdown: 'c0' })
      const { result } = renderAutosave(ref)
      act(() => {
        result.current.onContentChange()
      })

      // Keystrokes every second — each one resets the 2s trailing debounce.
      for (let i = 1; i <= 4; i++) {
        act(() => {
          vi.advanceTimersByTime(1000)
        })
        state.markdown = `c${i}`
        act(() => {
          result.current.onContentChange()
        })
      }
      expect(mockedSaveDraft).not.toHaveBeenCalled()

      // The 5th keystroke lands at the 5s cap — the save fires immediately
      // instead of re-arming another 2s trailing window.
      act(() => {
        vi.advanceTimersByTime(1000)
      })
      state.markdown = 'c5'
      act(() => {
        result.current.onContentChange()
      })
      act(() => {
        vi.advanceTimersByTime(0)
      })

      expect(mockedSaveDraft).toHaveBeenCalledTimes(1)
      expect(mockedSaveDraft).toHaveBeenCalledWith('BLOCK_1', 'c5')
    })

    it('the cap window resets after a capped save (no immediate re-fire)', () => {
      const { ref, state } = makeEditor({ markdown: 'c0' })
      const { result } = renderAutosave(ref)
      act(() => {
        result.current.onContentChange()
      })

      for (let i = 1; i <= 5; i++) {
        act(() => {
          vi.advanceTimersByTime(1000)
        })
        state.markdown = `c${i}`
        act(() => {
          result.current.onContentChange()
        })
      }
      act(() => {
        vi.advanceTimersByTime(0)
      })
      expect(mockedSaveDraft).toHaveBeenCalledTimes(1)

      // Next keystroke starts a fresh run: an ordinary 2s trailing debounce.
      act(() => {
        vi.advanceTimersByTime(1000)
      })
      state.markdown = 'c6'
      act(() => {
        result.current.onContentChange()
      })
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

  // Issue #106 — autosave is the canonical `pool_busy` consumer.
  describe('issue #106 — pool_busy back-pressure', () => {
    it('retries saveDraft when the IPC rejects with kind="pool_busy"', async () => {
      mockedSaveDraft
        .mockRejectedValueOnce({ kind: 'pool_busy', message: 'pool exhausted' })
        .mockResolvedValueOnce({ status: 'ok', data: null })

      const { ref } = makeEditor({ markdown: 'content' })
      const { result } = renderAutosave(ref)
      act(() => {
        result.current.onContentChange()
      })

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000)
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200)
      })

      expect(mockedSaveDraft).toHaveBeenCalledTimes(2)
      expect(mockedSaveDraft).toHaveBeenNthCalledWith(1, 'BLOCK_1', 'content')
      expect(mockedSaveDraft).toHaveBeenNthCalledWith(2, 'BLOCK_1', 'content')
    })

    it('does NOT retry on kind="database" (existing log-only behaviour)', async () => {
      mockedSaveDraft.mockRejectedValue({ kind: 'database', message: 'syntax error' })

      const { ref } = makeEditor({ markdown: 'content' })
      const { result } = renderAutosave(ref)
      act(() => {
        result.current.onContentChange()
      })

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000)
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })

      expect(mockedSaveDraft).toHaveBeenCalledTimes(1)
    })
  })
})
