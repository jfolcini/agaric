/**
 * Page mode end to end against the mock backend (#5691): a random run of
 * typing, Enter, Backspace, Tab, Shift+Tab, a copy pasted, blocks cut and
 * pasted, paragraphs pasted from outside, a `#name`, a task marker or a
 * `key:: value` line typed and the caret moved to another block, a task's
 * state cycled, a priority, a due or scheduled date or a property set or
 * cleared, a `- ` or `1. ` list prefix typed at a block's start (#5743), and
 * undo, Enter and Backspace on list blocks among them, each step perhaps
 * followed by a peer's change (an edit, or a block created, moved or deleted) brought in
 * as a reload does, and perhaps by a save whose commands fail before a clean
 * one. After every clean save:
 *
 * - the mock backend's page equals the document: ids, depth, order and text
 *   (an empty block new in the document may be missing: it is created once it
 *   holds something);
 * - a block the caret left after a `#name` was typed in it holds that name as
 *   a tag, written by the editor's tag commit (`commitPageTags`) after the save;
 * - each block holds the task state last given it, by a marker typed at its
 *   start (`commitPageTask`, which also takes the marker out of its text) or
 *   by the todo-state command, and none other;
 * - each block holds the priority and dates last given it by their commands,
 *   and none other: no save writes over them;
 * - each block holds the properties last given it, by a `key:: value` line it
 *   held when the caret left it (`commitPageProperties`, which also takes the
 *   line out of its text) unless it held that key as text before it was
 *   changed, or by the property commands, and none other;
 * - each block holds the list style its marker shows (`page-lists.ts`): the
 *   one a prefix gave it, taken out of its text, the one Enter carried on to
 *   the block it made, or none once Enter on it empty or Backspace at its
 *   start left the list; and each marker is the one block mode draws for the
 *   backend's styles, numbered over the document's blocks;
 * - an id that survives a step stays on the text it was on: a step that only
 *   types keeps every id, Enter adds one new id beside the block it splits, a
 *   join drops only the joined block's, Tab keeps the order and Shift+Tab the
 *   ids, a copy or a paste from outside only adds new ones, a cut and paste
 *   keeps every id, and an undo gives no block holding text an id not seen
 *   before;
 * - no peer's change is undone: an edit of a block untouched since its last
 *   save shows at once and is never written back over until the block is
 *   edited here; a block a peer created stays; a block a peer deleted stays
 *   deleted (text edited here into it lives on under a new id); a block a peer
 *   moved, while only text changed here, stays under the parent it was moved to.
 *
 * The backend is `src/lib/tauri-mock`, the conformance-pinned stand-in for the
 * real one, driven through its own command handlers. It accepts a create of an
 * id it already holds, which the real `create_block` refuses; the API below
 * refuses it as the backend does.
 */

import { invoke } from '@tauri-apps/api/core'
import type { Editor } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import type { Fragment, Node as PMNode } from '@tiptap/pm/model'
import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { computeContentDelta } from '@/editor/content-delta'
import { parse, serialize } from '@/editor/markdown-serializer'
import {
  blockId,
  caret,
  idMinter,
  idsOf,
  markdownOf,
  openPage,
  posIn,
  press,
  type Row,
  type,
} from '@/editor/page-mode/__tests__/page-mode-fixtures'
import {
  blockDocJson,
  changedBlocks,
  depthOf,
  REMOTE_PATCH,
} from '@/editor/page-mode/page-document'
import { pickerOpen } from '@/editor/page-mode/page-keys'
import { PageLists, type PageListSource } from '@/editor/page-mode/page-lists'
import { commitPageProperties } from '@/editor/page-mode/page-properties'
import {
  createSaveState,
  type PageSaveApi,
  type PageSaveState,
  savePage,
  type TreeRow,
} from '@/editor/page-mode/page-save'
import { commitPageTags } from '@/editor/page-mode/page-tags'
import { commitPageTask, leadingTask } from '@/editor/page-mode/page-tasks'
import { applyRemote } from '@/editor/page-mode/remote-patch'
import { blockIdOf } from '@/editor/token-ids'
import { commands } from '@/lib/bindings'
import type { BlockRow, OpRef, PropertyRow } from '@/lib/bindings'
import { parseInlineProperties } from '@/lib/inline-property-parse'
import { listMarkerText } from '@/lib/list-marker-glyph'
import { computeListOrdinals } from '@/lib/list-ordinals'
import { asListStyle, type ListStyle, setListStyle } from '@/lib/list-style'
import type { TagToken } from '@/lib/name-tokens'
import { nextTaskState, type TodoState } from '@/lib/task-states'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { blocks as mockBlocks, seedBlocks } from '@/lib/tauri-mock/seed'
import { buildFlatTree } from '@/lib/tree-utils'
import { useSpaceStore } from '@/stores/space'
import { tagsWrittenAsText } from '@/stores/unmount-flush'

const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' } as const

type WithRefs<T> = T & { op_refs: OpRef[] }

/** Run `f` as a command answer: a throw becomes a rejection, as an IPC refusal is. */
function answer<T>(f: () => T): Promise<T> {
  return Promise.resolve().then(f)
}

interface MockPage {
  pageId: string
  api: PageSaveApi
  /** The page's live blocks, as the store would load them. */
  rows: () => TreeRow[]
  live: () => Row[]
  /** Fail the save's calls whose index (from 0) has its bit set in the mask. */
  failWith: (mask: number | null) => void
  /** Run a peer's command: no local command, no event. */
  peer: (cmd: string, args: Record<string, unknown>) => void
}

