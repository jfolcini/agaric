/**
 * A block Enter splits off is typed, as page mode reads a new block: the task
 * marker, `key:: value` line or `#name` it starts with is committed when the
 * caret leaves it. Real store over the real tauri mock; the roving editor is an
 * in-memory stand-in that keeps its two baselines as the real one does: `mount`
 * and `markCommitted` set the stored text and the classification baseline,
 * `readAsTyped` moves only the latter, and `unmount` reports a change against
 * either. `setFocused` runs EditableBlock's auto-mount, as the flushed commit does.
 * Leaving the block is the real imperative flush (`useBlockFlush`).
 */

import type { InvokeArgs } from '@tauri-apps/api/core'
import { invoke } from '@tauri-apps/api/core'
import { act, renderHook } from '@testing-library/react'
import type { TFunction } from 'i18next'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useBlockActionOrchestration } from '@/components/block-tree/use-block-action-orchestration'
import { useBlockFlush } from '@/components/block-tree/use-block-flush'
import type { RovingEditorHandle } from '@/editor/use-roving-editor'
import type { PropertyRow } from '@/lib/bindings'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { blocks as mockBlocks, SEED_IDS, seedBlocks } from '@/lib/tauri-mock/seed'
import type { MountedBlocks } from '@/lib/zoom-scope'
import { createPageBlockStore } from '@/stores/page-blocks'
import { useSpaceStore } from '@/stores/space'
import { useUndoStore } from '@/stores/undo'
import { settlePendingSaves } from '@/stores/unmount-flush'

const mockedInvoke = vi.mocked(invoke)
const t = ((key: string) => key) as unknown as TFunction
const { BLOCK_GS_1, PAGE_GETTING_STARTED } = SEED_IDS

/** An editor holding `doc` for `blockId` whose caret split yields `split`. */
function makeEditor(blockId: string, doc: string, split: { before: string; after: string }) {
  let active: string | null = blockId
  let text = doc
  let stored = doc
  let baseline = doc
  const handle = {
    editor: null,
    mount: vi.fn((id: string, markdown: string) => {
      active = id
      text = markdown
      stored = markdown
      baseline = markdown
    }),
    updateListMarker: vi.fn(),
    listMarker: vi.fn(() => ({ style: 'none' as const, ordinal: undefined })),
    unmount: vi.fn(() => {
      const changed = active !== null && (text !== stored || text !== baseline) ? text : null
      active = null
      text = ''
      stored = ''
      baseline = ''
      return changed
    }),
    get activeBlockId() {
      return active
    },
    getMarkdown: vi.fn(() => (active === null ? null : text)),
    splitAtCaret: vi.fn(() => split),
    get originalMarkdown() {
      return baseline
    },
    get storedMarkdown() {
      return stored
    },
    setOnUpdate: vi.fn(),
    markCommitted: vi.fn((markdown: string) => {
      if (active === null) return
      stored = markdown
      baseline = markdown
    }),
    readAsTyped: vi.fn((untyped: string) => {
      if (active !== null) baseline = untyped
    }),
  }
  /** What the user leaves in the mounted block. */
  const type = (markdown: string) => {
    text = markdown
  }
  return { handle: handle as unknown as RovingEditorHandle, type }
}

/**
 * Split Getting Started's first block, holding `doc`, at the caret, then leave
 * the new block, holding `typed` when given.
 */
async function splitAndLeave(
  doc: string,
  split: { before: string; after: string },
  typed?: string,
) {
  dispatch('edit_block', { blockId: BLOCK_GS_1, toText: doc })
  const pageStore = createPageBlockStore(PAGE_GETTING_STARTED)
  await pageStore.getState().load()
  const { handle, type } = makeEditor(BLOCK_GS_1, doc, split)
  const rovingEditorRef = { current: handle as RovingEditorHandle | null }
  // EditableBlock's auto-mount effect, which the commit that focuses the block
  // runs: mount it with its stored content unless the editor is already there.
  const setFocused = vi.fn((id: string | null) => {
    if (id === null || handle.activeBlockId === id) return
    handle.mount(id, pageStore.getState().blocksById.get(id)?.content ?? '')
  })
  const s = pageStore.getState()
  const { result } = renderHook(() => {
    const handleFlush = useBlockFlush({
      rovingEditorRef,
      edit: s.edit,
      splitBlock: s.splitBlock,
      rootParentId: PAGE_GETTING_STARTED,
      pageStore,
    })
    return {
      handleFlush,
      ...useBlockActionOrchestration({
        focusedBlockId: BLOCK_GS_1,
        collapsedVisible: pageStore.getState().blocks as unknown as MountedBlocks,
        blocks: pageStore.getState().blocks,
        rovingEditor: handle,
        setFocused,
        setSelected: vi.fn(),
        handleFlush,
        pageStore,
        remove: s.remove,
        moveBlocks: s.moveBlocks,
        edit: s.edit,
        indent: s.indent,
        dedent: s.dedent,
        moveUp: s.moveUp,
        moveDown: s.moveDown,
        createBelow: s.createBelow,
        discardDraft: vi.fn(),
        t,
      }),
    }
  })

  await act(async () => {
    await result.current.handleEnterSave()
  })
  const newId = handle.activeBlockId
  expect(newId).not.toBeNull()
  expect(newId).not.toBe(BLOCK_GS_1)
  const editsBeforeLeave = editsOf(newId as string)
  if (typed !== undefined) type(typed)

  await act(async () => {
    result.current.handleFlush()
    await settlePendingSaves(newId as string)
  })
  return { newId: newId as string, editsOnLeave: editsOf(newId as string) - editsBeforeLeave }
}

