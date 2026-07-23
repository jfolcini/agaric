/**
 * #2914 — Enter on multi-block content must NOT race an unawaited `splitBlock`
 * against a parallel `createBelow`.
 *
 * Repro: paste multi-line content into a block, then press Enter with the caret
 * at the end. `handleEnterSave` falls to the LEGACY path, which calls
 * `handleFlush()` (a multi-block flush fires `splitBlock`, which creates the
 * trailing sibling blocks via its own chained `createBelow` calls) and THEN —
 * pre-fix — immediately `createBelow()`d an empty Enter block. The two
 * sibling-creation sequences each computed `siblingSlot` from their own
 * pre-await snapshot, racing on overlapping views (`splitInProgress` guards only
 * re-entrant `splitBlock`, not the concurrent create).
 *
 * The fix publishes the in-flight split (via `consumePendingSplit`) so
 * `handleEnterSave` AWAITS it and focuses the last block it produced, instead of
 * firing a parallel empty-block create. This test wires the REAL `useBlockFlush`
 * producer to the REAL `handleEnterSave` consumer over a REAL page-blocks store
 * (only `invoke` is mocked, and the REAL markdown serializer splits on `\n`), so
 * it exercises the actual coordination end-to-end.
 *
 * NOTE: deliberately does NOT mock `@/editor/markdown-serializer` — the real
 * parser must see `alpha\nbravo\ncharlie` as three blocks so both the flush's
 * `parse()` multi-block detector and the store's `planSplit` take the split path.
 */

import { invoke } from '@tauri-apps/api/core'
import { act, renderHook } from '@testing-library/react'
import type { TFunction } from 'i18next'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'

import { makeBlock } from '@/__tests__/fixtures'
import { useBlockActionOrchestration } from '@/components/block-tree/use-block-action-orchestration'
import { useBlockFlush } from '@/components/block-tree/use-block-flush'
import type { RovingEditorHandle } from '@/editor/use-roving-editor'
import { createPageBlockStore, type PageBlockState } from '@/stores/page-blocks'

const mockedInvoke = vi.mocked(invoke)

const t = ((key: string) => key) as unknown as TFunction

/** Minimal RovingEditorHandle that flushes `content` for `blockId`, caret-at-end. */
function makeHandle(blockId: string, content: string): RovingEditorHandle {
  return {
    editor: null,
    mount: vi.fn(),
    unmount: vi.fn(() => content),
    activeBlockId: blockId,
    getMarkdown: vi.fn(() => content),
    // null → handleEnterSave takes the LEGACY (flush + create) path.
    splitAtCaret: vi.fn(() => null),
    originalMarkdown: '',
    setOnUpdate: vi.fn(),
    markCommitted: vi.fn(),
  } as unknown as RovingEditorHandle
}

let store: StoreApi<PageBlockState>

beforeEach(() => {
  vi.clearAllMocks()
  store = createPageBlockStore('PAGE_1')
  store.setState({
    loading: false,
    blocks: [makeBlock({ id: 'A', parent_id: 'PAGE_1', content: 'alpha', position: 0 })],
  })
  // Backend echoes: edit_block echoes the sent text; create_block accepts the
  // client-minted id verbatim (#2849) and heals `position`.
  mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
    const a = (args ?? {}) as Record<string, unknown>
    if (cmd === 'edit_block') {
      return {
        id: a['blockId'],
        block_type: 'content',
        content: a['toText'],
        parent_id: 'PAGE_1',
        position: 0,
        deleted_at: null,
        op_refs: [],
      }
    }
    if (cmd === 'create_block') {
      return {
        id: a['blockId'],
        block_type: 'content',
        content: a['content'],
        parent_id: 'PAGE_1',
        position: 1,
        deleted_at: null,
        op_refs: [],
      }
    }
    return undefined
  })
})

describe('#2914 — Enter on multi-block content does not race splitBlock vs createBelow', () => {
  it('awaits the split, skips the extra empty createBelow, and focuses the last split block', async () => {
    const setFocused = vi.fn()
    const justCreatedBlockIds = { current: new Set<string>() }
    const handle = makeHandle('A', 'alpha\nbravo\ncharlie')
    const rovingRef = { current: handle as RovingEditorHandle | null }

    const { result } = renderHook(() => {
      const handleFlush = useBlockFlush({
        rovingEditorRef: rovingRef,
        edit: store.getState().edit,
        splitBlock: store.getState().splitBlock,
        rootParentId: 'PAGE_1',
        pageStore: store,
        t,
      })
      return useBlockActionOrchestration({
        focusedBlockId: 'A',
        collapsedVisible: store.getState().blocks,
        blocks: store.getState().blocks,
        rovingEditor: handle,
        setFocused,
        handleFlush,
        remove: store.getState().remove,
        moveBlocks: store.getState().moveBlocks,
        edit: store.getState().edit,
        indent: store.getState().indent,
        dedent: store.getState().dedent,
        moveUp: store.getState().moveUp,
        moveDown: store.getState().moveDown,
        createBelow: store.getState().createBelow,
        justCreatedBlockIds,
        discardDraft: vi.fn(),
        t,
      })
    })

    await act(async () => {
      await result.current.handleEnterSave()
    })

    const blocks = store.getState().blocks

    // Final structure is exactly the split's blocks in order — NO trailing empty
    // Enter block. (Pre-fix, the parallel empty createBelow added a 4th block.)
    expect(blocks.map((b) => b.content)).toEqual(['alpha', 'bravo', 'charlie'])

    // Non-tautology: the extra empty-block create was SKIPPED. Pre-fix,
    // `createBelow(focusedBlockId)` fired `create_block` with the default empty
    // content, so this assertion fails against the old racing code.
    expect(mockedInvoke).not.toHaveBeenCalledWith(
      'create_block',
      expect.objectContaining({ content: '' }),
    )

    // The split's own createBelow chain carried the real rest-lines.
    expect(mockedInvoke).toHaveBeenCalledWith(
      'create_block',
      expect.objectContaining({ content: 'bravo' }),
    )
    expect(mockedInvoke).toHaveBeenCalledWith(
      'create_block',
      expect.objectContaining({ content: 'charlie' }),
    )

    // Focus landed on the LAST split block — proving the split was AWAITED (its
    // id is only knowable after it resolves) rather than a racing empty block.
    const lastSplit = blocks.at(-1)
    expect(lastSplit?.content).toBe('charlie')
    expect(setFocused).toHaveBeenCalledTimes(1)
    expect(setFocused).toHaveBeenCalledWith(lastSplit?.id)

    // The content-bearing last block is NOT registered as an Escape-deletable
    // empty stub (parity with the caret-split path).
    expect(justCreatedBlockIds.current.size).toBe(0)
  })
})