function mockPage(rows: readonly Row[]): MockPage {
  seedBlocks()
  const pageId = dispatch('create_page_in_space', {
    parentId: null,
    content: 'Page mode property',
    spaceId: SCOPE.space_id,
  }) as string
  const atDepth: string[] = []
  for (const [id, depth, content] of rows) {
    dispatch('create_block', {
      blockType: 'content',
      content,
      parentId: depth === 0 ? pageId : atDepth[depth - 1],
      index: null,
      scope: SCOPE,
      blockId: id,
    })
    atDepth[depth] = id
  }
  let mask: number | null = null
  let calls = 0
  const command = <T>(cmd: string, args: Record<string, unknown>): T => {
    const failing = mask !== null && ((mask >> calls) & 1) === 1
    calls += 1
    if (failing) throw new Error(`refused: ${cmd}`)
    return dispatch(cmd, args) as T
  }
  const tree = (): ReturnType<typeof buildFlatTree> =>
    buildFlatTree(
      (
        dispatch('load_page_subtree', { rootBlockId: pageId, scope: SCOPE }) as {
          blocks: BlockRow[]
        }
      ).blocks,
      pageId,
    )
  return {
    pageId,
    rows: () => tree().map(({ id, parent_id, content }) => ({ id, parent_id, content })),
    live: () => tree().map((b) => [b.id, b.depth, b.content ?? ''] as Row),
    failWith: (next) => {
      mask = next
      calls = 0
    },
    peer: (cmd, args) => {
      dispatch(cmd, cmd === 'create_block' ? { ...args, scope: SCOPE } : args)
    },
    api: {
      create: (id, parentId, index, markdown) =>
        answer(() => {
          if (mockBlocks.has(id)) throw new Error(`create_block: block ${id} already exists`)
          return command<WithRefs<BlockRow>>('create_block', {
            blockType: 'content',
            content: markdown,
            parentId,
            index,
            scope: SCOPE,
            blockId: id,
          }).op_refs
        }),
      restore: (id, deletedAt) =>
        answer(() => {
          command('restore_block', { blockId: id, deletedAtRef: deletedAt })
        }),
      move: (id, parentId, index) =>
        answer(
          () =>
            command<WithRefs<unknown>>('move_block', {
              blockId: id,
              newParentId: parentId,
              newIndex: index,
            }).op_refs,
        ),
      edit: (id, markdown) =>
        answer(
          () =>
            command<WithRefs<BlockRow>>('edit_block', { blockId: id, toText: markdown }).op_refs,
        ),
      remove: (id) =>
        answer(() => {
          const deleted = command<WithRefs<{ deleted_at: number }>>('delete_block', { blockId: id })
          return { deletedAt: deleted.deleted_at, refs: deleted.op_refs }
        }),
      tree: () => answer(() => tree()),
    },
  }
}

// ── The run ───────────────────────────────────────────────────────────────

const WORDS = ['alpha', 'beta', 'gamma', 'x', 'y z'] as const
const textArb = fc
  .array(fc.constantFrom(...WORDS), { maxLength: 3 })
  .map((words) => words.join(' '))

const rowsArb = fc
  .array(fc.tuple(fc.nat(2), textArb), { minLength: 1, maxLength: 6 })
  .map((raw) => {
    let previous = -1
    return raw.map(([depth, text], i): Row => {
      previous = Math.min(depth, previous + 1)
      return [blockId(i + 1), previous, text]
    })
  })

const at = fc.nat(1000)
/** Text properties the mock defines (`seed.ts`). */
const PROPERTY_KEYS = ['assignee', 'location'] as const
const actionArb = fc.oneof(
  fc.record({
    kind: fc.constant('type' as const),
    block: fc.nat(),
    at,
    text: fc.constantFrom('a', 'b ', 'cd'),
  }),
  fc.record({ kind: fc.constant('enter' as const), block: fc.nat(), at }),
  fc.record({ kind: fc.constant('backspace' as const), block: fc.nat() }),
  fc.record({ kind: fc.constant('tab' as const), block: fc.nat() }),
  fc.record({ kind: fc.constant('shiftTab' as const), block: fc.nat() }),
  fc.record({
    kind: fc.constant('paste' as const),
    from: fc.nat(),
    count: fc.integer({ min: 1, max: 2 }),
    to: fc.nat(),
    at,
  }),
  fc.record({
    kind: fc.constant('cutPaste' as const),
    from: fc.nat(),
    count: fc.integer({ min: 1, max: 2 }),
    to: fc.nat(),
  }),
  fc.record({
    kind: fc.constant('pasteOutside' as const),
    block: fc.nat(),
    at,
    html: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant('tag' as const),
    block: fc.nat(),
    // A new tag, and the seeded `work` in another case.
    name: fc.constantFrom('newtag', 'Work'),
    to: fc.nat(),
  }),
  fc.record({
    kind: fc.constant('taskMarker' as const),
    block: fc.nat(),
    marker: fc.constantFrom(
      ['[ ] ', 'TODO'] as const,
      ['- [x] ', 'DONE'] as const,
      ['[/] ', 'DOING'] as const,
    ),
    to: fc.nat(),
  }),
  fc.record({ kind: fc.constant('cycleTask' as const), block: fc.nat() }),
  fc.record({
    kind: fc.constant('setPriority' as const),
    block: fc.nat(),
    level: fc.constantFrom('1', '2', '3', null),
  }),
  fc.record({
    kind: fc.constant('setDate' as const),
    block: fc.nat(),
    field: fc.constantFrom('due_date' as const, 'scheduled_date' as const),
    date: fc.constantFrom('2026-10-20', '2026-11-01', null),
  }),
  fc.record({
    kind: fc.constant('setProperty' as const),
    block: fc.nat(),
    key: fc.constantFrom(...PROPERTY_KEYS),
    value: fc.constantFrom('Ana', 'Bo', null),
  }),
  fc.record({
    kind: fc.constant('propertyLine' as const),
    block: fc.nat(),
    key: fc.constantFrom(...PROPERTY_KEYS),
    value: fc.constantFrom('Ana', 'Bo'),
    to: fc.nat(),
  }),
  fc.record({
    kind: fc.constant('listPrefix' as const),
    block: fc.nat(),
    prefix: fc.constantFrom(
      ['- ', 'bullet'] as const,
      ['* ', 'bullet'] as const,
      ['1. ', 'ordered'] as const,
      ['12. ', 'ordered'] as const,
    ),
  }),
  // Enter at a list block's text, Backspace at its start: one of the page's list blocks, if any.
  // `again`: Enter at the block's end, then once more in the empty block it made, which leaves the list.
  fc.record({ kind: fc.constant('listEnter' as const), block: fc.nat(), at, again: fc.boolean() }),
  fc.record({ kind: fc.constant('listBackspace' as const), block: fc.nat() }),
  fc.record({ kind: fc.constant('undo' as const) }),
)
type Action = typeof actionArb extends fc.Arbitrary<infer T> ? T : never

