/**
 * Page mode's block properties (#5743): what the rows draw, and a typed
 * `key:: value` line committed once the caret has left its block.
 *
 * Equivalent mutants, accepted:
 * - `shown.length > 0` → `true` or `>= 0` in `take`: a block with no property
 *   to draw then holds its own empty list, which reads as the shared one does.
 * - `''` → any other string without a `key::` line as the text of a new block:
 *   `addedInlineProperties` reads only its keys.
 * - `return true` → `false` in the commit's edit: `commitPageProperties`
 *   ignores what `commitInlineProperties` resolves.
 */

import { invoke } from '@tauri-apps/api/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { makeBlock, withOps } from '@/__tests__/fixtures'
import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import {
  blockId,
  FakeBackend,
  openPage,
  PAGE,
  type Row,
  treeRows,
} from '@/editor/page-mode/__tests__/page-mode-fixtures'
import { commitPageProperties, PageProperties } from '@/editor/page-mode/page-properties'
import { createSaveState } from '@/editor/page-mode/page-save'
import type { PropertyRow } from '@/lib/bindings'

const B1 = blockId(1)

const NO_DEFS = { items: [], next_cursor: null, has_more: false, total_count: 0 }

const row = (key: string, value: string): PropertyRow => ({
  key,
  value_text: value,
  value_num: null,
  value_date: null,
  value_ref: null,
  value_bool: null,
})

describe('PageProperties', () => {
  it('tells its listeners of each read, until they unsubscribe', () => {
    const properties = new PageProperties({})
    const listener = vi.fn()
    const unsubscribe = properties.subscribe(listener)

    properties.take({ [B1]: [row('assignee', 'Ana')] })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(properties.of(B1).map(({ key }) => key)).toEqual(['assignee'])

    unsubscribe()
    properties.take({})
    expect(listener).toHaveBeenCalledTimes(1)
    expect(properties.of(B1)).toEqual([])
  })
})

let editor: ReturnType<typeof openPage> | null = null

/** A page whose block `B1` was saved as `markdown`, new to the page (nothing loaded before). */
function savedNew(markdown: string) {
  const rows: Row[] = [[B1, 0, markdown]]
  const backend = new FakeBackend(rows)
  editor = openPage(rows)
  return { backend, save: createSaveState(PAGE, treeRows(rows), editor.state.doc) }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  editor?.destroy()
  editor = null
})

describe('commitPageProperties', () => {
  it('makes a line typed into a new block its property, and takes the line out', async () => {
    const setProperty = vi.fn(() => withOps(makeBlock({ id: B1 })))
    vi.mocked(invoke).mockImplementation(
      mockInvokeCommands({
        get_property_def: () => null,
        list_property_defs: () => NO_DEFS,
        set_property: setProperty,
      }),
    )
    const { backend, save } = savedNew('buy milk\nassignee:: Ana')

    const result = await commitPageProperties(B1, null, save, backend)

    expect(setProperty).toHaveBeenCalledTimes(1)
    expect(result.markdown).toBe('buy milk')
    expect(backend.live()).toEqual([[B1, 0, 'buy milk']])
    expect(result.refs).toEqual([{ device_id: 'fake', seq: 1 }])
    expect(save.writes).toBe(1)
  })

  it('writes nothing when every line is refused: the text stays as saved', async () => {
    vi.mocked(invoke).mockImplementation(
      mockInvokeCommands({
        get_property_def: () => null,
        list_property_defs: () => NO_DEFS,
        set_property: () => {
          throw new Error('database locked')
        },
      }),
    )
    const { backend, save } = savedNew('buy milk\nassignee:: Ana')

    const result = await commitPageProperties(B1, null, save, backend)

    expect(result).toEqual({ refs: [], markdown: 'buy milk\nassignee:: Ana' })
    expect(backend.calls).toEqual([])
    expect(save.writes).toBe(0)
  })
})
