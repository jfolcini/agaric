// #6971 — Undo of a tag rename on the tag's page also undoes its page
// `Tag/x`'s rename (#6755), an op of another page. The tag's page counts only
// its own op toward the positional depth, so once the session stack is spent
// the next Ctrl+Z reaches the op before the rename. Runs against the REAL
// tauri-mock dispatch and the REAL undo store.
import type { InvokeArgs } from '@tauri-apps/api/core'
import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { BlockRow, OpRef } from '@/lib/bindings'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { blocks, SEED_IDS, seedBlocks } from '@/lib/tauri-mock/seed'
import { useSpaceStore } from '@/stores/space'
import { useUndoStore } from '@/stores/undo'

const mockedInvoke = vi.mocked(invoke)

const SCOPE = { kind: 'active', space_id: SEED_IDS.SPACE_PERSONAL }

function rename(id: string, toText: string): OpRef[] {
  return (dispatch('edit_block', { blockId: id, toText, baseText: null }) as { op_refs: OpRef[] })
    .op_refs
}

function contentOf(id: string): unknown {
  return blocks.get(id)?.['content']
}

describe('undo of a tag rename on the tag page (#6971)', () => {
  beforeEach(() => {
    seedBlocks()
    useSpaceStore.setState({ currentSpaceId: SEED_IDS.SPACE_PERSONAL })
    useUndoStore.setState({ pages: new Map() })
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args))
  })

  it('counts only the tag page op, so positional undo reaches the op before the rename', async () => {
    const tag = (
      dispatch('create_block', {
        blockType: 'tag',
        content: 'a',
        parentId: null,
        position: null,
        scope: SCOPE,
      }) as BlockRow
    ).id
    // The op before the rename on the tag's page: a rename with no page yet.
    expect(rename(tag, 'book')).toHaveLength(1)
    const page = (dispatch('create_tag_page', { tagId: tag }) as BlockRow).id

    const refs = rename(tag, 'reading')
    expect(refs).toHaveLength(2)
    useUndoStore.getState().onNewAction(tag, refs)

    await useUndoStore.getState().undo(tag)
    expect(contentOf(tag)).toBe('book')
    expect(contentOf(page)).toBe('Tag/book')
    expect(useUndoStore.getState().pages.get(tag)?.undoDepth).toBe(1)

    // The session stack is spent: this Ctrl+Z is positional.
    await useUndoStore.getState().undo(tag)
    expect(contentOf(tag)).toBe('a')
  })

  it('redo gives back only the tag page op', async () => {
    const tag = (
      dispatch('create_block', {
        blockType: 'tag',
        content: 'book',
        parentId: null,
        position: null,
        scope: SCOPE,
      }) as BlockRow
    ).id
    const page = (dispatch('create_tag_page', { tagId: tag }) as BlockRow).id
    useUndoStore.getState().onNewAction(tag, rename(tag, 'reading'))

    await useUndoStore.getState().undo(tag)
    await useUndoStore.getState().redo(tag)

    expect(contentOf(tag)).toBe('reading')
    expect(contentOf(page)).toBe('Tag/reading')
    expect(useUndoStore.getState().pages.get(tag)?.undoDepth).toBe(0)
  })
})