const peerText = textArb.map((t) => `peer ${t}`)
const peerArb = fc.oneof(
  fc.record({ kind: fc.constant('edit' as const), block: fc.nat(), text: peerText }),
  fc.record({ kind: fc.constant('create' as const), parent: fc.nat(), at, text: peerText }),
  fc.record({ kind: fc.constant('move' as const), block: fc.nat(), parent: fc.nat(), at }),
  fc.record({ kind: fc.constant('delete' as const), block: fc.nat() }),
)
type PeerChange = typeof peerArb extends fc.Arbitrary<infer T> ? T : never

const stepArb = fc.record({
  action: actionArb,
  peer: fc.option(peerArb, { freq: 3 }),
  failures: fc.option(fc.integer({ min: 1, max: 0xffff }), { freq: 4 }),
})
type Step = typeof stepArb extends fc.Arbitrary<infer T> ? T : never

const B1 = blockId(1)
const B2 = blockId(2)
/**
 * Found once each: a `key:: value` line typed into a block a peer deletes
 * before the save, so the block is kept under a new id and the line stays
 * text, then moved by Enter or a cut into a block that did not hold it, which
 * the caret then leaves; or left in that block, which a task marker then
 * changes, so the key it held stays text. And an undo of a cut pasted where a
 * block starts, after a peer created a block just before it: the block kept the
 * pasted block's id, whose text the next undo brought back under a new one
 * (`prosemirror-transform` before 1.12.2 dropped an attribute step mapped over
 * an insertion at its position). The same undo after a peer rewrote the joined
 * block: its first character, the peer's, held the pasted block's id, so the
 * cut text came back under a new one (`restoredIds` in `page-block-ids.ts`).
 */
const EXAMPLES: Array<[Row[], Step[]]> = [
  [
    [
      [B1, 0, ''],
      [B2, 0, ''],
    ],
    [
      {
        action: { kind: 'tag', block: 0, name: 'newtag', to: 0 },
        peer: { kind: 'edit', block: 0, text: 'peer ' },
        failures: null,
      },
      {
        action: { kind: 'propertyLine', block: 0, key: 'assignee', value: 'Ana', to: 0 },
        peer: { kind: 'delete', block: 0 },
        failures: null,
      },
      { action: { kind: 'enter', block: 0, at: 177 }, peer: null, failures: null },
      {
        action: { kind: 'tag', block: 28554937, name: 'newtag', to: 0 },
        peer: null,
        failures: null,
      },
    ],
  ],
  [
    [
      [B1, 0, ''],
      [B2, 0, ''],
    ],
    [
      {
        action: { kind: 'propertyLine', block: 39169023, key: 'assignee', value: 'Ana', to: 0 },
        peer: { kind: 'delete', block: 432947423 },
        failures: null,
      },
      {
        action: { kind: 'cutPaste', from: 561348579, count: 1, to: 0 },
        peer: null,
        failures: null,
      },
      {
        action: { kind: 'taskMarker', block: 0, marker: ['[ ] ', 'TODO'], to: 0 },
        peer: null,
        failures: null,
      },
    ],
  ],
  [
    [
      [B1, 0, ''],
      [B2, 0, ''],
    ],
    [
      {
        action: { kind: 'propertyLine', block: 0, key: 'assignee', value: 'Ana', to: 0 },
        peer: { kind: 'delete', block: 0 },
        failures: null,
      },
      {
        action: { kind: 'taskMarker', block: 0, marker: ['[ ] ', 'TODO'], to: 0 },
        peer: null,
        failures: null,
      },
    ],
  ],
  [
    [[B1, 0, 'alpha']],
    [
      {
        action: { kind: 'paste', from: 0, count: 1, to: 0, at: 0 },
        peer: { kind: 'create', parent: 0, at: 0, text: 'peer ' },
        failures: null,
      },
      {
        action: { kind: 'cutPaste', from: 1, count: 1, to: 0 },
        peer: { kind: 'create', parent: 0, at: 0, text: 'peer ' },
        failures: null,
      },
      { action: { kind: 'undo' }, peer: null, failures: null },
      { action: { kind: 'undo' }, peer: null, failures: null },
    ],
  ],
  [
    [
      [B1, 0, 'alpha'],
      [B2, 0, 'alpha'],
    ],
    [
      { action: { kind: 'cutPaste', from: 1, count: 1, to: 0 }, peer: null, failures: null },
      {
        action: { kind: 'tab', block: 0 },
        peer: { kind: 'edit', block: 0, text: 'peer ' },
        failures: null,
      },
      { action: { kind: 'undo' }, peer: null, failures: null },
      { action: { kind: 'undo' }, peer: null, failures: null },
    ],
  ],
]

function firstTextLength(ed: Editor, index: number): number {
  return ed.state.doc.child(index).firstChild?.textContent.length ?? 0
}

/** Select from block `from`'s start to block `last`'s end, or to the next block's start. */
function selectBlocks(ed: Editor, from: number, last: number, toNextStart: boolean): void {
  const next = last + 1 < ed.state.doc.childCount && toNextStart
  ed.commands.setTextSelection({
    from: posIn(ed, from, 0),
    to: next ? posIn(ed, last + 1, 0) : posIn(ed, last, firstTextLength(ed, last)),
  })
}

