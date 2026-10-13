/**
 * #4729 Part 1 — the drop-on-blur predicate for leaked empty blocks.
 *
 * The vault that motivated the issue exercises NONE of guards 3-6: all 508 of
 * its empty content blocks have no children, no metadata, no properties, no
 * tags and no inbound references. So every guard here is a case the tests must
 * CONSTRUCT — the data will never produce it — and each one asserts the block
 * SURVIVES. Every guard test below has been shown to go red when (and only
 * when) its own guard is deleted from `empty-block-cleanup.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetProperties = vi.fn()
const mockListTagsForBlock = vi.fn()
const mockListAttachments = vi.fn()
const mockGetBacklinks = vi.fn()

vi.mock('@/lib/bindings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bindings')>()
  return {
    ...actual,
    commands: {
      ...actual.commands,
      getProperties: (...args: unknown[]) =>
        mockGetProperties(...args).then((data: unknown) => ({ status: 'ok', data })),
      listTagsForBlock: (...args: unknown[]) =>
        mockListTagsForBlock(...args).then((data: unknown) => ({ status: 'ok', data })),
      listAttachments: (...args: unknown[]) =>
        mockListAttachments(...args).then((data: unknown) => ({ status: 'ok', data })),
      getBacklinks: (...args: unknown[]) =>
        mockGetBacklinks(...args).then((data: unknown) => ({ status: 'ok', data })),
    },
  }
})

import { invoke } from '@tauri-apps/api/core'

import { makeBlockRow, makePropertyRow, withOps } from '@/__tests__/fixtures'
import { deferred, mockInvokeCommands } from '@/__tests__/helpers/invoke'
import type { AttachmentRow } from '@/lib/bindings'
import { deleteBlockIfLeakedEmpty, isLeakedEmptyCandidate } from '@/lib/empty-block-cleanup'
import type { FlatBlock } from '@/lib/tree-utils'
import { runUnmountFlush } from '@/lib/unmount-flush'
import { useSpaceStore } from '@/stores/space'

function makeBlock(over: Partial<FlatBlock> & { id: string }): FlatBlock {
  return {
    block_type: 'content',
    content: '',
    parent_id: null,
    position: 0,
    deleted_at: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    page_id: 'PAGE',
    depth: 0,
    ...over,
  }
}

/** A page holding one real block and one blank leaked block after it. */
function leakedPage(over: Partial<FlatBlock> = {}): FlatBlock[] {
  return [
    makeBlock({ id: 'REAL', content: 'real content', position: 0 }),
    makeBlock({ id: 'EMPTY', content: '   ', position: 1, ...over }),
  ]
}

/** Run the full blur-time decision over `blocks`, returning the remove spy. */
async function runCleanup(
  blocks: FlatBlock[],
  opts: {
    blockId?: string
    zoomedBlockId?: string | null
    focusedBlockId?: string | null
    truncated?: boolean
  } = {},
) {
  const remove = vi.fn<(blockId: string, options?: { undoable?: boolean }) => Promise<void>>(
    async () => {},
  )
  const blockId = opts.blockId ?? 'EMPTY'
  const deleted = await deleteBlockIfLeakedEmpty({
    blockId,
    zoomedBlockId: opts.zoomedBlockId ?? null,
    spaceId: useSpaceStore.getState().currentSpaceId,
    remove,
    readBlocks: () => blocks,
    isPageTruncated: () => opts.truncated ?? false,
    isStillBlurred: () => (opts.focusedBlockId ?? null) !== blockId,
  })
  return { remove, deleted }
}

beforeEach(() => {
  // #5415 — the backlink probe carries the active space.
  useSpaceStore.setState({ currentSpaceId: 'SPACE_1' })
  // Default: the block carries nothing. Each guard test overrides one probe.
  mockGetProperties.mockReset().mockResolvedValue([])
  mockListTagsForBlock.mockReset().mockResolvedValue([])
  mockListAttachments.mockReset().mockResolvedValue([])
  mockGetBacklinks.mockReset().mockResolvedValue({ items: [], next_cursor: null })
})

// =========================================================================
// The behaviour the issue asks for
// =========================================================================

