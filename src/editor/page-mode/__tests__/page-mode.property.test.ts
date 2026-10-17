/**
 * Page mode end to end against the mock backend (#5691): a random run of
 * typing, Enter, Backspace, Tab, Shift+Tab, paste and undo, each step perhaps
 * followed by a peer's edit before the save, and perhaps by a save whose
 * commands fail before a clean one. After every clean save:
 *
 * - the mock backend's page equals the document: ids, depth, order and text
 *   (an empty block new in the document may be missing: it is created once it
 *   holds something);
 * - an id that survives a step stays on the text it was on: a step that only
 *   types or indents keeps every id, Enter adds one new id beside the block it
 *   splits, a join drops only the joined block's, a paste only adds new ones,
 *   and an undo gives no block holding text an id not seen before;
 * - a peer's edit of a block untouched since its last save shows at once, and
 *   is never written back over until the block is edited here.
 *
 * The backend is `src/lib/tauri-mock`, the conformance-pinned stand-in for the
 * real one, driven through its own command handlers. It accepts a create of an
 * id it already holds, which the real `create_block` refuses; the API below
 * refuses it as the backend does.
 */

import type { Editor } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import type { Fragment, Node as PMNode } from '@tiptap/pm/model'
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'

import { computeContentDelta } from '@/editor/content-delta'
import { parse, serialize } from '@/editor/markdown-serializer'
import {
  blockId,
  caret,
  idsOf,
  markdownOf,
  openPage,
  posIn,
  press,
  type Row,
  type,
} from '@/editor/page-mode/__tests__/page-mode-fixtures'
import { blockDocJson, blockIdOf, depthOf } from '@/editor/page-mode/page-document'
import {
  createSaveState,
  type PageSaveApi,
  savePage,
  type TreeRow,
} from '@/editor/page-mode/page-save'
import { adoptPatched, remotePatch } from '@/editor/page-mode/remote-patch'
import type { BlockRow, OpRef } from '@/lib/bindings'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { blocks as mockBlocks, seedBlocks } from '@/lib/tauri-mock/seed'
import { buildFlatTree } from '@/lib/tree-utils'

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
  peerEdit: (id: string, markdown: string) => void
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
    peerEdit: (id, markdown) => {
      dispatch('edit_block', { blockId: id, toText: markdown })
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
  fc.record({ kind: fc.constant('undo' as const) }),
)
type Action = typeof actionArb extends fc.Arbitrary<infer T> ? T : never

const stepArb = fc.record({
  action: actionArb,
  peer: fc.option(fc.record({ block: fc.nat(), text: textArb.map((t) => `peer ${t}`) }), {
    freq: 3,
  }),
  failures: fc.option(fc.integer({ min: 1, max: 0xffff }), { freq: 4 }),
})

function nodeById(doc: PMNode, id: string): PMNode {
  let found: PMNode | null = null
  doc.forEach((node) => {
    if (blockIdOf(node) === id) found = node
  })
  if (found === null) throw new Error(`no block ${id} in the document`)
  return found
}

function firstTextLength(ed: Editor, index: number): number {
  return ed.state.doc.child(index).firstChild?.textContent.length ?? 0
}

/** Apply `action`; resolves the index of the block it acted on, if any. */
function apply(ed: Editor, action: Action): { index: number; offset: number } | null {
  const count = ed.state.doc.childCount
  if (action.kind === 'undo') {
    ed.commands.undo()
    return null
  }
  ed.view.dispatch(closeHistory(ed.state.tr))
  if (action.kind === 'paste') {
    const from = action.from % count
    const last = Math.min(count - 1, from + action.count - 1)
    ed.commands.setTextSelection({
      from: posIn(ed, from, 0),
      to: posIn(ed, last, firstTextLength(ed, last)),
    })
    const data = new DataTransfer()
    ed.view.dom.dispatchEvent(
      new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }),
    )
    const to = action.to % count
    const offset = action.at % (firstTextLength(ed, to) + 1)
    caret(ed, to, offset)
    ed.view.pasteHTML(data.getData('text/html'))
    return { index: to, offset }
  }
  const index = action.block % count
  const offset = 'at' in action ? action.at % (firstTextLength(ed, index) + 1) : 0
  caret(ed, index, offset)
  if (action.kind === 'type') type(ed, action.text)
  else if (action.kind === 'enter') press(ed, 'Enter')
  else if (action.kind === 'backspace') press(ed, 'Backspace')
  else press(ed, 'Tab', { shiftKey: action.kind === 'shiftTab' })
  return { index, offset }
}