function clipboard(ed: Editor, kind: 'copy' | 'cut'): string {
  const data = new DataTransfer()
  ed.view.dom.dispatchEvent(
    new ClipboardEvent(kind, { clipboardData: data, bubbles: true, cancelable: true }),
  )
  return data.getData('text/html')
}

interface Acted {
  index: number
  offset: number
  /** The block a paste went into. */
  target?: string
  /** The block a `#name` or a task marker was typed into, which the caret then left. */
  tagged?: string
  /** The marker typed, the state it gives the block, and the block's first text before it. */
  task?: { marker: string; state: TodoState; before: string }
  /** The block whose task state to cycle. */
  cycled?: string
  /** A priority or a date to give a block through its command; null clears it. */
  field?: { id: string; key: Field; value: string | null }
  /** A property to give a block through its command; null deletes it. */
  property?: { id: string; key: string; value: string | null }
  /** The `key:: value` line typed into the block `tagged`. */
  line?: { key: string; value: string }
}

const FIELDS = ['priority', 'due_date', 'scheduled_date'] as const
type Field = (typeof FIELDS)[number]

/**
 * Press `key` at the caret. In a list block, Enter splitting it gives the
 * block it made the same style; Enter in it empty, or Backspace at its start,
 * takes its style off and changes nothing else. An open picker takes the key.
 */
function pressInList(ed: Editor, lists: PageLists, key: 'Enter' | 'Backspace'): void {
  const node = ed.state.selection.$head.node(1)
  const id = blockIdOf(node) as string
  const before = new Set(idsOf(ed.state.doc))
  const style = pickerOpen(ed.state) ? 'none' : lists.styleOf(id)
  press(ed, key)
  if (style === 'none') return
  const made = idsOf(ed.state.doc).find((other) => !before.has(other))
  if (made === undefined) {
    expect(lists.styleOf(id)).toBe('none')
    expect(idsOf(ed.state.doc)).toEqual([...before])
    return
  }
  expect([key, markdownOf(node) === '']).toEqual(['Enter', false])
  expect([lists.styleOf(id), lists.styleOf(made)]).toEqual([style, style])
}

type ListStep = Extract<Action, { kind: 'listPrefix' | 'listEnter' | 'listBackspace' }>

const isListStep = (action: Action): action is ListStep => action.kind.startsWith('list')

/** Apply a list step: a prefix typed at a block's start, or Enter or Backspace in a list block. */
function applyList(ed: Editor, action: ListStep, lists: PageLists): Acted {
  if (action.kind === 'listPrefix') {
    const index = action.block % ed.state.doc.childCount
    caret(ed, index, 0)
    const id = blockIdOf(ed.state.doc.child(index)) as string
    const before = ed.state.doc.child(index).firstChild?.textContent ?? ''
    type(ed, `${action.prefix[0]}q`)
    // The block takes the prefix's style, and the prefix leaves its text.
    expect(lists.styleOf(id)).toBe(action.prefix[1])
    expect(ed.state.doc.child(index).firstChild?.textContent).toBe(`q${before}`)
    return { index, offset: 0 }
  }
  const listed = idsOf(ed.state.doc).flatMap((id, i) => (lists.styleOf(id) === 'none' ? [] : [i]))
  const index = listed[action.block % Math.max(listed.length, 1)]
  if (index === undefined) return { index: 0, offset: 0 }
  if (action.kind === 'listBackspace') {
    caret(ed, index, 0)
    pressInList(ed, lists, 'Backspace')
    return { index, offset: 0 }
  }
  const length = firstTextLength(ed, index)
  const offset = action.again ? length : action.at % (length + 1)
  caret(ed, index, offset)
  pressInList(ed, lists, 'Enter')
  const { $head } = ed.state.selection
  if (action.again && $head.index(0) === index + 1 && markdownOf($head.node(1)) === '') {
    pressInList(ed, lists, 'Enter')
  }
  return { index, offset }
}

/** Apply `action`; resolves the block it acted on, if any. */
function apply(ed: Editor, action: Action, lists: PageLists): Acted | null {
  const count = ed.state.doc.childCount
  if (action.kind === 'undo') {
    ed.commands.undo()
    return null
  }
  ed.view.dispatch(closeHistory(ed.state.tr))
  if (action.kind === 'paste' || action.kind === 'cutPaste') {
    const from = action.from % count
    const last = Math.min(count - 1, from + action.count - 1)
    selectBlocks(ed, from, last, action.kind === 'cutPaste')
    const html = clipboard(ed, action.kind === 'paste' ? 'copy' : 'cut')
    const to = action.to % ed.state.doc.childCount
    const offset = action.kind === 'paste' ? action.at % (firstTextLength(ed, to) + 1) : 0
    caret(ed, to, offset)
    const target = blockIdOf(ed.state.doc.child(to)) as string
    ed.view.pasteHTML(html)
    return { index: to, offset, target }
  }
  if (isListStep(action)) return applyList(ed, action, lists)
  const index = action.block % count
  const offset = 'at' in action ? action.at % (firstTextLength(ed, index) + 1) : 0
  caret(ed, index, offset)
  if (action.kind === 'cycleTask')
    return { index, offset, cycled: blockIdOf(ed.state.doc.child(index)) as string }
  if (action.kind === 'setProperty') {
    const id = blockIdOf(ed.state.doc.child(index)) as string
    return { index, offset, property: { id, key: action.key, value: action.value } }
  }
  if (action.kind === 'propertyLine') {
    // Typed only where the caret can then leave the block, for the commit.
    const others = Array.from({ length: count }, (_, i) => i).filter((i) => i !== index)
    const to = others[action.to % Math.max(others.length, 1)]
    if (to === undefined) return { index, offset }
    const tagged = blockIdOf(ed.state.doc.child(index)) as string
    const first = ed.state.doc.child(index).firstChild
    ed.commands.setTextSelection(posIn(ed, index, first?.content.size ?? 0))
    ed.commands.setHardBreak()
    type(ed, `${action.key}:: ${action.value}`)
    caret(ed, to, 0)
    return { index, offset, tagged, line: { key: action.key, value: action.value } }
  }
  if (action.kind === 'setPriority' || action.kind === 'setDate') {
    const id = blockIdOf(ed.state.doc.child(index)) as string
    const field =
      action.kind === 'setPriority'
        ? { id, key: 'priority' as const, value: action.level }
        : { id, key: action.field, value: action.date }
    return { index, offset, field }
  }
  if (action.kind === 'tag' || action.kind === 'taskMarker') {
    const tagged = blockIdOf(ed.state.doc.child(index)) as string
    const before = ed.state.doc.child(index).firstChild?.textContent ?? ''
    if (action.kind === 'tag') {
      caret(ed, index, firstTextLength(ed, index))
      type(ed, ` #${action.name}`)
    } else type(ed, action.marker[0])
    const others = Array.from({ length: count }, (_, i) => i).filter((i) => i !== index)
    const to = others[action.to % Math.max(others.length, 1)]
    if (to === undefined) return { index, offset }
    caret(ed, to, 0)
    return action.kind === 'tag'
      ? { index, offset, tagged }
      : {
          index,
          offset,
          tagged,
          task: { marker: action.marker[0], state: action.marker[1], before },
        }
  }
  if (action.kind === 'pasteOutside') {
    if (action.html) ed.view.pasteHTML('<p>from</p><p>outside</p>')
    else ed.view.pasteText('from\noutside')
  } else if (action.kind === 'type') type(ed, action.text)
  else if (action.kind === 'enter') pressInList(ed, lists, 'Enter')
  else if (action.kind === 'backspace') pressInList(ed, lists, 'Backspace')
  else press(ed, 'Tab', { shiftKey: action.kind === 'shiftTab' })
  return { index, offset }
}