describe('a leaked empty block', () => {
  it('is deleted when it loses focus', async () => {
    const { remove, deleted } = await runCleanup(leakedPage())
    expect(deleted).toBe(true)
    expect(remove).toHaveBeenCalledWith('EMPTY', { undoable: false })
  })

  it('is deleted through the passed-in remove action, not by any other route', async () => {
    // The op-emitting store action is the ONLY way out. If this module ever
    // reached for `commands.deleteBlock` (or poked the store) directly, the
    // `blocks` projection would diverge from `loro_doc_state` + the op log and
    // the delete would be reverted or conflict on the next sync.
    const { remove } = await runCleanup(leakedPage())
    expect(remove).toHaveBeenCalledTimes(1)
    expect(remove.mock.calls[0]).toEqual(['EMPTY', { undoable: false }])
  })

  it('is deleted as HOUSEKEEPING — the delete does not take the user’s undo slot', async () => {
    // #4729 follow-up. The user clicked away from a blank block; they did not
    // ask for a delete. Routing it through the normal undo notification made
    // it the top undo entry, so their next Ctrl+Z reverted an invisible
    // cleanup instead of their own last action — and `onNewAction` also clears
    // the redo stack, so it ate a pending Ctrl+Y too. `{ undoable: false }` is
    // the whole of the difference: the `DeleteBlock` op is still appended, the
    // row is still soft-deleted, it still syncs, and it is still recoverable
    // from Trash. The store-side pair of this assertion (suppressed here,
    // still notified for a user-initiated delete) lives in
    // `page-blocks.undo-registry.test.ts`.
    const { remove, deleted } = await runCleanup(leakedPage())
    expect(deleted).toBe(true)
    const options = remove.mock.calls[0]?.[1]
    expect(options).toEqual({ undoable: false })
  })

  it('is deleted even when it is stranded between two non-empty blocks', async () => {
    // 106 of the vault's empties are exactly this shape — real content on both
    // sides, so "it is where the cursor was" cannot explain them.
    const blocks = [
      makeBlock({ id: 'A', content: 'before', position: 0 }),
      makeBlock({ id: 'EMPTY', content: '', position: 1 }),
      makeBlock({ id: 'B', content: 'after', position: 2 }),
    ]
    const { remove } = await runCleanup(blocks)
    expect(remove).toHaveBeenCalledWith('EMPTY', { undoable: false })
  })

  it('survives when it still has text', async () => {
    const { remove } = await runCleanup(leakedPage({ content: 'typed' }))
    expect(remove).not.toHaveBeenCalled()
  })
})

// =========================================================================
// One test per guard. Each asserts the block SURVIVES.
// =========================================================================

describe('guard — has children', () => {
  it('survives: a blank parent is an outline node, and delete_block cascades', async () => {
    const blocks = [
      makeBlock({ id: 'EMPTY', content: '', position: 0, depth: 0 }),
      makeBlock({ id: 'CHILD', content: 'a real child', parent_id: 'EMPTY', depth: 1 }),
    ]
    const { remove } = await runCleanup(blocks)
    expect(remove).not.toHaveBeenCalled()
  })
})

describe('guard — carries task/date metadata', () => {
  it('survives: a block with a due date and no text is a real task', async () => {
    const { remove } = await runCleanup(leakedPage({ due_date: '2026-09-06' }))
    expect(remove).not.toHaveBeenCalled()
  })

  it('survives: scheduled_date, todo_state and priority hold it too', async () => {
    for (const field of [
      { scheduled_date: '2026-09-06' },
      { todo_state: 'TODO' },
      { priority: 'A' },
    ]) {
      const { remove } = await runCleanup(leakedPage(field))
      expect(remove, JSON.stringify(field)).not.toHaveBeenCalled()
    }
  })
})

describe('guard — has a block property', () => {
  it('survives: a `key:: value` row is meaning with no text', async () => {
    mockGetProperties.mockResolvedValue([
      {
        key: 'status',
        value_text: 'blocked',
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
      },
    ])
    const { remove } = await runCleanup(leakedPage())
    expect(remove).not.toHaveBeenCalled()
  })
})

