/**
 * Parity of the two save paths (#5743). The same edit of an empty block, which
 * the caret then leaves, is saved through block mode's (`runUnmountFlush` over
 * the page store's own actions, as the roving editor's blur runs it) and
 * through page mode's (`savePage`, then `commitPageTyped`, as `PageModeEditor`
 * runs them). Both leave the mock backend holding the same block: text, task
 * state, properties and tags.
 *
 * Each edit is the paragraph the block holds when the caret leaves it, as
 * each editor holds it. A pasted `- [ ] ` line is the one place they differ:
 * block mode's `TaskPaste` makes it a task paragraph, which serialises back to
 * the marker, while page mode keeps it as text. Each path runs on a fresh
 * backend, so neither finds a tag the other made; a tag is compared by name.
 */

import { invoke } from '@tauri-apps/api/core'
import { Fragment } from '@tiptap/pm/model'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { serialize } from '@/editor/markdown-serializer'
import { openPage } from '@/editor/page-mode/__tests__/page-mode-fixtures'
import { createSaveState, type PageSaveApi, savePage } from '@/editor/page-mode/page-save'
import { commitPageTags, commitPageTyped } from '@/editor/page-mode/page-tags'
import type { DocNode } from '@/editor/types'
import type { BlockRow, OpRef, PropertyRow } from '@/lib/bindings'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { seedBlocks } from '@/lib/tauri-mock/seed'
import { createPageBlockStore } from '@/stores/page-blocks'
import { useSpaceStore } from '@/stores/space'
import { runUnmountFlush } from '@/stores/unmount-flush'

const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' } as const
const BLOCK = '01J00000000000000000000001'

/** A fresh backend holding one page with the empty block `BLOCK`; resolves the page's id. */
function seedPage(): string {
  seedBlocks()
  const pageId = dispatch('create_page_in_space', {
    parentId: null,
    content: 'Parity',
    spaceId: SCOPE.space_id,
  }) as string
  dispatch('create_block', {
    blockType: 'content',
    content: '',
    parentId: pageId,
    index: null,
    scope: SCOPE,
    blockId: BLOCK,
  })
  return pageId
}

/** A paragraph of `text`, each `\n` a line break (Shift+Enter), as a task when `todoState` is given. */
function paragraph(text: string, todoState?: 'TODO'): DocNode {
  const content = text
    .split('\n')
    .flatMap((line, i) =>
      i === 0
        ? [{ type: 'text', text: line }]
        : [{ type: 'hardBreak' }, { type: 'text', text: line }],
    )
  const attrs = todoState === undefined ? {} : { attrs: { todoState } }
  return { type: 'doc', content: [{ type: 'paragraph', ...attrs, content }] } as DocNode
}

const tagName = (id: string): string =>
  (dispatch('get_block', { blockId: id }) as BlockRow).content ?? ''