/** Where `action` may have put ids: `before` the step, `after` it, `seen` in every earlier state. */
function expectIdsKept(
  action: Action,
  acted: Acted | null,
  before: string[],
  after: string[],
  seen: ReadonlySet<string>,
  emptyBefore: boolean[],
  emptyAfter: ReadonlyMap<string, boolean>,
): void {
  expect(new Set(after).size).toBe(after.length)
  const fresh = after.filter((id) => !seen.has(id))
  if (action.kind === 'undo') {
    // A peer's text patched in outside history can move a split point, and
    // with it an empty half's id; a block holding text never gets a new one.
    expect(fresh.filter((id) => emptyAfter.get(id) !== true)).toEqual([])
    return
  }
  const { index, offset, target } = acted as Acted
  if (
    (action.kind === 'enter' || action.kind === 'listEnter') &&
    after.length === before.length + 1
  ) {
    expect(fresh).toHaveLength(1)
    const added = offset === 0 ? index : index + 1
    expect(after).toEqual([...before.slice(0, added), fresh[0], ...before.slice(added)])
  } else if (action.kind === 'backspace' && after.length === before.length - 1) {
    // The joined block's id goes, unless the block before it was empty: its
    // only token, its end, is what the join removes, so the joined id stays.
    const dropped = emptyBefore[index - 1] === true ? index - 1 : index
    expect(after).toEqual(before.filter((_, i) => i !== dropped))
  } else if (action.kind === 'paste' || action.kind === 'pasteOutside') {
    expect(after.filter((id) => seen.has(id))).toEqual(before)
  } else if (action.kind === 'shiftTab') {
    // Out to just after the parent's blocks, as block mode: the same ids, reordered.
    expect(after.toSorted()).toEqual(before.toSorted())
  } else if (action.kind === 'cutPaste') {
    // The blocks cut keep their ids where they land. The block pasted into
    // joins the first of them when pasted where it starts, as a join does,
    // and an empty block, holding no token to follow, may go.
    const kept = new Set(after)
    const lost = before.filter((id) => !kept.has(id))
    expect(lost.filter((id) => id !== target && emptyBefore[before.indexOf(id)] !== true)).toEqual(
      [],
    )
  } else {
    expect(after).toEqual(before)
  }
}

/** The mock backend holds the document: every block but an empty new one, in order, at depth, with its text. */
function expectBackendHoldsDoc(ed: Editor, live: Row[]): void {
  const held = new Map(live.map(([id, , content]) => [id, content]))
  const shown: Array<[string, number]> = []
  ed.state.doc.forEach((node) => {
    const id = blockIdOf(node) as string
    const content = held.get(id)
    if (content === undefined) {
      expect(markdownOf(node)).toBe('')
      return
    }
    shown.push([id, depthOf(node)])
    expect(computeContentDelta(content, blockDocJson(node)).changed).toBe(false)
  })
  expect(live.map(([id, depth]) => [id, depth])).toEqual(shown)
}

/** Each block's parent in `rows`, the page's id for a top-level one. */
function parents(rows: readonly TreeRow[], pageId: string): Map<string, string> {
  return new Map(rows.map((row) => [row.id, row.parent_id ?? pageId]))
}

/** What a peer's change left that no save of page mode's may undo, checked after the save. */
type PeerMark =
  | { kind: 'text'; id: string; markdown: string; content: Fragment }
  | { kind: 'created'; id: string }
  | { kind: 'deleted'; id: string }
  | { kind: 'moved'; id: string; parent: string }

/**
 * Make `change` as a peer, then bring the page in as a reload does; resolves
 * what the change left, if anything is the peer's to keep.
 */