describe('guard — has a tag', () => {
  it('survives: a tag can be attached without any content text', async () => {
    mockListTagsForBlock.mockResolvedValue(['01TAG00000000000000000000'])
    const { remove } = await runCleanup(leakedPage())
    expect(remove).not.toHaveBeenCalled()
  })
})

describe('guard — has an attachment', () => {
  const attachment: AttachmentRow = {
    id: 'ATT',
    block_id: 'EMPTY',
    mime_type: 'audio/webm',
    filename: 'voice-note.webm',
    size_bytes: 2048,
    fs_path: 'attachments/ATT.webm',
    created_at: 1_735_689_600_000,
  }

  it('survives while it holds an attachment, and is cleaned up once that is deleted', async () => {
    // `/attach` or a file drop into a blank block leaves no text: the
    // attachment IS the content (#5412).
    let attachments = [attachment]
    mockListAttachments.mockImplementation(async (blockId: string) =>
      blockId === 'EMPTY' ? attachments : [],
    )
    const kept = await runCleanup(leakedPage())
    expect(kept.remove).not.toHaveBeenCalled()

    attachments = []
    const cleaned = await runCleanup(leakedPage())
    expect(cleaned.remove).toHaveBeenCalledWith('EMPTY', { undoable: false })
  })

  it('keeps the block when the attachment probe fails', async () => {
    mockListAttachments.mockRejectedValue(new Error('pool busy'))
    const { remove, deleted } = await runCleanup(leakedPage())
    expect(deleted).toBe(false)
    expect(remove).not.toHaveBeenCalled()
  })
})

describe('guard — referenced by another block', () => {
  it('survives: deleting it would break an ((id)) ref or a [[id]] link', async () => {
    mockGetBacklinks.mockResolvedValue({
      items: [makeBlock({ id: 'SOURCE', content: 'see ((EMPTY))' })],
      next_cursor: null,
    })
    const { remove } = await runCleanup(leakedPage())
    expect(remove).not.toHaveBeenCalled()
  })

  it('asks the backlink index in the active space — links never cross spaces', async () => {
    await runCleanup(leakedPage())
    expect(mockGetBacklinks).toHaveBeenCalledWith('EMPTY', null, 1, {
      kind: 'active',
      space_id: 'SPACE_1',
    })
  })

  // #5415 — no active space is an unknown answer, and an unknown answer never
  // authorises a delete.
  it('survives when no space is active: the probe is not even sent', async () => {
    useSpaceStore.setState({ currentSpaceId: null })
    const { remove } = await runCleanup(leakedPage())
    expect(remove).not.toHaveBeenCalled()
    expect(mockGetBacklinks).not.toHaveBeenCalled()
  })
})

describe('guard — last remaining block of its page', () => {
  it('survives: a page with nothing to click into is worse than a stray empty', async () => {
    const blocks = [makeBlock({ id: 'EMPTY', content: '' })]
    const { remove } = await runCleanup(blocks)
    expect(remove).not.toHaveBeenCalled()
  })

  it('survives: the last block of the ZOOMED pane, which would just be re-seeded', async () => {
    // `useBlockZoomEmptySeed` mints an empty child under a zoomed leaf so the
    // pane is typable, and re-arms whenever the root becomes a leaf again.
    // Deleting the seed on blur would churn a delete op + a create op per
    // click-away for no visible change.
    const blocks = [
      makeBlock({ id: 'OTHER', content: 'elsewhere on the page', position: 0, depth: 0 }),
      makeBlock({ id: 'ZOOMROOT', content: 'zoom root', position: 1, depth: 0 }),
      makeBlock({ id: 'EMPTY', content: '', parent_id: 'ZOOMROOT', depth: 1 }),
    ]
    const { remove } = await runCleanup(blocks, { zoomedBlockId: 'ZOOMROOT' })
    expect(remove).not.toHaveBeenCalled()
  })

  it('still deletes a blank pane sibling when the pane keeps another block', async () => {
    const blocks = [
      makeBlock({ id: 'ZOOMROOT', content: 'zoom root', position: 0, depth: 0 }),
      makeBlock({ id: 'EMPTY', content: '', parent_id: 'ZOOMROOT', depth: 1, position: 0 }),
      makeBlock({ id: 'KEEP', content: 'sibling', parent_id: 'ZOOMROOT', depth: 1, position: 1 }),
    ]
    const { remove } = await runCleanup(blocks, { zoomedBlockId: 'ZOOMROOT' })
    expect(remove).toHaveBeenCalledWith('EMPTY', { undoable: false })
  })
})

