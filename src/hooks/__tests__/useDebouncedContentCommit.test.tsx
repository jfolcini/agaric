import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RovingEditorHandle } from '@/editor/use-roving-editor'
import {
  CONTENT_COMMIT_DEBOUNCE_MS,
  useDebouncedContentCommit,
} from '@/hooks/useDebouncedContentCommit'
import { flushActiveDraft } from '@/lib/active-draft-flush'

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

/**
 * A controllable roving-editor handle mock. `state.markdown` is what
 * `getMarkdown()` returns at fire time (simulating the live editor content);
 * `markCommitted(md)` rebases `state.original` just like the real handle.
 */
function makeHandle(init: { activeBlockId: string | null; markdown: string; original: string }) {
  const state = { ...init }
  const markCommitted = vi.fn((md: string) => {
    state.original = md
  })
  const handle = {
    get activeBlockId() {
      return state.activeBlockId
    },
    getMarkdown: () => state.markdown,
    get originalMarkdown() {
      return state.original
    },
    markCommitted,
    // Unused by the hook but required by the type.
    editor: null,
    mount: vi.fn(),
    unmount: vi.fn(() => null),
    splitAtCaret: vi.fn(() => null),
    setOnUpdate: vi.fn(),
  } as unknown as RovingEditorHandle
  return { handle, state, markCommitted }
}

type Props = Parameters<typeof useDebouncedContentCommit>[0]

/**
 * #2938 — the hook no longer takes a `liveContent` prop: it returns an
 * imperative `schedule()` that EditableBlock calls from the editor's `update`
 * change signal (no serialize, no React state). Each test arms the debounce by
 * calling `schedule()`; the commit re-reads `state.markdown` at fire time.
 */
function renderCommit(props: Props) {
  return renderHook((p: Props) => useDebouncedContentCommit(p), { initialProps: props })
}

