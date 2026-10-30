/**
 * #5691 G2b — the mock's `get_page_buffer` and `apply_page_source` in the
 * Document dialect against `conformance/document-lines.vectors.json`, which
 * Rust authors (`markdown_document_tests.rs`). A page holding each case's tree
 * gives the case's text, each line beside its id, and that buffer saved as it
 * is appends nothing. Each case's text and each typed text, saved to an empty
 * page, creates its tree's blocks, with the markers and property lines the
 * tree gives them.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

import type { PageBuffer, PageSourceReport } from '@/lib/bindings'
import { clearMock, id, setSpace } from '@/lib/tauri-mock/__tests__/mock-store-helpers'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { blocks, makeBlock, opLog, properties } from '@/lib/tauri-mock/seed'

interface TreeBlock {
  id?: string
  depth: number
  content: string
  properties: Record<string, string>
}

interface Vectors {
  cases: Array<{ name: string; tree: TreeBlock[]; text: string; lineIds: Array<string | null> }>
  typed: Array<{ name: string; tree: TreeBlock[]; text: string }>
}

const VECTORS_PATH = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'conformance',
  'document-lines.vectors.json',
)
const vectors = JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as Vectors

const SPACE = id('SPACE')
const PAGE = id('PAGE')
const COLUMNS: ReadonlySet<string> = new Set([
  'todo_state',
  'priority',
  'due_date',
  'scheduled_date',
])

/**
 * `tree` stored under the page: each block under the last one a level up, its
 * task state, priority and dates in their columns, the rest as property rows.
 */
function store(tree: TreeBlock[]): void {
  const parents: string[] = [PAGE]
  const slots = new Map<string, number>()
  for (const block of tree) {
    const blockId = block.id as string
    const parent = parents[block.depth] as string
    const slot = (slots.get(parent) ?? 0) + 1
    slots.set(parent, slot)
    const row = makeBlock(blockId, 'content', block.content, parent, slot)
    row['page_id'] = PAGE
    const rows = new Map<string, Record<string, unknown>>()
    for (const [key, value] of Object.entries(block.properties)) {
      if (COLUMNS.has(key)) row[key] = value
      else
        rows.set(key, {
          key,
          value_text: value,
          value_num: null,
          value_date: null,
          value_ref: null,
          value_bool: null,
        })
    }
    blocks.set(blockId, row)
    properties.set(blockId, rows)
    parents[block.depth + 1] = blockId
  }
}

function buffer(): PageBuffer {
  return dispatch('get_page_buffer', { pageId: PAGE }) as PageBuffer
}

function save(text: string, lineIds: Array<string | null>, baseSource: string): PageSourceReport {
  return dispatch('apply_page_source', {
    pageId: PAGE,
    source: text,
    baseSource,
    merge: false,
    lineIds,
  }) as PageSourceReport
}

/** The properties a block holds as the vectors spell them: the columns and the rows, less the stamps. */
function propertiesOf(row: Record<string, unknown>): Record<string, string> {
  const held: Record<string, string> = {}
  for (const [key, prop] of properties.get(row['id'] as string) ?? []) {
    if (key !== 'created_at' && key !== 'completed_at') held[key] = prop['value_text'] as string
  }
  for (const key of COLUMNS) if (row[key] != null) held[key] = row[key] as string
  return held
}

/** The page's blocks, depth-first in sibling order, as the vectors spell them. */
function stored(parentId = PAGE, depth = 0): Array<Omit<TreeBlock, 'id'>> {
  const out: Array<Omit<TreeBlock, 'id'>> = []
  const children = [...blocks.values()]
    .filter((row) => row['parent_id'] === parentId && !row['deleted_at'])
    .toSorted((a, b) => (a['position'] as number) - (b['position'] as number))
  for (const row of children) {
    out.push({ depth, content: row['content'] as string, properties: propertiesOf(row) })
    out.push(...stored(row['id'] as string, depth + 1))
  }
  return out
}

const STATES: ReadonlySet<string> = new Set(['TODO', 'DOING', 'DONE', 'CANCELLED'])

