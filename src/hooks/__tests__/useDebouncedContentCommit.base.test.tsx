/**
 * #6533 — the idle commit names the text the editor started from, so the
 * backend can keep a peer's edit the editor never showed. After a commit the
 * baseline is the text sent, and the next commit starts from that.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RovingEditorHandle } from '@/editor/use-roving-editor'
import {
  CONTENT_COMMIT_DEBOUNCE_MS,
  useDebouncedContentCommit,
} from '@/hooks/useDebouncedContentCommit'

type Props = Parameters<typeof useDebouncedContentCommit>[0]

function makeHandle(stored: string, markdown: string) {
  const state = { stored, markdown }
  const handle = {
    activeBlockId: 'B1',
    getMarkdown: () => state.markdown,
    get originalMarkdown() {
      return state.stored
    },
    get storedMarkdown() {
      return state.stored
    },
    markCommitted: (md: string) => {
      state.stored = md
    },
  } as unknown as RovingEditorHandle
  return { handle, state }
}

describe('useDebouncedContentCommit base text (#6533)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends the stored text as the base, then the text it committed', async () => {
    const { handle, state } = makeHandle('stored', 'stored one')
    const edit = vi.fn<Props['edit']>().mockResolvedValue(true)
    const { result } = renderHook(() =>
      useDebouncedContentCommit({
        isFocused: true,
        blockId: 'B1',
        rovingEditorRef: { current: handle },
        edit,
      }),
    )
    const commit = async () => {
      act(() => result.current.schedule())
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONTENT_COMMIT_DEBOUNCE_MS)
      })
    }

    await commit()
    state.markdown = 'stored one two'
    await commit()

    expect(edit.mock.calls).toEqual([
      ['B1', 'stored one', { baseText: 'stored' }],
      ['B1', 'stored one two', { baseText: 'stored one' }],
    ])
  })
})
