/**
 * Parity between the block editor's toolbar and block menu and *Edit as
 * Markdown*'s (#5160 D-c): every action either has the buffer's own version
 * or is left out of the buffer with a reason, as the conformance waivers are.
 * The toolbar's actions are read from its config, every button it can show
 * (the table ops included) and Format's marks; the block menu's from its ids,
 * which each of its rows must carry.
 */

import type { Editor } from '@tiptap/react'
import { describe, expect, it } from 'vitest'

import {
  BLOCK_MENU_ACTION_IDS,
  type BlockMenuActionId,
} from '@/components/editor/block-context-menu/types'
import { buildToolbarItems } from '@/components/FormattingToolbar/items'
import {
  SOURCE_MARKS,
  SOURCE_MENU_EXCLUDED,
  SOURCE_MENU_ROWS,
  SOURCE_TOOLBAR_ACTIONS,
  SOURCE_TOOLBAR_EXCLUDED,
  SOURCE_TOOLBAR_MENUS,
} from '@/components/pages/source-toolbar-actions'
import {
  createHistoryButtons,
  createMarkToggles,
  createMetadataButtons,
  createRefsAndBlocks,
  createStructureButtons,
} from '@/lib/toolbar-config'

// The config only closes over the editor; no button is pressed here.
const editor = {} as Editor

const TOOLBAR_IDS = buildToolbarItems(
  {
    refsAndBlocks: createRefsAndBlocks(editor),
    structureButtons: createStructureButtons(editor),
    metadataButtons: createMetadataButtons(),
    historyButtons: createHistoryButtons(editor),
  },
  { includeTableOps: true },
).flatMap((item) => (item.kind === 'button' ? [item.key] : []))

const MARK_IDS = createMarkToggles(editor).map((mark) => mark.label)

const doneInBuffer = (id: string): boolean =>
  id in SOURCE_TOOLBAR_ACTIONS || SOURCE_TOOLBAR_MENUS.has(id)

describe('the toolbar', () => {
  it('reads every button the block editor’s toolbar can show', () => {
    expect(TOOLBAR_IDS).toContain('toolbar.format')
    expect(TOOLBAR_IDS).toContain('toolbar.tableOps')
    expect(TOOLBAR_IDS).toHaveLength(new Set(TOOLBAR_IDS).size)
  })

  it.each(TOOLBAR_IDS)('%s is done in the buffer, or left out with a reason', (id) => {
    const reason = SOURCE_TOOLBAR_EXCLUDED[id]
    expect(doneInBuffer(id) || reason !== undefined).toBe(true)
    expect(doneInBuffer(id) && reason !== undefined).toBe(false)
    if (reason !== undefined) expect(reason.trim()).not.toBe('')
  })

  it('names no button the block editor does not have', () => {
    const named = [
      ...Object.keys(SOURCE_TOOLBAR_ACTIONS),
      ...SOURCE_TOOLBAR_MENUS,
      ...Object.keys(SOURCE_TOOLBAR_EXCLUDED),
    ]
    expect(named.filter((id) => !TOOLBAR_IDS.includes(id))).toEqual([])
  })

  it.each(MARK_IDS)('Format’s %s is written as markdown', (id) => {
    expect(SOURCE_MARKS[id]?.every((delimiter) => delimiter !== '')).toBe(true)
  })

  it('names no mark the block editor does not have', () => {
    expect(Object.keys(SOURCE_MARKS).filter((id) => !MARK_IDS.includes(id))).toEqual([])
  })
})

describe('the block menu', () => {
  it.each([...BLOCK_MENU_ACTION_IDS])(
    '%s is in the buffer’s menu, or left out with a reason',
    (id: BlockMenuActionId) => {
      const reason = SOURCE_MENU_EXCLUDED[id]
      expect(SOURCE_MENU_ROWS.has(id) || reason !== undefined).toBe(true)
      expect(SOURCE_MENU_ROWS.has(id) && reason !== undefined).toBe(false)
      if (reason !== undefined) expect(reason.trim()).not.toBe('')
    },
  )

  it('names no row the block menu does not have', () => {
    const named = [...SOURCE_MENU_ROWS, ...Object.keys(SOURCE_MENU_EXCLUDED)]
    const known: readonly string[] = BLOCK_MENU_ACTION_IDS
    expect(named.filter((id) => !known.includes(id))).toEqual([])
  })
})