describe('useDebouncedContentCommit (#2600 / #2938)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('commits the current markdown after the idle debounce and rebases the baseline', async () => {
    const { handle, markCommitted, state } = makeHandle({
      activeBlockId: 'B1',
      markdown: 'hello',
      original: 'h',
    })
    const edit = vi.fn<Props['edit']>().mockResolvedValue(true)
    const rovingEditorRef = { current: handle }

    const { result } = renderCommit({
      isFocused: true,
      blockId: 'B1',
      rovingEditorRef,
      edit,
    })

    act(() => result.current.schedule())
    expect(edit).not.toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONTENT_COMMIT_DEBOUNCE_MS)
    })

    expect(edit).toHaveBeenCalledExactlyOnceWith('B1', 'hello')
    expect(markCommitted).toHaveBeenCalledExactlyOnceWith('hello')
    expect(state.original).toBe('hello')
  })

  it('serializes ONLY at fire time — many schedule() signals do not re-read the editor per signal', async () => {
    const { handle, state } = makeHandle({ activeBlockId: 'B1', markdown: 'a', original: '' })
    const getSpy = vi.spyOn(handle, 'getMarkdown')
    const edit = vi.fn<Props['edit']>().mockResolvedValue(true)
    const rovingEditorRef = { current: handle }

    const { result } = renderCommit({ isFocused: true, blockId: 'B1', rovingEditorRef, edit })

    // Simulate a typing burst: many signals, timer keeps resetting.
    for (const md of ['ab', 'abc', 'abcd']) {
      state.markdown = md
      act(() => result.current.schedule())
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONTENT_COMMIT_DEBOUNCE_MS - 100)
      })
    }
    // No serialize happened per signal, and no commit yet.
    expect(getSpy).not.toHaveBeenCalled()
    expect(edit).not.toHaveBeenCalled()

    // Idle pause → ONE trailing commit that serializes the FINAL content once.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONTENT_COMMIT_DEBOUNCE_MS)
    })
    expect(getSpy).toHaveBeenCalledTimes(1)
    expect(edit).toHaveBeenCalledExactlyOnceWith('B1', 'abcd')
  })

  it('does not commit when the content is unchanged since the last commit', async () => {
    const { handle, markCommitted } = makeHandle({
      activeBlockId: 'B1',
      markdown: 'same',
      original: 'same',
    })
    const edit = vi.fn<Props['edit']>().mockResolvedValue(true)
    const rovingEditorRef = { current: handle }

    const { result } = renderCommit({ isFocused: true, blockId: 'B1', rovingEditorRef, edit })
    act(() => result.current.schedule())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONTENT_COMMIT_DEBOUNCE_MS)
    })

    expect(edit).not.toHaveBeenCalled()
    expect(markCommitted).not.toHaveBeenCalled()
  })

  it('defers to the flush parser while an inline `key:: value` property line is present (#2675)', async () => {
    const { handle, markCommitted, state } = makeHandle({
      activeBlockId: 'B1',
      markdown: 'context:: home',
      original: '',
    })
    const edit = vi.fn<Props['edit']>().mockResolvedValue(true)
    const rovingEditorRef = { current: handle }

    const { result } = renderCommit({ isFocused: true, blockId: 'B1', rovingEditorRef, edit })
    act(() => result.current.schedule())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONTENT_COMMIT_DEBOUNCE_MS)
    })

    expect(edit).not.toHaveBeenCalled()
    expect(markCommitted).not.toHaveBeenCalled()
    expect(state.original).toBe('')
  })

  it('still commits `::`-bearing text that is NOT a property line (#2675)', async () => {
    const { handle, markCommitted } = makeHandle({
      activeBlockId: 'B1',
      markdown: 'use std::vector<int> here',
      original: '',
    })
    const edit = vi.fn<Props['edit']>().mockResolvedValue(true)
    const rovingEditorRef = { current: handle }

    const { result } = renderCommit({ isFocused: true, blockId: 'B1', rovingEditorRef, edit })
    act(() => result.current.schedule())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONTENT_COMMIT_DEBOUNCE_MS)
    })

    expect(edit).toHaveBeenCalledExactlyOnceWith('B1', 'use std::vector<int> here')
    expect(markCommitted).toHaveBeenCalledExactlyOnceWith('use std::vector<int> here')
  })

  it('does not commit when the active block switched away (stale fire)', async () => {
    const { handle } = makeHandle({ activeBlockId: 'OTHER', markdown: 'x', original: '' })
    const edit = vi.fn<Props['edit']>().mockResolvedValue(true)
    const rovingEditorRef = { current: handle }

    const { result } = renderCommit({ isFocused: true, blockId: 'B1', rovingEditorRef, edit })
    act(() => result.current.schedule())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONTENT_COMMIT_DEBOUNCE_MS)
    })

    expect(edit).not.toHaveBeenCalled()
  })

  it('does not commit while unfocused — schedule() is a no-op', async () => {
    const { handle } = makeHandle({ activeBlockId: 'B1', markdown: 'x', original: '' })
    const edit = vi.fn<Props['edit']>().mockResolvedValue(true)
    const rovingEditorRef = { current: handle }

    const { result } = renderCommit({ isFocused: false, blockId: 'B1', rovingEditorRef, edit })
    act(() => result.current.schedule())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONTENT_COMMIT_DEBOUNCE_MS * 3)
    })

    expect(edit).not.toHaveBeenCalled()
  })

  it('leaves the baseline untouched when the commit fails, so blur retries the change', async () => {
    const { handle, markCommitted, state } = makeHandle({
      activeBlockId: 'B1',
      markdown: 'typed',
      original: 'base',
    })
    const edit = vi.fn<Props['edit']>().mockResolvedValue(false)
    const rovingEditorRef = { current: handle }

    const { result } = renderCommit({ isFocused: true, blockId: 'B1', rovingEditorRef, edit })
    act(() => result.current.schedule())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONTENT_COMMIT_DEBOUNCE_MS)
    })

    expect(edit).toHaveBeenCalledExactlyOnceWith('B1', 'typed')
    // The baseline is rebased ONLY on success — a failed commit leaves it at
    // 'base' so the eventual blur unmount() still sees a delta and re-commits.
    expect(markCommitted).not.toHaveBeenCalled()
    expect(state.original).toBe('base')
  })

  it('does not rebase the baseline if the block switched away before the commit resolved', async () => {
    const { handle, markCommitted, state } = makeHandle({
      activeBlockId: 'B1',
      markdown: 'typed',
      original: 'base',
    })
    let resolveEdit: (ok: boolean) => void = () => {}
    const edit = vi.fn<Props['edit']>().mockReturnValue(
      new Promise<boolean>((res) => {
        resolveEdit = res
      }),
    )
    const rovingEditorRef = { current: handle }

    const { result } = renderCommit({ isFocused: true, blockId: 'B1', rovingEditorRef, edit })
    act(() => result.current.schedule())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONTENT_COMMIT_DEBOUNCE_MS)
    })
    expect(edit).toHaveBeenCalledExactlyOnceWith('B1', 'typed')

    // Block switches away, THEN the in-flight commit resolves successfully.
    state.activeBlockId = 'OTHER'
    await act(async () => {
      resolveEdit(true)
      await Promise.resolve()
    })

    // Must NOT stamp the now-different block's baseline.
    expect(markCommitted).not.toHaveBeenCalled()
    expect(state.original).toBe('base')
  })

  // #2969 — while focused, the hook registers an on-demand "flush this
  // block's pending debounced commit right now" callback in
  // `active-draft-flush.ts`, so export entry points outside the editor's
  // component subtree can force out just-typed content before reading it.
  it('flushes the pending commit immediately (and cancels the timer) when flushActiveDraft is called', async () => {
    const { handle, markCommitted, state } = makeHandle({
      activeBlockId: 'B1',
      markdown: 'typed but not yet idle',
      original: 'base',
    })
    const edit = vi.fn<Props['edit']>().mockResolvedValue(true)
    const rovingEditorRef = { current: handle }

    const { result } = renderCommit({ isFocused: true, blockId: 'B1', rovingEditorRef, edit })

    // Arm the debounce, then advance well within the window — no commit yet.
    act(() => result.current.schedule())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONTENT_COMMIT_DEBOUNCE_MS - 100)
    })
    expect(edit).not.toHaveBeenCalled()

    // The export path's on-demand flush commits immediately.
    await act(async () => {
      await flushActiveDraft()
    })
    expect(edit).toHaveBeenCalledExactlyOnceWith('B1', 'typed but not yet idle')
    expect(markCommitted).toHaveBeenCalledExactlyOnceWith('typed but not yet idle')
    expect(state.original).toBe('typed but not yet idle')

    // The cancelled debounce timer must not ALSO fire a duplicate commit.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONTENT_COMMIT_DEBOUNCE_MS)
    })
    expect(edit).toHaveBeenCalledTimes(1)
  })

  it('does not schedule a flush registration while unfocused, so flushActiveDraft is a no-op', async () => {
    const { handle } = makeHandle({ activeBlockId: 'B1', markdown: 'x', original: '' })
    const edit = vi.fn<Props['edit']>().mockResolvedValue(true)
    const rovingEditorRef = { current: handle }

    renderCommit({ isFocused: false, blockId: 'B1', rovingEditorRef, edit })

    await act(async () => {
      await flushActiveDraft()
    })
    expect(edit).not.toHaveBeenCalled()
  })

  it('unregisters its flush on unmount, so a later flushActiveDraft call is a no-op', async () => {
    const { handle } = makeHandle({
      activeBlockId: 'B1',
      markdown: 'typed',
      original: 'base',
    })
    const edit = vi.fn<Props['edit']>().mockResolvedValue(true)
    const rovingEditorRef = { current: handle }

    const { unmount } = renderCommit({ isFocused: true, blockId: 'B1', rovingEditorRef, edit })

    unmount()

    await act(async () => {
      await flushActiveDraft()
    })
    expect(edit).not.toHaveBeenCalled()
  })
})
