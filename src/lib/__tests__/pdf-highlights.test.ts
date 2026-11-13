/**
 * A PDF highlight as a block (#6629): which of pdf.js's serialized editors a
 * save turns into blocks, the block it sends, how a save points the older
 * highlight blocks at the new copy, and how a block's chip reads its place.
 */

import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeBlockRow } from '@/__tests__/fixtures'
import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import {
  highlightBlockSpecs,
  newHighlights,
  pdfSourceOf,
  repointHighlightBlocks,
} from '@/lib/pdf-highlights'

const mockedInvoke = vi.mocked(invoke)

/** An editor as pdf.js holds it: the passage is the highlight's accessible name. */
function editorSaying(passage: string): { div: HTMLElement } {
  const div = document.createElement('div')
  div.setAttribute('aria-label', passage)
  return { div }
}

/** One box, top edge first, as pdf.js serializes a highlight's quad points. */
const QUADS = Float32Array.from([40, 114.25, 140.004, 114.25, 40, 90.5, 140.004, 90.5])

/** The storage pdf.js serializes on save: each entry its serialized data and its editor. */
function storageOf(entries: Array<[data: Record<string, unknown>, editor: unknown]>) {
  const map = new Map(entries.map(([data], i) => [`editor_${i}`, data]))
  const editors = new Map(entries.map(([, editor], i) => [`editor_${i}`, editor]))
  return {
    serializable: { map, hash: '', transfer: [] },
    getRawValue: (key: string) => editors.get(key) as object,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('newHighlights', () => {
  it('takes each new highlight with its passage, page and boxes, in the order made', () => {
    const storage = storageOf([
      [
        { annotationType: 9, id: null, pageIndex: 1, quadPoints: QUADS },
        editorSaying(' Page\n  two '),
      ],
      [
        { annotationType: 9, id: null, pageIndex: 0, quadPoints: [...QUADS, ...QUADS] },
        editorSaying('Page one'),
      ],
    ])

    expect(newHighlights(storage)).toEqual([
      { passage: 'Page two', page: 2, boxes: [[40, 90.5, 140, 114.25]] },
      {
        passage: 'Page one',
        page: 1,
        boxes: [
          [40, 90.5, 140, 114.25],
          [40, 90.5, 140, 114.25],
        ],
      },
    ])
  })

  it('leaves out what the file holds, a free-hand highlight, a comment and a highlight with no text', () => {
    const storage = storageOf([
      [
        { annotationType: 9, id: '12R', pageIndex: 0, quadPoints: QUADS },
        editorSaying('already in the file'),
      ],
      [{ annotationType: 9, id: null, pageIndex: 0, quadPoints: null }, editorSaying('')],
      [{ annotationType: 3, id: null, pageIndex: 0, quadPoints: null }, {}],
      [{ annotationType: 9, id: null, pageIndex: 0, quadPoints: QUADS }, { div: null }],
    ])

    expect(newHighlights(storage)).toEqual([])
  })

  it('finds none in an empty storage, which pdf.js serializes without a map', () => {
    const storage = {
      serializable: { map: null, hash: '', transfer: undefined },
      getRawValue: () => ({}),
    } as const

    expect(newHighlights(storage)).toEqual([])
  })
})

describe('highlightBlockSpecs', () => {
  it('appends a block per highlight under the owner, its place in three text properties', () => {
    const specs = highlightBlockSpecs('OWNER', 'ATT_NEW', [
      { passage: 'a *starred* word', page: 12, boxes: [[1, 2, 3, 4]] },
    ])

    expect(specs).toEqual([
      {
        blockType: 'content',
        content: 'a \\*starred\\* word',
        parentId: 'OWNER',
        position: null,
        properties: {
          pdf_attachment: 'ATT_NEW',
          pdf_page: '12',
          pdf_boxes: '[[1,2,3,4]]',
        },
      },
    ])
  })
})

describe('repointHighlightBlocks', () => {
  const page = (ids: string[], next: string | null) => ({
    items: ids.map((id) => makeBlockRow({ id })),
    next_cursor: next,
    has_more: next !== null,
    total_count: null,
  })

  it('points every highlight block of the space at the copy, across pages', async () => {
    const queries: Array<Record<string, unknown>> = []
    const writes: Array<Record<string, unknown>> = []
    mockedInvoke.mockImplementation(
      mockInvokeCommands({
        query_by_property: (args) => {
          queries.push(args)
          const cursor = (args['request'] as { cursor: string | null }).cursor
          return cursor === null ? page(['HL_1'], 'C1') : page(['HL_2'], null)
        },
        set_property: (args) => {
          writes.push(args)
          return { ...makeBlockRow({ id: args['blockId'] as string }), op_refs: [] }
        },
      }),
    )

    await repointHighlightBlocks('SPACE_1', 'ATT_OLD', 'ATT_NEW')

    expect(
      queries.map((args) => {
        const request = args['request'] as Record<string, unknown>
        return [request['key'], request['valueText'], request['cursor'], args['scope']]
      }),
    ).toEqual([
      ['pdf_attachment', 'ATT_OLD', null, { kind: 'active', space_id: 'SPACE_1' }],
      ['pdf_attachment', 'ATT_OLD', 'C1', { kind: 'active', space_id: 'SPACE_1' }],
    ])
    expect(writes).toEqual([
      {
        blockId: 'HL_1',
        key: 'pdf_attachment',
        value: {
          value_text: 'ATT_NEW',
          value_num: null,
          value_date: null,
          value_ref: null,
          value_bool: null,
        },
      },
      {
        blockId: 'HL_2',
        key: 'pdf_attachment',
        value: {
          value_text: 'ATT_NEW',
          value_num: null,
          value_date: null,
          value_ref: null,
          value_bool: null,
        },
      },
    ])
  })

  it('throws on a refused write, stopping there', async () => {
    const written: string[] = []
    mockedInvoke.mockImplementation(
      mockInvokeCommands({
        query_by_property: () => page(['HL_1', 'HL_2'], null),
        set_property: (args) => {
          written.push(args['blockId'] as string)
          return Promise.reject(new Error('database is locked'))
        },
      }),
    )

    await expect(repointHighlightBlocks('SPACE_1', 'ATT_OLD', 'ATT_NEW')).rejects.toThrow(
      'database is locked',
    )
    expect(written).toEqual(['HL_1'])
  })

  it('has nothing to point with no active space', async () => {
    await repointHighlightBlocks(null, 'ATT_OLD', 'ATT_NEW')

    expect(mockedInvoke).not.toHaveBeenCalled()
  })
})

describe('pdfSourceOf', () => {
  it("reads a highlight block's attachment and page", () => {
    expect(
      pdfSourceOf([
        { key: 'topic', value: 'x' },
        { key: 'pdf_page', value: '12' },
        { key: 'pdf_attachment', value: 'ATT' },
      ]),
    ).toEqual({ attachmentId: 'ATT', page: 12 })
  })

  it('opens on the first page when the page is missing or not a page number', () => {
    expect(pdfSourceOf([{ key: 'pdf_attachment', value: 'ATT' }])).toEqual({
      attachmentId: 'ATT',
      page: 1,
    })
    expect(
      pdfSourceOf([
        { key: 'pdf_attachment', value: 'ATT' },
        { key: 'pdf_page', value: '2.5' },
      ]),
    ).toEqual({ attachmentId: 'ATT', page: 1 })
  })

  it('is null on a block that is no highlight', () => {
    expect(pdfSourceOf([{ key: 'pdf_page', value: '3' }])).toBeNull()
    expect(pdfSourceOf(undefined)).toBeNull()
  })
})
