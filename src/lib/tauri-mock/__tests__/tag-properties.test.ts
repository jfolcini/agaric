/**
 * #6755 — the mock's tag suggested properties (`commands/tag_properties.rs`):
 * `tag_properties` takes a list of keys a user can set, a directly tagged
 * block is offered its tags' keys and those of the tags their names nest
 * under, and "Set on tagged blocks" counts, refuses a stale count and writes
 * one op per block that one `undo_ops` reverts. The backend half is pinned by
 * `tag_properties_cmd_tests.rs` and the `tag_properties` conformance fixture.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { validationCode } from '@/lib/app-error'
import type { OpRef } from '@/lib/bindings'
import { dispatch } from '@/lib/tauri-mock/handlers'
import {
  blocks,
  blockTags,
  makeBlock,
  properties,
  SEED_IDS,
  seedBlocks,
} from '@/lib/tauri-mock/seed'

const WORK = SEED_IDS.TAG_WORK
const MTG_1 = SEED_IDS.BLOCK_MTG_1
const PROJ_1 = SEED_IDS.BLOCK_PROJ_1
const PROJ_2 = SEED_IDS.BLOCK_PROJ_2
const GS_4 = SEED_IDS.BLOCK_GS_4
const DEEP = '00000000000000000000DEEPTG'

/** `dispatch` throws its refusals synchronously; this hands them back as a rejection. */
async function call(cmd: string, args: Record<string, unknown>): Promise<unknown> {
  return dispatch(cmd, args)
}

function setKeys(tagId: string, keys: unknown[]): Promise<unknown> {
  return call('set_property', {
    blockId: tagId,
    key: 'tag_properties',
    value: { value_list: keys },
  })
}

function write(value: string, includeNested: boolean, overwrite: boolean) {
  return {
    tag_id: WORK,
    key: 'context',
    value: { value_text: value },
    include_nested: includeNested,
    overwrite,
  }
}

function text(blockId: string, key: string): unknown {
  return properties.get(blockId)?.get(key)?.['value_text'] ?? null
}

beforeEach(() => {
  seedBlocks()
  // `work/deep`, a tag nested under `work`, on the second project block only.
  const deep = makeBlock(DEEP, 'tag', 'work/deep', null, 3)
  deep['space_id'] = blocks.get(WORK)?.['space_id']
  blocks.set(DEEP, deep)
  blockTags.set(PROJ_2, new Set([DEEP]))
})

describe('tag_properties', () => {
  it('takes a list of user keys and refuses anything else', async () => {
    await setKeys(WORK, ['context', 'effort'])
    for (const bad of [['bad key'], ['due_date'], ['template'], [1]]) {
      await expect(setKeys(WORK, bad)).rejects.toMatchObject({
        message: expect.stringContaining('lists property keys a user can set'),
      })
    }
    await expect(
      call('set_property', { blockId: WORK, key: 'tag_properties', value: { value_text: 'x' } }),
    ).rejects.toMatchObject({ message: expect.stringContaining('holds a list') })
    expect(properties.get(WORK)?.get('tag_properties')?.['value_list']).toEqual([
      'context',
      'effort',
    ])
  })
})

describe('list_suggested_properties', () => {
  it("offers a directly tagged block its tags' keys and its parents', minus held ones", async () => {
    await setKeys(WORK, ['context', 'effort'])
    await setKeys(DEEP, ['effort', 'pages'])
    // MTG_1 holds `context` already.
    expect(await dispatch('list_suggested_properties', { blockId: MTG_1 })).toEqual([
      { key: 'effort', tag_id: WORK, tag_name: 'work' },
    ])
    expect(await dispatch('list_suggested_properties', { blockId: PROJ_2 })).toEqual([
      { key: 'context', tag_id: WORK, tag_name: 'work' },
      { key: 'effort', tag_id: WORK, tag_name: 'work' },
      { key: 'pages', tag_id: DEEP, tag_name: 'work/deep' },
    ])
  })

  it('offers nothing to a block in the Trash', async () => {
    await setKeys(WORK, ['effort'])
    await dispatch('delete_block', { blockId: PROJ_1 })
    expect(await dispatch('list_suggested_properties', { blockId: PROJ_1 })).toEqual([])
  })
})

describe('set_property_on_tagged_blocks', () => {
  it('counts, refuses a stale count, writes, and undoes as one', async () => {
    // PROJ_1 and GS_4 (an inline `#work`) lack `context`, MTG_1 holds
    // `@office`, PROJ_2 is on `work/deep` only.
    expect(
      await dispatch('preview_set_property_on_tagged_blocks', {
        write: write('@home', false, false),
      }),
    ).toEqual({ added: 2, changed: 0 })
    expect(
      await dispatch('preview_set_property_on_tagged_blocks', {
        write: write('@home', true, true),
      }),
    ).toEqual({ added: 3, changed: 1 })

    const stale = await call('set_property_on_tagged_blocks', {
      write: write('@home', true, true),
      acknowledged: { added: 1, changed: 0 },
    }).catch((err: unknown) => err)
    expect(validationCode(stale)).toBe('UnacknowledgedPropertyLoss')
    expect(text(PROJ_1, 'context')).toBeNull()

    const done = (await dispatch('set_property_on_tagged_blocks', {
      write: write('@home', true, true),
      acknowledged: { added: 3, changed: 1 },
    })) as { op_refs: OpRef[] }
    expect(done.op_refs).toHaveLength(4)
    for (const id of [PROJ_1, PROJ_2, MTG_1, GS_4]) expect(text(id, 'context')).toBe('@home')

    await dispatch('undo_ops', { ops: done.op_refs })
    expect(text(PROJ_1, 'context')).toBeNull()
    expect(text(PROJ_2, 'context')).toBeNull()
    expect(text(GS_4, 'context')).toBeNull()
    expect(text(MTG_1, 'context')).toBe('@office')
  })

  it('refuses a missing tag and a built-in key', async () => {
    await expect(
      call('preview_set_property_on_tagged_blocks', {
        write: { ...write('x', false, false), tag_id: PROJ_1 },
      }),
    ).rejects.toMatchObject({ kind: 'not_found' })
    const builtin = await call('preview_set_property_on_tagged_blocks', {
      write: { ...write('TODO', false, false), key: 'todo_state' },
    }).catch((err: unknown) => err)
    expect(validationCode(builtin)).toBe('BuiltinPropertyLocked')
  })
})
