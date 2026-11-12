/**
 * #6607: the table's own row and column edits (move, sort, add at the end) on the
 * schema both editors run (`contentExtensions`). Each is one transaction, so one undo
 * takes it back; the header row stays first; the result is the Markdown the block
 * saves, and that Markdown parses back to the same table.
 */

import { Editor, type JSONContent } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { parse, serialize } from '@/editor/markdown-serializer'
import {
  addTableColumnAtEnd,
  addTableRowAtEnd,
  moveTableColumnTo,
  moveTableRowTo,
  sortTableByColumn,
  tableCaret,
} from '@/editor/table-edit'
import type { DocNode } from '@/editor/types'
import { contentExtensions } from '@/editor/use-roving-editor'
import { __resetPlatformCacheForTests } from '@/lib/platform'

const TABLE = [
  '| Name | Qty | Due |',
  '| --- | ---: | --- |',
  '| pear | 10 | 2026-03-01 |',
  '| apple | 9 | 2025-12-24 |',
  '| fig |  | 2026-01-15 |',
].join('\n')

let editor: Editor | undefined

afterEach(() => {
  editor?.destroy()
  editor = undefined
})

function setup(markdown = TABLE): Editor {
  const groups = contentExtensions({
    resolveTagName: (id) => id,
    resolveBlockTitle: (id) => id,
    resolveBlockStatus: () => 'active',
    resolveTagStatus: () => 'active',
    onNavigate: () => {},
    onTagClick: () => {},
    searchTags: () => [],
    onCreateTag: (name) => Promise.resolve(name),
    searchPages: () => [],
    onCreatePage: (label) => Promise.resolve(label),
    searchBlockRefs: () => [],
    listInputRules: true,
  })
  editor = new Editor({
    element: document.createElement('div'),
    extensions: [Document, ...Object.values(groups).flat()],
    content: parse(markdown) as unknown as JSONContent,
  })
  return editor
}

function caretInCell(ed: Editor, text: string): void {
  let at = -1
  ed.state.doc.descendants((node, pos) => {
    if (at === -1 && node.type.name === 'paragraph' && node.textContent === text) at = pos + 1
    return at === -1
  })
  expect(at, `no cell holds ${text}`).toBeGreaterThan(0)
  ed.commands.setTextSelection(at)
}

/** The block's saved Markdown, checked to parse back to the table it came from. */
function saved(ed: Editor): string {
  const md = serialize(ed.getJSON() as DocNode)
  expect(serialize(parse(md))).toBe(md)
  return md
}

function caretCell(ed: Editor): { row: number; col: number } | null {
  const at = tableCaret(ed.state)
  return at === null ? null : { row: at.row, col: at.col }
}

const rows = (...lines: string[]) => lines.join('\n')
const HEAD = rows('| Name | Qty | Due |', '| --- | ---: | --- |')

describe('moveTableRowTo', () => {
  it('moves the caret row among the body rows and keeps the caret in it', () => {
    const ed = setup()
    caretInCell(ed, 'pear')
    expect(moveTableRowTo(ed, 3)).toBe(true)
    expect(saved(ed)).toBe(
      rows(
        HEAD,
        '| apple | 9 | 2025-12-24 |',
        '| fig |  | 2026-01-15 |',
        '| pear | 10 | 2026-03-01 |',
      ),
    )
    expect(caretCell(ed)).toEqual({ row: 3, col: 0 })
  })

  it('is one undo step', () => {
    const ed = setup()
    caretInCell(ed, 'fig')
    expect(moveTableRowTo(ed, 1)).toBe(true)
    expect(moveTableRowTo(ed, 2)).toBe(true)
    ed.commands.undo()
    expect(saved(ed)).toBe(
      rows(
        HEAD,
        '| fig |  | 2026-01-15 |',
        '| pear | 10 | 2026-03-01 |',
        '| apple | 9 | 2025-12-24 |',
      ),
    )
    ed.commands.undo()
    expect(saved(ed)).toBe(TABLE)
  })

  it('never moves the header row, nor a row above it', () => {
    const ed = setup()
    caretInCell(ed, 'Name')
    expect(moveTableRowTo(ed, 2)).toBe(false)
    caretInCell(ed, 'apple')
    expect(moveTableRowTo(ed, 0)).toBe(false)
    expect(moveTableRowTo(ed, 4)).toBe(false)
    expect(moveTableRowTo(ed, 2)).toBe(false)
    expect(saved(ed)).toBe(TABLE)
  })
})

describe('moveTableColumnTo', () => {
  it('moves the caret column, header cell and alignment with it', () => {
    const ed = setup()
    caretInCell(ed, '9')
    expect(moveTableColumnTo(ed, 0)).toBe(true)
    expect(saved(ed)).toBe(
      rows(
        '| Qty | Name | Due |',
        '| ---: | --- | --- |',
        '| 10 | pear | 2026-03-01 |',
        '| 9 | apple | 2025-12-24 |',
        '|  | fig | 2026-01-15 |',
      ),
    )
    expect(caretCell(ed)).toEqual({ row: 2, col: 0 })
    ed.commands.undo()
    expect(saved(ed)).toBe(TABLE)
  })

  it('keeps a short row’s cells under their headers', () => {
    const ed = setup('| a | b | c |\n| --- | --- | --- |\n| 1 | 2 |\n| 3 | 4 | 5 |')
    caretInCell(ed, 'c')
    expect(moveTableColumnTo(ed, 0)).toBe(true)
    expect(saved(ed)).toBe('| c | a | b |\n| --- | --- | --- |\n|  | 1 | 2 |\n| 5 | 3 | 4 |')
  })

  it('refuses a column outside the table', () => {
    const ed = setup()
    caretInCell(ed, 'Due')
    expect(moveTableColumnTo(ed, 3)).toBe(false)
    expect(moveTableColumnTo(ed, -1)).toBe(false)
    expect(saved(ed)).toBe(TABLE)
  })
})

