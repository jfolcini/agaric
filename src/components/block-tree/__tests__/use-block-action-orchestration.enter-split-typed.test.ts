/**
 * A block Enter splits off is typed, as page mode reads a new block: the task
 * marker, `key:: value` line or `#name` it starts with is committed when the
 * caret leaves it. Real store over the real tauri mock; the roving editor is an
 * in-memory stand-in that keeps the baseline as the real one does (`mount`
 * sets it, `markCommitted` rebases it, `unmount` reports a change against it),
 * and `setFocused` runs EditableBlock's auto-mount, as the flushed commit does.
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
  let baseline = doc
  return {
    editor: null,
    mount: vi.fn((id: string, markdown: string) => {
      active = id
      text = markdown
      baseline = markdown
    }),
    updateListMarker: vi.fn(),
    listMarker: vi.fn(() => ({ style: 'none' as const, ordinal: undefined })),
    unmount: vi.fn(() => {
      const changed = active !== null && text !== baseline ? text : null
      active = null
      text = ''
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
    setOnUpdate: vi.fn(),
    markCommitted: vi.fn((markdown: string) => {
      if (active !== null) baseline = markdown
    }),
  } as unknown as RovingEditorHandle
}

/** Split Getting Started's first block, holding `doc`, at the caret, then leave the new block. */
async function splitAndLeave(doc: string, split: { before: string; after: string }) {
  dispatch('edit_block', { blockId: BLOCK_GS_1, toText: doc })
  const pageStore = createPageBlockStore(PAGE_GETTING_STARTED)
  await pageStore.getState().load()
  const handle = makeEditor(BLOCK_GS_1, doc, split)
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