/** What the backend holds for `BLOCK`, each tag by its name. */
function held() {
  const row = dispatch('get_block', { blockId: BLOCK }) as BlockRow
  const properties = (dispatch('get_properties', { blockId: BLOCK }) as PropertyRow[])
    .map(({ key, value_text, value_num, value_date, value_ref, value_bool }) => ({
      key,
      value: [value_text, value_num, value_date, value_ref, value_bool],
    }))
    .toSorted((a, b) => a.key.localeCompare(b.key))
  return {
    content: (row.content ?? '').replace(/#\[([0-9A-Z]{26})\]/g, (_, id) => `#[${tagName(id)}]`),
    todoState: row.todo_state,
    properties,
    tags: (dispatch('list_tags_for_block', { blockId: BLOCK }) as string[]).map(tagName),
  }
}

type Held = ReturnType<typeof held>

/** Block mode: the roving editor left the block holding `doc`. */
async function viaBlockMode(doc: DocNode): Promise<Held> {
  const pageId = seedPage()
  const store = createPageBlockStore(pageId)
  await store.getState().load()
  const { outcome } = runUnmountFlush({
    blockId: BLOCK,
    loaded: '',
    changed: serialize(doc),
    edit: store.getState().edit,
    splitBlock: store.getState().splitBlock,
    rootParentId: pageId,
    pageStore: store,
  })
  expect(await outcome).toBe(true)
  return held()
}

const refsOf = (cmd: string, args: Record<string, unknown>) =>
  (dispatch(cmd, args) as { op_refs: OpRef[] }).op_refs

/** The refs of each edit page mode's commands made since the save, in order. */
const edited: OpRef[][] = []

/** The block commands page mode's save calls, against the mock backend. */
const api: PageSaveApi = {
  create: async (id, parentId, index, markdown) =>
    refsOf('create_block', {
      blockType: 'content',
      content: markdown,
      parentId,
      index,
      scope: SCOPE,
      blockId: id,
    }),
  restore: async (id, deletedAt) => {
    dispatch('restore_block', { blockId: id, deletedAtRef: deletedAt })
  },
  move: async (id, parentId, index) =>
    refsOf('move_block', { blockId: id, newParentId: parentId, newIndex: index }),
  edit: async (id, markdown) => {
    const refs = refsOf('edit_block', { blockId: id, toText: markdown })
    edited.push(refs)
    return refs
  },
  remove: async (id) => {
    const deleted = dispatch('delete_block', { blockId: id }) as {
      deleted_at: number
      op_refs: OpRef[]
    }
    return { deletedAt: deleted.deleted_at, refs: deleted.op_refs }
  },
  tree: () => Promise.reject(new Error('no restore in these edits')),
}

let editor: ReturnType<typeof openPage> | null = null

/** Page mode: the block comes to hold `doc` and the page saves. */
async function savedInPageMode(doc: DocNode) {
  const pageId = seedPage()
  const ed = openPage([[BLOCK, 0, '']])
  editor = ed
  const rows = [{ id: BLOCK, parent_id: pageId, content: '' }]
  const save = createSaveState(pageId, rows, ed.state.doc)
  const loaded = ed.state.doc.child(0)
  const typed = Fragment.fromJSON(ed.schema, doc.content)
  ed.view.dispatch(ed.state.tr.replaceWith(1, loaded.nodeSize - 1, typed))
  expect((await savePage(ed.state.doc, save, api)).error).toBeUndefined()
  edited.length = 0
  return { save, loaded, store: createPageBlockStore(pageId) }
}

/** Page mode: the block comes to hold `doc`, the page saves, and the caret has left the block. */
async function viaPageMode(doc: DocNode): Promise<Held> {
  const { save, loaded, store } = await savedInPageMode(doc)
  const writes = save.writes
  const refs = await commitPageTyped(BLOCK, loaded, save, api, store)
  // The refs of the commit's edits, for undo, each counted as a write.
  expect(refs).toEqual(edited.flat())
  expect(save.writes - writes).toBe(edited.length)
  return held()
}

beforeEach(() => {
  vi.mocked(invoke).mockImplementation(async (cmd, args) => dispatch(cmd, args))
  useSpaceStore.setState({ currentSpaceId: SCOPE.space_id })
})

afterEach(() => {
  editor?.destroy()
  editor = null
})

const ASSIGNEE = { key: 'assignee', value: ['Ana', null, null, null, null] }

describe('page mode and block mode save an edit alike', () => {
  it.each([
    {
      edit: 'a typed #name',
      block: paragraph('buy milk #groceries'),
      page: paragraph('buy milk #groceries'),
      content: 'buy milk #[groceries]',
      todoState: null,
      keys: [],
    },
    {
      edit: 'a typed key:: value line',
      block: paragraph('buy milk\nassignee:: Ana'),
      page: paragraph('buy milk\nassignee:: Ana'),
      content: 'buy milk',
      todoState: null,
      keys: ['assignee'],
    },
    {
      edit: 'a pasted TODO marker',
      block: paragraph('buy milk', 'TODO'),
      page: paragraph('- [ ] buy milk'),
      content: 'buy milk',
      todoState: 'TODO',
      keys: ['created_at'],
    },
    {
      edit: 'TODO typed as a word',
      block: paragraph('TODO buy milk'),
      page: paragraph('TODO buy milk'),
      content: 'TODO buy milk',
      todoState: null,
      keys: [],
    },
    {
      // #5851's one leave: paste `- [ ] buy milk`, type ` #groceries`, Shift+Enter, `assignee:: Ana`.
      edit: 'all three on one leave',
      block: paragraph('buy milk #groceries\nassignee:: Ana', 'TODO'),
      page: paragraph('- [ ] buy milk #groceries\nassignee:: Ana'),
      content: 'buy milk #[groceries]',
      todoState: 'TODO',
      keys: ['assignee', 'created_at'],
    },
  ])('$edit', async ({ block, page, content, todoState, keys }) => {
    const blockMode = await viaBlockMode(block)
    expect([blockMode.content, blockMode.todoState]).toEqual([content, todoState])
    expect(blockMode.properties.map(({ key }) => key)).toEqual(keys)
    if (keys.includes('assignee')) expect(blockMode.properties).toContainEqual(ASSIGNEE)
    expect(await viaPageMode(page)).toEqual(blockMode)
  })
})

/**
 * Equivalent mutant, accepted: `return true` → `false` in `commitPageTags`'s
 * edit. `commitTypedTags` awaits that edit and ignores what it resolves.
 */
describe('commitPageTyped', () => {
  it('asks the backend nothing for a block left with nothing to commit', async () => {
    const { save, loaded, store } = await savedInPageMode(paragraph('buy milk'))
    vi.mocked(invoke).mockClear()

    expect(await commitPageTyped(BLOCK, loaded, save, api, store)).toEqual([])
    // An empty new block the caret left, never created.
    const unsaved = '01J00000000000000000000002'
    expect(await commitPageTyped(unsaved, null, save, api, store)).toEqual([])
    expect(vi.mocked(invoke)).not.toHaveBeenCalled()
    expect(edited).toEqual([])

    // A name it holds is looked up.
    await commitPageTags(BLOCK, save, api, 'buy milk #groceries')
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('list_all_tags_in_space', expect.anything())
  })
})
