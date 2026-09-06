/**
 * #4723 — page titles are unique per space, on the mock as on the backend.
 *
 * The conformance runner replays raw `OpPayload`s below command-level
 * validation, so it cannot drive a resolve-or-create or a refusal; the mock's
 * rule is pinned here against its Rust twins (`create_page_in_space_*` in
 * `src-tauri/src/commands/spaces.rs`, `edit_block_*_page_title*` in
 * `src-tauri/tests/commands/block_cmd_tests.rs`).
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { validationCode } from '@/lib/app-error'
import { dispatch } from '@/lib/tauri-mock/handlers'
import {
  blockTags,
  blocks,
  makeBlock,
  opLog,
  properties,
  propertyDefs,
} from '@/lib/tauri-mock/seed'

const SPACE_A = '01SPACEA000000000000000001'
const SPACE_B = '01SPACEB000000000000000001'
const HOME_A = '0000000000000000000000HOMEA'
const OTHER_A = '000000000000000000000OTHERA'
const BETA_B = '0000000000000000000000BETAB'

function seedPage(id: string, title: string, spaceId: string, position: number): void {
  blocks.set(id, makeBlock(id, 'page', title, null, position))
  properties.set(
    id,
    new Map([
      [
        'space',
        {
          key: 'space',
          value_text: null,
          value_num: null,
          value_date: null,
          value_ref: spaceId,
          value_bool: null,
        },
      ],
    ]),
  )
}

describe('tauri-mock page-title uniqueness (#4723)', () => {
  beforeEach(() => {
    blocks.clear()
    properties.clear()
    blockTags.clear()
    propertyDefs.clear()
    opLog.length = 0
    seedPage(HOME_A, 'Home', SPACE_A, 1)
    seedPage(OTHER_A, 'Other', SPACE_A, 2)
    seedPage(BETA_B, 'Beta', SPACE_B, 3)
  })

  it('create_page_in_space resolves to the live page already titled that way in the space', () => {
    const id = dispatch('create_page_in_space', {
      parentId: null,
      content: 'Home',
      spaceId: SPACE_A,
    })

    expect(id).toBe(HOME_A)
    expect(blocks.size).toBe(3)
    expect(opLog.length).toBe(0)
  })

  it('create_page_in_space with a title held only in another space creates a second page', () => {
    const id = dispatch('create_page_in_space', {
      parentId: null,
      content: 'Home',
      spaceId: SPACE_B,
    }) as string

    expect(id).not.toBe(HOME_A)
    expect(blocks.get(id)?.['content']).toBe('Home')
    expect(properties.get(id)?.get('space')?.['value_ref']).toBe(SPACE_B)
    expect(opLog.map((o) => o.op_type)).toEqual(['create_block'])
  })

  it('edit_block refuses a page rename to a title held in the same space, coded DuplicatePageTitle', () => {
    let thrown: unknown = null
    try {
      dispatch('edit_block', { blockId: OTHER_A, toText: 'Home' })
    } catch (err) {
      thrown = err
    }

    expect(validationCode(thrown)).toBe('DuplicatePageTitle')
    expect(blocks.get(OTHER_A)?.['content']).toBe('Other')
    expect(opLog.length).toBe(0)
  })

  it('edit_block lets a page keep its own title and take one held only in another space', () => {
    dispatch('edit_block', { blockId: HOME_A, toText: 'Home' })
    dispatch('edit_block', { blockId: OTHER_A, toText: 'Beta' })

    expect(blocks.get(HOME_A)?.['content']).toBe('Home')
    expect(blocks.get(OTHER_A)?.['content']).toBe('Beta')
    expect(opLog.map((o) => o.op_type)).toEqual(['edit_block', 'edit_block'])
  })
})