function peerChange(
  page: MockPage,
  ed: Editor,
  save: PageSaveState,
  change: PeerChange,
  textOnly: boolean,
  nextId: () => string,
  mintKept: () => string,
): PeerMark | null {
  const rows = page.rows()
  const ids = rows.map((row) => row.id)
  let mark: PeerMark | null = null
  if (change.kind === 'create') {
    const parentIds = [page.pageId, ...ids]
    const parent = parentIds[change.parent % parentIds.length] as string
    const siblings = rows.filter((row) => (row.parent_id ?? page.pageId) === parent).length
    const id = nextId()
    page.peer('create_block', {
      blockType: 'content',
      content: change.text,
      parentId: parent,
      index: change.at % (siblings + 1),
      blockId: id,
    })
    mark = { kind: 'created', id }
  } else if (ids.length > 0) {
    const id = ids[change.block % ids.length] as string
    if (change.kind === 'edit') {
      const node = nodeById(ed.state.doc, id)
      const untouched = node !== null && save.saved.get(id)?.node?.content.eq(node.content) === true
      page.peer('edit_block', { blockId: id, toText: change.text })
      if (untouched)
        mark = { kind: 'text', id, markdown: change.text, content: parse(change.text) as never }
    } else if (change.kind === 'delete') {
      page.peer('delete_block', { blockId: id })
      mark = { kind: 'deleted', id }
    } else {
      const inSubtree = new Set([id])
      for (const row of rows) if (inSubtree.has(row.parent_id ?? '')) inSubtree.add(row.id)
      const parentIds = [page.pageId, ...ids.filter((other) => !inSubtree.has(other))]
      const parent = parentIds[change.parent % parentIds.length] as string
      const siblings = rows.filter(
        (row) => (row.parent_id ?? page.pageId) === parent && row.id !== id,
      ).length
      page.peer('move_block', {
        blockId: id,
        newParentId: parent,
        newIndex: change.at % (siblings + 1),
      })
      // Checked only where nothing but text changed here: a move here would win.
      if (textOnly) mark = { kind: 'moved', id, parent }
    }
  }
  applyRemote(ed.view, save, page.rows(), mintKept)
  if (mark?.kind === 'text') {
    const shown = nodeById(ed.state.doc, mark.id)
    expect(shown === null ? null : markdownOf(shown)).toBe(serialize(parse(mark.markdown)))
    return shown === null ? null : { ...mark, content: shown.content }
  }
  return mark
}

function nodeById(doc: PMNode, id: string): PMNode | null {
  let found: PMNode | null = null
  doc.forEach((node) => {
    if (blockIdOf(node) === id) found = node
  })
  return found
}

/** No save undid `marks`: the peers' texts, creates, deletes and moves still hold. */
function expectPeersKept(ed: Editor, page: MockPage, marks: Map<string, PeerMark>): void {
  const rows = page.rows()
  const live = new Map(rows.map((row) => [row.id, row.content ?? '']))
  const parentOf = parents(rows, page.pageId)
  for (const [key, mark] of marks) {
    if (mark.kind === 'deleted') {
      expect(live.has(mark.id)).toBe(false)
      continue
    }
    const node = nodeById(ed.state.doc, mark.id)
    if (mark.kind === 'text') {
      // Edited here since, or gone: no longer the peer's text to keep.
      if (node === null || !node.content.eq(mark.content)) marks.delete(key)
      else expect(live.get(mark.id)).toBe(mark.markdown)
    } else if (mark.kind === 'created') {
      expect(live.has(mark.id)).toBe(true)
      marks.delete(key)
    } else {
      expect(parentOf.get(mark.id)).toBe(mark.parent)
      marks.delete(key)
    }
  }
}

let editor: Editor | null = null

/** No page store: the property reads the states back from the backend. */
const noStore = {
  setState: () => {},
  getState: () => ({ load: () => Promise.resolve() }),
}

/** Each live block's task state in the mock backend, where it has one. */
function backendStates(page: MockPage): Map<string, string> {
  const states = new Map<string, string>()
  for (const [id] of page.live()) {
    const state = (dispatch('get_block', { blockId: id }) as BlockRow).todo_state
    if (state !== null) states.set(id, state)
  }
  return states
}

/** Each live block's priority and dates in the mock backend, where it has one: `id:field`. */
function backendFields(page: MockPage): Map<string, string> {
  const held = new Map<string, string>()
  for (const [id] of page.live()) {
    const row = dispatch('get_block', { blockId: id }) as BlockRow
    for (const key of FIELDS) {
      const value = row[key]
      if (value !== null) held.set(`${id}:${key}`, value)
    }
  }
  return held
}

/** Each live block's properties of `PROPERTY_KEYS` in the mock backend: `id:key`. */
function backendProperties(page: MockPage): Map<string, string> {
  const held = new Map<string, string>()
  for (const [id] of page.live()) {
    for (const row of dispatch('get_properties', { blockId: id }) as PropertyRow[]) {
      if ((PROPERTY_KEYS as readonly string[]).includes(row.key)) {
        held.set(`${id}:${row.key}`, row.value_text ?? '')
      }
    }
  }
  return held
}

/** Each live block's list style in the mock backend, where it has one. */
function backendListStyles(page: MockPage): Map<string, ListStyle> {
  const held = new Map<string, ListStyle>()
  for (const [id] of page.live()) {
    const row = (dispatch('get_properties', { blockId: id }) as PropertyRow[]).find(
      (property) => property.key === 'listStyle',
    )
    if (row !== undefined) held.set(id, asListStyle(row.value_text))
  }
  return held
}

/** A list source as the editor's: a style shown at once, its write queued for after the save. */
function listSource(rows: readonly Row[]) {
  const lists = new PageLists(
    {},
    rows.map(([id, depth]) => ({ id, depth })),
  )
  const writes: Array<{ id: string; style: ListStyle; seq: number }> = []
  const source: PageListSource = {
    lists,
    setStyle: (id, style) => {
      if (lists.styleOf(id) === style) return
      writes.push({ id, style, seq: lists.want(id, style) })
    },
  }
  return { lists, writes, source }
}

