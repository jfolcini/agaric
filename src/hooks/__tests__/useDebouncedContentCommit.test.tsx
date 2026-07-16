import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RovingEditorHandle } from '@/editor/use-roving-editor'
import {
  CONTENT_COMMIT_DEBOUNCE_MS,
  useDebouncedContentCommit,
} from '@/hooks/useDebouncedContentCommit'

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
    setOnMarkdownChange: vi.fn(),
  } as unknown as RovingEditorHandle
  return { handle, state, markCommitted }
}

type Props = Parameters<typeof useDebouncedContentCommit>[0]

describe('useDebouncedContentCommit (#2600)', () => {
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

    renderHook(() =>
      useDebouncedContentCommit({
        isFocused: true,
        blockId: 'B1',
        liveContent: 'hello',
        rovingEditorRef,
        edit,
      }),
    )

    expect(edit).not.toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONTENT_COMMIT_DEBOUNCE_MS)
    })

    expect(edit).toHaveBeenCalledExactlyOnceWith('B1', 'hello')
    expect(markCommitted).toHaveBeenCalledExactlyOnceWith('hello')
    expect(state.original).toBe('hello')
  })

  it('collapses a typing burst into ONE trailing commit', async () => {
    const { handle, state } = makeHandle({ activeBlockId: 'B1', markdown: 'a', original: '' })
    const edit = vi.fn<Props['edit']>().mockResolvedValue(true)
    const rovingEditorRef = { current: handle }

    const { rerender } = renderHook((props: Props) => useDebouncedContentCommit(props), {
      initialProps: {
        isFocused: true,
        blockId: 'B1',
        liveContent: 'a',
        rovingEditorRef,
        edit,
      } satisfies Props,
    })

    // Three keystrokes, each < debounce apart: the timer keeps resetting.
    for (const md of ['ab', 'abc', 'abcd']) {
      state.markdown = md
      rerender({ isFocused: true, blockId: 'B1', liveContent: md, rovingEditorRef, edit })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONTENT_COMMIT_DEBOUNCE_MS - 100)
      })
    }
    expect(edit).not.toHaveBeenCalled()

    // Idle pause → the single trailing commit fires with the FINAL content.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONTENT_COMMIT_DEBOUNCE_MS)
    })
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

    renderHook(() =>
      useDebouncedContentCommit({
        isFocused: true,
        blockId: 'B1',
        liveContent: 'same',
        rovingEditorRef,
        edit,
      }),
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONTENT_COMMIT_DEBOUNCE_MS)
    })

    expect(edit).not.toHaveBeenCalled()
    expect(markCommitted).not.toHaveBeenCalled()
  })

  it('does not commit when the active block switched away (stale fire)', async () => {
    const { handle } = makeHandle({ activeBlockId: 'OTHER', markdown: 'x', original: '' })
    const edit = vi.fn<Props['edit']>().mockResolvedValue(true)
    const rovingEditorRef = { current: handle }

    renderHook(() =>
      useDebouncedContentCommit({
        isFocused: true,
        blockId: 'B1',
        liveContent: 'x',
        rovingEditorRef,
        edit,
      }),
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONTENT_COMMIT_DEBOUNCE_MS)
    })

    expect(edit).not.toHaveBeenCalled()
  })

  it('does not schedule a commit while unfocused', async () => {
    const { handle } = makeHandle({ activeBlockId: 'B1', markdown: 'x', original: '' })
    const edit = vi.fn<Props['edit']>().mockResolvedValue(true)
    const rovingEditorRef = { current: handle }

    renderHook(() =>
      useDebouncedContentCommit({
        isFocused: false,
        blockId: 'B1',
        liveContent: 'x',
        rovingEditorRef,
        edit,
      }),
    )
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

    renderHook(() =>
      useDebouncedContentCommit({
        isFocused: true,
        blockId: 'B1',
        liveContent: 'typed',
        rovingEditorRef,
        edit,
      }),
    )
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

    renderHook(() =>
      useDebouncedContentCommit({
        isFocused: true,
        blockId: 'B1',
        liveContent: 'typed',
        rovingEditorRef,
        edit,
      }),
    )
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
})