// =========================================================================
// Not-a-content-block, and the races around the async probe
// =========================================================================

describe('deleteBlockIfLeakedEmpty — liveness and races', () => {
  it('never deletes a non-content row', async () => {
    const { remove } = await runCleanup(leakedPage({ block_type: 'page' }))
    expect(remove).not.toHaveBeenCalled()
  })

  it('never deletes an already soft-deleted row twice', async () => {
    const { remove } = await runCleanup(leakedPage({ deleted_at: 1_700_000_000_000 }))
    expect(remove).not.toHaveBeenCalled()
  })

  it('does nothing when the window itself lost focus (alt-tab, tab switch)', async () => {
    // Deleting on a window/app blur is user-hostile: they come back to a
    // vanished block with no gesture of their own to blame.
    const spy = vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    try {
      const { remove } = await runCleanup(leakedPage())
      expect(remove).not.toHaveBeenCalled()
      // Not even the probe should have run.
      expect(mockGetProperties).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('aborts when the user focused the block again during the probe', async () => {
    const { remove } = await runCleanup(leakedPage(), { focusedBlockId: 'EMPTY' })
    expect(remove).not.toHaveBeenCalled()
  })

  it('aborts when the block gained content while the probe was in flight', async () => {
    const blocks = leakedPage()
    mockGetProperties.mockImplementation(async () => {
      // A racing sync load / undo / paste lands text in the block.
      blocks[1] = makeBlock({ id: 'EMPTY', content: 'restored by undo', position: 1 })
      return []
    })
    const { remove } = await runCleanup(blocks)
    expect(remove).not.toHaveBeenCalled()
  })

  it('aborts when the block is gone from the tree entirely', async () => {
    const { remove } = await runCleanup(leakedPage(), { blockId: 'NOT_HERE' })
    expect(remove).not.toHaveBeenCalled()
  })

  it('keeps the block when a metadata probe fails — an unknown answer is not a licence', async () => {
    mockListTagsForBlock.mockRejectedValue(new Error('pool busy'))
    const { remove, deleted } = await runCleanup(leakedPage())
    expect(deleted).toBe(false)
    expect(remove).not.toHaveBeenCalled()
  })

  it('stands down entirely on a truncated page, where "has children" is unanswerable', async () => {
    // `buildFlatTree` drops a nested child whose parent row fell past the
    // PAGE_SUBTREE_MAX_BLOCKS cut, so a blank block can read as childless when
    // it is not — and `delete_block` cascades.
    const { remove } = await runCleanup(leakedPage(), { truncated: true })
    expect(remove).not.toHaveBeenCalled()
    expect(mockGetProperties).not.toHaveBeenCalled()
  })

  it('reports false rather than throwing when the delete itself fails', async () => {
    const remove = vi.fn(async () => {
      throw new Error('delete_block failed')
    })
    const blocks = leakedPage()
    await expect(
      deleteBlockIfLeakedEmpty({
        blockId: 'EMPTY',
        zoomedBlockId: null,
        spaceId: useSpaceStore.getState().currentSpaceId,
        remove,
        readBlocks: () => blocks,
        isPageTruncated: () => false,
        isStillBlurred: () => true,
      }),
    ).resolves.toBe(false)
  })

  it('does not pay the IPC probe for a block that fails a local guard', async () => {
    await runCleanup(leakedPage({ content: 'has text' }))
    expect(mockGetProperties).not.toHaveBeenCalled()
    expect(mockListTagsForBlock).not.toHaveBeenCalled()
    expect(mockListAttachments).not.toHaveBeenCalled()
    expect(mockGetBacklinks).not.toHaveBeenCalled()
  })
})

// =========================================================================
// #5448 — a save that writes the text only after its property IPC answers
// =========================================================================

describe('a block whose `key:: value` save is still in flight (#5448)', () => {
  /**
   * Escape (or any flush) on a new block holding only `context:: home`: the
   * store still shows the block blank, and the stripped (or kept) text is
   * written only once `set_property` has answered. `settle` answers it.
   */
  function flushPropertyLine(blocks: FlatBlock[], answer: 'accept' | 'refuse') {
    let stored: ReturnType<typeof makePropertyRow>[] = []
    const asked = deferred<undefined>()
    const answered = deferred<undefined>()
    vi.mocked(invoke).mockImplementation(
      mockInvokeCommands({
        get_property_def: () => ({
          key: 'context',
          value_type: 'text',
          options: null,
          created_at: '0',
        }),
        set_property: async () => {
          asked.resolve(undefined)
          await answered.promise
          if (answer === 'refuse') throw new Error('refused')
          stored = [makePropertyRow({ key: 'context', value_text: 'home' })]
          return withOps(makeBlockRow({ id: 'EMPTY' }))
        },
      }),
    )
    mockGetProperties.mockImplementation(async () => stored)
    const edit = vi.fn(async (blockId: string, content: string) => {
      const idx = blocks.findIndex((b) => b.id === blockId)
      blocks[idx] = makeBlock({ ...blocks[idx], id: blockId, content })
      return true
    })
    const { outcome } = runUnmountFlush({
      blockId: 'EMPTY',
      loaded: '',
      changed: 'context:: home',
      edit,
      splitBlock: vi.fn(),
      rootParentId: null,
    })
    /** Answer `set_property` once the commit has asked, i.e. after a probe not waiting would have run. */
    const settle = async () => {
      await asked.promise
      answered.resolve(undefined)
    }
    return { settle, edit, outcome }
  }

  it('keeps the block whose value was accepted: the probe runs after the property is stored', async () => {
    const blocks = leakedPage({ content: '' })
    const { settle, edit } = flushPropertyLine(blocks, 'accept')

    const cleanup = runCleanup(blocks)
    await settle()
    // The probe was not issued while the property was not yet stored.
    expect(mockGetProperties).not.toHaveBeenCalled()

    const { remove, deleted } = await cleanup
    expect(deleted).toBe(false)
    expect(remove).not.toHaveBeenCalled()
    expect(edit).toHaveBeenCalledExactlyOnceWith('EMPTY', '')
    expect(mockGetProperties).toHaveBeenCalledTimes(1)
  })

  it('keeps the block whose value was refused: the line stays as its text', async () => {
    const blocks = leakedPage({ content: '' })
    const { settle, edit } = flushPropertyLine(blocks, 'refuse')

    const cleanup = runCleanup(blocks)
    await settle()
    expect(mockGetProperties).not.toHaveBeenCalled()

    const { remove, deleted } = await cleanup
    expect(deleted).toBe(false)
    expect(remove).not.toHaveBeenCalled()
    expect(edit).toHaveBeenCalledExactlyOnceWith('EMPTY', 'context:: home')
  })

  it('still cleans the block once the save has landed and it is really empty', async () => {
    const blocks = leakedPage({ content: '' })
    const { settle, outcome } = flushPropertyLine(blocks, 'accept')
    await settle()
    await outcome
    // The user then removed the property: blank text, nothing stored.
    mockGetProperties.mockResolvedValue([])

    const { remove, deleted } = await runCleanup(blocks)
    expect(deleted).toBe(true)
    expect(remove).toHaveBeenCalledWith('EMPTY', { undoable: false })
  })
})

describe('isLeakedEmptyCandidate', () => {
  it('treats whitespace-only content as blank', () => {
    expect(
      isLeakedEmptyCandidate({
        blocks: leakedPage({ content: '\n  \t ' }),
        blockId: 'EMPTY',
        zoomedBlockId: null,
      }),
    ).toBe(true)
  })

  it('is false for a block that is not in the tree', () => {
    expect(
      isLeakedEmptyCandidate({ blocks: leakedPage(), blockId: 'GHOST', zoomedBlockId: null }),
    ).toBe(false)
  })
})