/** As the editor does after the save: each style given since, through block mode's command. */
async function writeListStyles(
  save: PageSaveState,
  lists: PageLists,
  writes: Array<{ id: string; style: ListStyle; seq: number }>,
): Promise<void> {
  for (const { id, style, seq } of writes.splice(0)) {
    if (!save.saved.has(id)) {
      lists.settle(id, seq, null)
      continue
    }
    await setListStyle(id, style)
    lists.settle(id, seq, style)
  }
}

/** `content` holds each name as the space's one tag of that name, in any case. */
function expectTagsHeld(named: readonly TagToken[], content: string): void {
  const rows = dispatch('list_all_tags_in_space', { scope: SCOPE }) as Array<{
    tag_id: string
    name: string
  }>
  const ids = new Map(rows.map((row) => [row.name.toLowerCase(), row.tag_id]))
  for (const { name } of named) expect(content).toContain(`#[${ids.get(name.toLowerCase())}]`)
}

/** The `#` rule's create: a tag in the mock backend. */
function createTag(name: string): Promise<string> {
  const tag = dispatch('create_block', {
    blockType: 'tag',
    content: name,
    parentId: null,
    index: null,
    scope: SCOPE,
    blockId: null,
  }) as BlockRow
  return Promise.resolve(tag.id)
}

beforeEach(() => {
  // The tag commit's commands go to the same mock backend.
  vi.mocked(invoke).mockImplementation(async (cmd, args) => dispatch(cmd, args))
  useSpaceStore.setState({ currentSpaceId: SCOPE.space_id })
})

afterEach(() => {
  editor?.destroy()
  editor = null
})

/**
 * Each block changed and not committed since, as it was before the change: the
 * editor's record (`PageModeEditor`), kept from `ed`'s transactions.
 */
function trackLoaded(ed: Editor): Map<string, PMNode | null> {
  const loaded = new Map<string, PMNode | null>()
  ed.on('transaction', ({ transaction, appendedTransactions }) => {
    if (!transaction.docChanged || transaction.getMeta(REMOTE_PATCH) === true) return
    const maps = [transaction, ...appendedTransactions].flatMap((tr) => tr.mapping.maps)
    for (const id of changedBlocks(ed.state.doc, maps)) {
      if (!loaded.has(id)) loaded.set(id, nodeById(transaction.before, id))
    }
  })
  return loaded
}

/**
 * As the editor does after a save: a block the caret left after typing in it
 * has its task marker, its `key:: value` lines and its tags committed, then
 * the page is brought in; a task cycled goes through the checkbox's command,
 * and a priority, a date or a property through its own. `states` records the
 * state each block was given, `fields` its priority and dates, by
 * `id:field`, and `props` its properties, by `id:key`.
 */
async function commitAndCycle(
  ed: Editor,
  save: PageSaveState,
  page: MockPage,
  acted: Acted | null,
  states: Map<string, string>,
  fields: Map<string, string>,
  props: Map<string, string>,
  loaded: Map<string, PMNode | null>,
  mintKept: () => string,
): Promise<void> {
  const tagged = acted?.tagged
  const left = tagged === undefined ? null : nodeById(ed.state.doc, tagged)
  if (tagged !== undefined && left !== null) {
    // A marker typed now, or by an earlier step that could not leave the block,
    // but not one the block held before it was changed.
    const unchanged = loaded.get(tagged) ?? null
    loaded.delete(tagged)
    const held = unchanged !== null && leadingTask(unchanged) !== null
    const typed = held ? null : leadingTask(left)
    if (typed !== null) states.set(tagged, typed.todoState)
    const task = await commitPageTask(tagged, unchanged, save, page.api, noStore)
    // Each line whose key the block did not hold before it was changed: typed
    // now, or typed into a block kept as new and since moved here.
    const heldKeys = new Set(
      parseInlineProperties(unchanged === null ? '' : markdownOf(unchanged)).map(({ key }) => key),
    )
    for (const { key, value } of parseInlineProperties(task.markdown ?? '')) {
      const read = (PROPERTY_KEYS as readonly string[]).includes(key)
      if (read && !heldKeys.has(key)) props.set(`${tagged}:${key}`, value)
    }
    const lines = await commitPageProperties(tagged, unchanged, save, page.api, task.markdown)
    const named = tagsWrittenAsText(lines.markdown ?? '')
    await commitPageTags(tagged, save, page.api, lines.markdown)
    applyRemote(ed.view, save, page.rows(), mintKept)
    if (acted?.line !== undefined && save.saved.has(tagged)) {
      // A key the block held as a line before it was changed stays text.
      const { key, value } = acted.line
      const heldLine = heldKeys.has(key)
      const shown = page.live().find(([id]) => id === tagged)?.[2] ?? ''
      const lineLeft = parseInlineProperties(shown).some(
        (prop) => prop.key === key && prop.value === value,
      )
      expect(lineLeft).toBe(heldLine)
    }
    const content = page.live().find(([id]) => id === tagged)?.[2] ?? ''
    expect(tagsWrittenAsText(content)).toEqual([])
    expectTagsHeld(named, content)
    if (acted?.task !== undefined && !held) {
      // The marker left the text: it starts as it did before the marker was typed.
      const { marker, state, before } = acted.task
      expect(typed?.todoState).toBe(state)
      const text = nodeById(ed.state.doc, tagged)?.firstChild?.textContent ?? ''
      expect(text.startsWith(marker)).toBe(before.startsWith(marker))
    }
  }
  const cycled = acted?.cycled
  if (cycled !== undefined && save.saved.has(cycled)) {
    const next = nextTaskState(states.get(cycled) ?? null)
    await commands.setTodoState(cycled, next)
    if (next === null) states.delete(cycled)
    else states.set(cycled, next)
  }
  await setField(acted, save, fields)
  const property = acted?.property
  if (property !== undefined && save.saved.has(property.id)) {
    const { id, key, value } = property
    if (value === null) {
      await commands.deleteProperty(id, key)
      props.delete(`${id}:${key}`)
    } else {
      await commands.setProperty(id, key, {
        value_text: value,
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
      })
      props.set(`${id}:${key}`, value)
    }
  }
}