describe('the mock in the Document dialect (#5691)', () => {
  beforeEach(() => {
    clearMock()
    blocks.set(PAGE, makeBlock(PAGE, 'page', 'Home', null, 1))
    setSpace(PAGE, SPACE)
  })

  it.each(vectors.cases.map((row) => [row.name, row] as const))(
    '%s: the page gives the text, and saved as it is, writes nothing',
    (_name, row) => {
      store(row.tree)

      const own = buffer()
      expect({ text: own.text, lineIds: own.line_ids }).toEqual({
        text: row.text,
        lineIds: row.lineIds,
      })
      const report = save(own.text, own.line_ids, own.source)
      expect([report.created, report.edited, report.moved, report.deleted]).toEqual([0, 0, 0, 0])
      expect(opLog).toHaveLength(0)
    },
  )

  it.each([...vectors.cases, ...vectors.typed].map((row) => [row.name, row] as const))(
    '%s: the text saved to an empty page creates its blocks',
    (_name, row) => {
      const empty = buffer()
      const lineIds = row.text.split('\n').map(() => null)
      const refused = row.tree.find(
        ({ properties: { todo_state } }) => todo_state !== undefined && !STATES.has(todo_state),
      )
      if (refused !== undefined) {
        // The tree holds a state no checkbox spells, which a save refuses as the backend does.
        expect(() => save(row.text, lineIds, empty.source)).toThrow(/todo_state:: WAITING/)
        expect(stored()).toEqual([])
        return
      }

      const report = save(row.text, lineIds, empty.source)

      expect(report.created).toBe(row.tree.length)
      expect(stored()).toEqual(row.tree.map(({ id: _, ...block }) => block))
    },
  )

  it('writes a task hiding a list style as a task, which ends a numbered run (D3)', () => {
    // Rust rows 3 and 12 before `as_document` drops the hidden styles.
    store([
      {
        id: id('A'),
        depth: 0,
        content: 'a',
        properties: { listStyle: 'ordered', todo_state: 'TODO' },
      },
      { id: id('B'), depth: 0, content: 'b', properties: { listStyle: 'ordered' } },
      {
        id: id('D'),
        depth: 0,
        content: 'd',
        properties: { listStyle: 'bullet', todo_state: 'WAITING' },
      },
    ])

    expect(buffer().text).toBe('- [ ] a\n1. b\n\nd\n  todo_state:: WAITING\n')
  })

  it('reads back a block that leaves a fence open under the mock ids, which are not ULIDs', () => {
    // `BLOCK` spells letters Crockford leaves out, as every id the mock mints or seeds does.
    store([
      { id: id('BLOCK01'), depth: 0, content: '```sh\ncode', properties: {} },
      { id: id('BLOCK02'), depth: 0, content: 'after', properties: {} },
    ])

    const own = buffer()

    expect(own.line_ids.filter((carried) => carried !== null)).toEqual([
      id('BLOCK01'),
      id('BLOCK02'),
    ])
    const report = save(own.text, own.line_ids, own.source)
    expect([report.created, report.edited, report.moved, report.deleted]).toEqual([0, 0, 0, 0])
  })

  it('writes a ticked checkbox and a new priority as ops its undo reverts', () => {
    store([
      {
        id: id('A'),
        depth: 0,
        content: 'task',
        properties: { listStyle: 'bullet', todo_state: 'TODO', priority: '2' },
      },
    ])
    const own = buffer()
    const edited = own.text.replace('[ ]', '[x]').replace('priority:: 2', 'priority:: 3')

    const { op_refs: ops } = save(edited, own.line_ids, own.source) as PageSourceReport & {
      op_refs: Array<{ device_id: string; seq: number }>
    }

    expect(blocks.get(id('A'))).toMatchObject({ todo_state: 'DONE', priority: '3' })
    expect(properties.get(id('A'))?.has('completed_at')).toBe(true)
    dispatch('revert_ops', { ops })
    expect(blocks.get(id('A'))).toMatchObject({ todo_state: 'TODO', priority: '2' })
    expect(properties.get(id('A'))?.has('completed_at')).toBe(false)
    expect(properties.get(id('A'))?.get('listStyle')?.['value_text']).toBe('bullet')
  })
})