/** Where `action` may have put ids: `before` the step, `after` it, `seen` in every earlier state. */
function expectIdsKept(
  action: Action,
  acted: { index: number; offset: number } | null,
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
  const { index, offset } = acted as { index: number; offset: number }
  if (action.kind === 'enter' && after.length === before.length + 1) {
    expect(fresh).toHaveLength(1)
    const added = offset === 0 ? index : index + 1
    expect(after).toEqual([...before.slice(0, added), fresh[0], ...before.slice(added)])
  } else if (action.kind === 'backspace' && after.length === before.length - 1) {
    // The joined block's id goes, unless the block before it was empty: its
    // only token, its end, is what the join removes, so the joined id stays.
    const dropped = emptyBefore[index - 1] === true ? index - 1 : index
    expect(after).toEqual(before.filter((_, i) => i !== dropped))
  } else if (action.kind === 'paste') {
    expect(after.filter((id) => seen.has(id))).toEqual(before)
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

let editor: Editor | null = null

afterEach(() => {
  editor?.destroy()
  editor = null
})

describe('page mode against the mock backend', () => {
  it('keeps the backend equal to the document, ids on their text, and peers’ edits', async () => {
    await fc.assert(
      fc.asyncProperty(
        rowsArb,
        fc.array(stepArb, { minLength: 1, maxLength: 14 }),
        async (rows, steps) => {
          editor?.destroy()
          const page = mockPage(rows)
          const ed = openPage(rows)
          editor = ed
          const save = createSaveState(page.pageId, page.rows(), ed.state.doc)
          const seen = new Set(idsOf(ed.state.doc))
          // A peer's text per block, with the content it was patched in as.
          const peerText = new Map<string, { markdown: string; content: Fragment }>()

          for (const { action, peer, failures } of steps) {
            const before = idsOf(ed.state.doc)
            const emptyBefore: boolean[] = []
            ed.state.doc.forEach((node) => emptyBefore.push(markdownOf(node) === ''))
            const acted = apply(ed, action)
            const after = idsOf(ed.state.doc)
            const emptyAfter = new Map<string, boolean>()
            ed.state.doc.forEach((node) =>
              emptyAfter.set(blockIdOf(node) as string, markdownOf(node) === ''),
            )
            expectIdsKept(action, acted, before, after, seen, emptyBefore, emptyAfter)
            for (const id of after) seen.add(id)

            if (peer !== null) {
              const node = ed.state.doc.child(peer.block % ed.state.doc.childCount)
              const id = blockIdOf(node) as string
              if (save.saved.has(id)) {
                const untouched = save.saved.get(id)?.node?.content.eq(node.content) === true
                page.peerEdit(id, peer.text)
                const patch = remotePatch(ed.state, save, await page.api.tree())
                if (patch !== null) {
                  ed.view.dispatch(patch.tr)
                  adoptPatched(ed.state.doc, save, patch.patched)
                }
                const shown = nodeById(ed.state.doc, id)
                if (untouched) {
                  expect(markdownOf(shown)).toBe(serialize(parse(peer.text)))
                  peerText.set(id, { markdown: peer.text, content: shown.content })
                } else {
                  // Edited here and not saved: the local text wins at the save.
                  peerText.delete(id)
                }
              }
            }

            if (failures !== null) {
              page.failWith(failures)
              await savePage(ed.state.doc, save, page.api)
              page.failWith(null)
            }
            const result = await savePage(ed.state.doc, save, page.api)
            expect(result.error).toBeUndefined()

            const live = page.live()
            expectBackendHoldsDoc(ed, live)
            const held = new Map(live.map(([id, , content]) => [id, content]))
            ed.state.doc.forEach((node) => {
              const id = blockIdOf(node) as string
              const peerEdit = peerText.get(id)
              if (peerEdit === undefined) return
              // Edited here since: no longer the peer's text to keep.
              if (!node.content.eq(peerEdit.content)) peerText.delete(id)
              else expect(held.get(id)).toBe(peerEdit.markdown)
            })
          }
        },
      ),
      { numRuns: 120 },
    )
  })
})