/** Give a block a priority or a date through its command, as the badge, the keys and the picker do. */
async function setField(acted: Acted | null, save: PageSaveState, fields: Map<string, string>) {
  const field = acted?.field
  if (field === undefined || !save.saved.has(field.id)) return
  const { id, key, value } = field
  if (key === 'priority') await commands.setPriority(id, value)
  else if (key === 'due_date') await commands.setDueDate(id, value)
  else await commands.setScheduledDate(id, value)
  if (value === null) fields.delete(`${id}:${key}`)
  else fields.set(`${id}:${key}`, value)
}

/**
 * The backend holds the style each block's marker shows, and the marker is
 * block mode's for the backend's styles over the document's blocks.
 */
function expectListsHeld(ed: Editor, page: MockPage, lists: PageLists): void {
  const held = backendListStyles(page)
  const live = new Set(page.live().map(([id]) => id))
  const items: Array<{ id: string; depth: number }> = []
  ed.state.doc.forEach((node) =>
    items.push({ id: blockIdOf(node) as string, depth: depthOf(node) }),
  )
  const shown = items
    .map(({ id }) => [id, lists.styleOf(id)] as const)
    .filter(([id, style]) => style !== 'none' && live.has(id))
  expect(held).toEqual(new Map(shown))
  const styleOf = (id: string): ListStyle => held.get(id) ?? 'none'
  const ordinals = computeListOrdinals(items, styleOf)
  expect(items.map(({ id }) => lists.markerOf(id))).toEqual(
    items.map(({ id }) => listMarkerText(styleOf(id), ordinals.get(id))),
  )
}

describe('page mode against the mock backend', () => {
  it('keeps the backend equal to the document, ids on their text, and peers’ changes', async () => {
    await fc.assert(
      fc.asyncProperty(
        rowsArb,
        fc.array(stepArb, { minLength: 1, maxLength: 14 }),
        async (rows, steps) => {
          editor?.destroy()
          const page = mockPage(rows)
          const { lists, writes, source } = listSource(rows)
          const ed = openPage(rows, undefined, createTag, source)
          editor = ed
          const save = createSaveState(page.pageId, page.rows(), ed.state.doc)
          const seen = new Set(idsOf(ed.state.doc))
          const nextPeerId = idMinter('01PEER')
          const mintKept = idMinter('01KEPT')
          const marks = new Map<string, PeerMark>()
          // The task state each block was last given, by id.
          const states = new Map<string, string>()
          // The priority and dates each block was last given, by `id:field`.
          const fields = new Map<string, string>()
          // The properties each block was last given, by `id:key`.
          const props = new Map<string, string>()
          const loaded = trackLoaded(ed)

          for (const [stepIndex, { action, peer, failures }] of steps.entries()) {
            const before = idsOf(ed.state.doc)
            const emptyBefore: boolean[] = []
            ed.state.doc.forEach((node) => emptyBefore.push(markdownOf(node) === ''))
            const acted = apply(ed, action, lists)
            const after = idsOf(ed.state.doc)
            const emptyAfter = new Map<string, boolean>()
            ed.state.doc.forEach((node) =>
              emptyAfter.set(blockIdOf(node) as string, markdownOf(node) === ''),
            )
            expectIdsKept(action, acted, before, after, seen, emptyBefore, emptyAfter)
            for (const id of after) seen.add(id)
            // A `#name` typing went on after became a tag as typed (`at-tag-picker.ts`): let it land.
            // Its promises settle before the next macrotask; a timer would sleep the worker as well.
            await new Promise((resolve) => setImmediate(resolve))

            if (peer !== null) {
              const textOnly = action.kind === 'type'
              const mark = peerChange(page, ed, save, peer, textOnly, nextPeerId, mintKept)
              if (mark !== null) marks.set(`${stepIndex}:${mark.kind}:${mark.id}`, mark)
              for (const id of idsOf(ed.state.doc)) seen.add(id)
            }

            // A block given a style is created even if empty, as the editor's `afterSave` keeps it.
            for (const { id } of writes) save.keep.add(id)
            if (failures !== null) {
              page.failWith(failures)
              await savePage(ed.state.doc, save, page.api)
              page.failWith(null)
            }
            let result = await savePage(ed.state.doc, save, page.api)
            if (result.error !== undefined) {
              // As the editor does: read the page again, bring it in, save once more.
              const { failed } = result
              const refused = failed?.kind === 'create' || failed?.kind === 'restore'
              applyRemote(ed.view, save, page.rows(), mintKept, new Set(refused ? [failed.id] : []))
              result = await savePage(ed.state.doc, save, page.api)
            }
            expect(result.error).toBeUndefined()
            // A block the save gave a new id: its old one was refused.
            for (const id of idsOf(ed.state.doc)) seen.add(id)
            save.keep.clear()
            await writeListStyles(save, lists, writes)

            await commitAndCycle(ed, save, page, acted, states, fields, props, loaded, mintKept)

            expectBackendHoldsDoc(ed, page.live())
            expectPeersKept(ed, page, marks)
            const live = new Set(page.live().map(([id]) => id))
            expect(backendStates(page)).toEqual(new Map([...states].filter(([id]) => live.has(id))))
            expect(backendFields(page)).toEqual(
              new Map([...fields].filter(([key]) => live.has(key.split(':')[0] as string))),
            )
            expect(backendProperties(page)).toEqual(
              new Map([...props].filter(([key]) => live.has(key.split(':')[0] as string))),
            )
            expectListsHeld(ed, page, lists)
          }
        },
      ),
      // fast-check counts the examples in `numRuns`, so every one runs ahead of
      // the random runs. A run is a real editor driven step by step, which is
      // this test's cost. Each CI run draws a new seed, so the count sets how
      // soon a rare sequence turns up; a deep search is a long local run.
      { numRuns: EXAMPLES.length + 50, examples: EXAMPLES },
    )
  })
})