function editsOf(blockId: string): number {
  return mockedInvoke.mock.calls.filter(
    ([cmd, args]) =>
      cmd === 'edit_block' &&
      (args as Record<string, unknown> | undefined)?.['blockId'] === blockId,
  ).length
}

/** The live blocks of Getting Started in the mock. */
function livePageBlocks(): number {
  return [...mockBlocks.values()].filter(
    (b) => b['parent_id'] === PAGE_GETTING_STARTED && b['deleted_at'] == null,
  ).length
}

function contentOf(blockId: string): unknown {
  return mockBlocks.get(blockId)?.['content']
}

beforeEach(() => {
  vi.clearAllMocks()
  seedBlocks()
  useSpaceStore.setState({ currentSpaceId: 'SPACE_PERSONAL' })
  useUndoStore.setState({ pages: new Map() })
  mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args))
})

describe('a block Enter splits off commits what it holds as typed when the caret leaves it', () => {
  it('a `key:: value` line becomes the property and leaves the text', async () => {
    const { newId } = await splitAndLeave('intro\nstatus:: done', {
      before: 'intro',
      after: 'status:: done',
    })

    const props = dispatch('get_properties', { blockId: newId }) as PropertyRow[]
    expect(props.find((p) => p.key === 'status')?.value_text).toBe('done')
    expect(contentOf(newId)).toBe('')
    expect(contentOf(BLOCK_GS_1)).toBe('intro')
  })

  it('a leading task marker becomes the task state and leaves the text', async () => {
    const { newId } = await splitAndLeave('intro\n- [ ] buy milk', {
      before: 'intro',
      after: '- [ ] buy milk',
    })

    expect(mockBlocks.get(newId)?.['todo_state']).toBe('TODO')
    expect(contentOf(newId)).toBe('buy milk')
  })

  it('a `#name` becomes the tag', async () => {
    const { newId } = await splitAndLeave('intro #project notes', {
      before: 'intro ',
      after: '#project notes',
    })

    const tag = [...mockBlocks.values()].find(
      (b) => b['block_type'] === 'tag' && b['content'] === 'project',
    )
    expect(tag).toBeDefined()
    expect(contentOf(newId)).toBe(`#[${tag?.['id'] as string}] notes`)
  })

  it('plain text commits nothing new on leave', async () => {
    const { newId, editsOnLeave } = await splitAndLeave('hello world', {
      before: 'hello ',
      after: 'world',
    })

    expect(editsOnLeave).toBe(0)
    expect(contentOf(newId)).toBe('world')
  })

  // As page mode keeps a block's paragraphs: the line becomes the property and
  // the paragraphs stay one block.
  it('a `key:: value` line in a tail of several paragraphs becomes the property', async () => {
    const pageBlocksBefore = livePageBlocks()
    const { newId } = await splitAndLeave('intro\n\nstatus:: done\n\nmore text', {
      before: 'intro',
      after: 'status:: done\n\nmore text',
    })

    const props = dispatch('get_properties', { blockId: newId }) as PropertyRow[]
    expect(props.find((p) => p.key === 'status')?.value_text).toBe('done')
    expect(contentOf(newId)).not.toContain('status::')
    expect(contentOf(newId)).toContain('more text')
    expect(livePageBlocks()).toBe(pageBlocksBefore + 1)
  })

  it('a cleared block is saved cleared', async () => {
    const { newId } = await splitAndLeave(
      'intro\nstatus:: done',
      { before: 'intro', after: 'status:: done' },
      '',
    )

    expect(contentOf(newId)).toBe('')
    const props = dispatch('get_properties', { blockId: newId }) as PropertyRow[]
    expect(props.some((p) => p.key === 'status')).toBe(false)
  })

  // Page mode keeps the id, and so the loaded text, with the half the split
  // text starts in; block mode moves that text to the new block.
  it('Enter at the start keeps what the block was loaded with as text', async () => {
    const { newId, editsOnLeave } = await splitAndLeave('status:: done', {
      before: '',
      after: 'status:: done',
    })

    expect(editsOnLeave).toBe(0)
    expect(contentOf(newId)).toBe('status:: done')
    const props = dispatch('get_properties', { blockId: newId }) as PropertyRow[]
    expect(props.some((p) => p.key === 'status')).toBe(false)
  })
})