describe('sortTableByColumn', () => {
  it('sorts the body rows by the caret column as numbers, empty last, header kept', () => {
    const ed = setup()
    caretInCell(ed, 'Qty')
    expect(sortTableByColumn(ed, 'asc')).toBe(true)
    expect(saved(ed)).toBe(
      rows(
        HEAD,
        '| apple | 9 | 2025-12-24 |',
        '| pear | 10 | 2026-03-01 |',
        '| fig |  | 2026-01-15 |',
      ),
    )
    expect(caretCell(ed)).toEqual({ row: 0, col: 1 })
  })

  it('sorts dates descending, as one undo step', () => {
    const ed = setup()
    caretInCell(ed, '2025-12-24')
    expect(sortTableByColumn(ed, 'desc')).toBe(true)
    expect(saved(ed)).toBe(
      rows(
        HEAD,
        '| pear | 10 | 2026-03-01 |',
        '| fig |  | 2026-01-15 |',
        '| apple | 9 | 2025-12-24 |',
      ),
    )
    ed.commands.undo()
    expect(saved(ed)).toBe(TABLE)
  })

  it('writes nothing when the rows are already in order', () => {
    const sortedTable = '| n |\n| --- |\n| 1 |\n| 2 |\n|  |'
    const ed = setup(sortedTable)
    caretInCell(ed, '2')
    expect(sortTableByColumn(ed, 'asc')).toBe(false)
    expect(saved(ed)).toBe(sortedTable)
  })
})

describe('adding at the end', () => {
  it('adds a body row under the last one and puts the caret in it', () => {
    const ed = setup()
    caretInCell(ed, 'Qty')
    expect(addTableRowAtEnd(ed)).toBe(true)
    expect(saved(ed)).toBe(`${TABLE}\n|  |  |  |`)
    expect(caretCell(ed)).toEqual({ row: 4, col: 1 })
  })

  it('adds a column after the last one, a header cell on top, and puts the caret in it', () => {
    const ed = setup('| a | b |\n| --- | --- |\n| 1 | 2 |')
    caretInCell(ed, '1')
    expect(addTableColumnAtEnd(ed)).toBe(true)
    expect(saved(ed)).toBe('| a | b |  |\n| --- | --- | --- |\n| 1 | 2 |  |')
    expect(caretCell(ed)).toEqual({ row: 1, col: 2 })
    expect(ed.state.doc.firstChild?.firstChild?.lastChild?.type.name).toBe('tableHeader')
  })
})

describe('outside a table', () => {
  it('does nothing', () => {
    const ed = setup('plain text')
    expect(tableCaret(ed.state)).toBeNull()
    expect(moveTableRowTo(ed, 1)).toBe(false)
    expect(moveTableColumnTo(ed, 1)).toBe(false)
    expect(sortTableByColumn(ed, 'asc')).toBe(false)
    expect(addTableRowAtEnd(ed)).toBe(false)
    expect(addTableColumnAtEnd(ed)).toBe(false)
    expect(saved(ed)).toBe('plain text')
  })
})

describe('the move chords', () => {
  function press(ed: Editor, key: string): boolean {
    const event = new KeyboardEvent('keydown', { key, altKey: true, shiftKey: true })
    return ed.view.someProp('handleKeyDown', (f) => f(ed.view, event)) ?? false
  }

  it('Alt+Shift+arrows move the caret row and column, in both editors', () => {
    const ed = setup()
    caretInCell(ed, 'apple')
    expect(press(ed, 'ArrowDown')).toBe(true)
    expect(caretCell(ed)).toEqual({ row: 3, col: 0 })
    expect(press(ed, 'ArrowUp')).toBe(true)
    expect(press(ed, 'ArrowUp')).toBe(true)
    expect(caretCell(ed)).toEqual({ row: 1, col: 0 })
    expect(press(ed, 'ArrowRight')).toBe(true)
    expect(saved(ed)).toBe(
      rows(
        '| Qty | Name | Due |',
        '| ---: | --- | --- |',
        '| 9 | apple | 2025-12-24 |',
        '| 10 | pear | 2026-03-01 |',
        '|  | fig | 2026-01-15 |',
      ),
    )
    expect(press(ed, 'ArrowLeft')).toBe(true)
    expect(caretCell(ed)).toEqual({ row: 1, col: 0 })
  })

  it('leave Option+Shift+arrows to the selection on macOS', () => {
    const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
    __resetPlatformCacheForTests()
    try {
      const ed = setup()
      caretInCell(ed, 'apple')
      const before = saved(ed)
      expect(press(ed, 'ArrowDown')).toBe(false)
      expect(press(ed, 'ArrowRight')).toBe(false)
      expect(saved(ed)).toBe(before)
    } finally {
      platform.mockRestore()
      __resetPlatformCacheForTests()
    }
  })

  it('are left to the editor outside a table', () => {
    const ed = setup('plain text')
    expect(press(ed, 'ArrowUp')).toBe(false)
  })
})
