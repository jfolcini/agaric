/**
 * #6051 — a batch of reverses runs in one backend transaction, so one refused
 * part-way (a revive onto a name a live page holds) leaves every row and op the
 * earlier ones touched as it was. The fixture `undo_revives_no_taken_name` pins
 * `revert_ops` and `undo_ops`; this pins all four handlers, every store a
 * reverse writes, and that the refused batch hands its op sequence numbers back.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { validationCode } from '@/lib/app-error'
import { dispatch } from '@/lib/tauri-mock/handlers'
import * as seed from '@/lib/tauri-mock/seed'
import { blocks, makeBlock, opLog, properties } from '@/lib/tauri-mock/seed'

const SPACE = '01SPACEA000000000000000001'
const PAGE = '0000000000000000000000PAGE'
const CHILD = '000000000000000000000CHILD'
const OTHER_CHILD = '00000000000000000OTHERCHILD'
const TAG = '000000000000000000000000TAG'
const HOLDER = '00000000000000000000HOLDER'

interface Ref {
  device_id: string
  seq: number
}
interface Refs {
  rename: Ref
  edit: Ref
  target: Ref
  all: Ref[]
}

function refOf(index: number): Ref {
  const op = opLog[index]
  if (op === undefined) throw new Error('no op there')
  return { device_id: op.device_id, seq: op.seq }
}

function seedPage(id: string, title: string, parent: string | null, type = 'page'): void {
  blocks.set(id, {
    ...makeBlock(id, type, title, parent, 1),
    space_id: SPACE,
    page_id: type === 'content' ? parent : id,
    deleted_at: null,
  })
}

/**
 * Page `PAGE` renamed to `B` (the older op), its child edited (the newer one),
 * and then a live page `HOLDER` takes the title `A` the rename's undo restores.
 * `extra` puts ops between the two that write the other stores a reverse writes.
 */
function seedTwoOps(extra: () => void = () => {}): Refs {
  seedPage(PAGE, 'A', null)
  seedPage(CHILD, 'one', PAGE, 'content')
  dispatch('edit_block', { blockId: CHILD, toText: 'one' })
  const target = refOf(opLog.length - 1)
  dispatch('edit_block', { blockId: PAGE, toText: 'B' })
  const rename = refOf(opLog.length - 1)
  extra()
  dispatch('edit_block', { blockId: CHILD, toText: 'two' })
  const edit = refOf(opLog.length - 1)
  seedPage(HOLDER, 'A', null)
  const all = opLog
    .filter((op) => op.seq >= rename.seq)
    .map(({ device_id, seq }) => ({ device_id, seq }))
  return { rename, edit, target, all }
}

const content = (id: string): unknown => blocks.get(id)?.['content']

/** Every store the mock exports, deep-copied. */
function snapshotAll(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(seed)) {
    if (typeof value !== 'function') out[name] = structuredClone(value)
  }
  return out
}

describe('tauri-mock history handlers are all-or-nothing (#6051)', () => {
  beforeEach(() => {
    blocks.clear()
    properties.clear()
    opLog.length = 0
    seed.blockTags.clear()
    seed.attachments.clear()
    seed.attachmentBytes.clear()
    seed.pageAliases.clear()
  })

  // Newest-first, the child's edit is undone before the rename is refused.
  const handlers: Array<[string, (refs: Refs) => unknown]> = [
    ['revert_ops', ({ rename, edit }) => dispatch('revert_ops', { ops: [rename, edit] })],
    ['undo_ops', ({ rename, edit }) => dispatch('undo_ops', { ops: [rename, edit] })],
    [
      'undo_page_group',
      () => dispatch('undo_page_group', { pageId: PAGE, depth: 0, windowMs: 60_000 }),
    ],
    [
      'restore_page_to_op',
      ({ target }) =>
        dispatch('restore_page_to_op', {
          pageId: '__all__',
          targetDeviceId: target.device_id,
          targetSeq: target.seq,
        }),
    ],
  ]

  it.each(handlers)('%s refused part-way changes nothing', (_, run) => {
    const refs = seedTwoOps()
    const opsBefore = opLog.length
    const lastSeq = opLog.at(-1)?.seq ?? 0

    let thrown: unknown = null
    try {
      run(refs)
    } catch (err) {
      thrown = err
    }

    expect(validationCode(thrown)).toBe('DuplicatePageTitle')
    expect({ page: content(PAGE), child: content(CHILD), ops: opLog.length }).toEqual({
      page: 'B',
      child: 'two',
      ops: opsBefore,
    })
    dispatch('edit_block', { blockId: CHILD, toText: 'three' })
    expect(opLog.at(-1)?.seq).toBe(lastSeq + 1)
  })

  it('puts back every store a reverse writes', () => {
    const refs = seedTwoOps(() => {
      seedPage(OTHER_CHILD, 'two', PAGE, 'content')
      seedPage(TAG, 'tg', null, 'tag')
      const first = dispatch('add_attachment_with_bytes', {
        blockId: CHILD,
        filename: 'a.txt',
        mimeType: 'text/plain',
        bytes: [1, 2, 3],
      }) as { id: string }
      const second = dispatch('add_attachment_with_bytes', {
        blockId: CHILD,
        filename: 'b.txt',
        mimeType: 'text/plain',
        bytes: [4],
      }) as { id: string }
      dispatch('rename_attachment', { attachmentId: first.id, newFilename: 'c.txt' })
      dispatch('delete_attachment', { attachmentId: second.id })
      dispatch('set_property', {
        blockId: CHILD,
        key: 'k',
        value: {
          value_text: 'v',
          value_num: null,
          value_date: null,
          value_ref: null,
          value_bool: null,
        },
      })
      dispatch('add_tag', { blockId: CHILD, tagId: TAG })
      dispatch('set_page_aliases', { pageId: PAGE, aliases: ['al'] })
      dispatch('create_property_def', { spaceId: SPACE, key: 'lvl', valueType: 'text' })
      dispatch('delete_block', { blockId: OTHER_CHILD })
    })
    const before = snapshotAll()

    let thrown: unknown = null
    try {
      dispatch('revert_ops', { ops: refs.all })
    } catch (err) {
      thrown = err
    }

    expect(validationCode(thrown)).toBe('DuplicatePageTitle')
    expect(snapshotAll()).toEqual(before)
  })
})
