/**
 * #5691 G2b — the buffer's reading of `conformance/document-lines.vectors.json`,
 * which Rust authors from the Document dialect's hard cases
 * (`markdown_document_tests.rs`). Each case's text, read by the ids beside its
 * lines, is the case's tree, each block starting on the line that carries its
 * id; each typed text, no line carrying one, reads as its tree.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it } from 'vitest'

import { linesContent, sourceBufferExtensions } from '@/editor/source-buffer'
import { type BlockReading, blockAt, readBlocks } from '@/editor/source-buffer-blocks'
import { parseDocument } from '@/editor/source-buffer-document'

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
  'conformance',
  'document-lines.vectors.json',
)
const vectors = JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as Vectors

/** A block as the vectors spell it: its markers and property lines one map, the last winning. */
function asTree({ depth, text, listStyle, taskState, properties }: BlockReading): TreeBlock {
  return {
    depth,
    content: text,
    properties: {
      ...(listStyle === 'none' ? {} : { listStyle }),
      ...(taskState === null ? {} : { todo_state: taskState }),
      ...Object.fromEntries(properties),
    },
  }
}

const withoutIds = (tree: TreeBlock[]): TreeBlock[] => tree.map(({ id: _, ...block }) => block)

describe('the Document dialect vectors (#5691)', () => {
  it.each(vectors.cases.map((row) => [row.name, row] as const))(
    '%s: the text read by its line ids is the tree',
    (_name, row) => {
      const texts = row.text.split('\n')
      expect(texts).toHaveLength(row.lineIds.length)

      expect(readBlocks(texts, row.lineIds, 'document').map(asTree)).toEqual(withoutIds(row.tree))
      const read = parseDocument(row.text, row.lineIds)
      expect(read.blocks.map((block) => row.lineIds[block.line - 1])).toEqual(
        row.tree.map((block) => block.id),
      )
      expect(read.warnings).toEqual([])
    },
  )

  it.each(vectors.typed.map((row) => [row.name, row] as const))('%s, typed', (_name, row) => {
    const texts = row.text.split('\n')
    const ids = texts.map(() => null)
    expect(readBlocks(texts, ids, 'document').map(asTree)).toEqual(row.tree)
  })

  it('reads a Source buffer as before unless asked for the Document dialect', () => {
    const texts = ['- - a', '- b']
    expect(readBlocks(texts, [null, null]).map((block) => block.listStyle)).toEqual([
      'bullet',
      'none',
    ])
    expect(readBlocks(texts, [null, null], 'document').map((block) => block.text)).toEqual([
      '- a',
      'b',
    ])
  })
})

describe('the block at a line of a Document buffer', () => {
  let editor: Editor | null = null

  afterEach(() => {
    editor?.destroy()
    editor = null
  })

  const A = '01J0000000000000000000000A'
  const B = '01J0000000000000000000000B'
  const C = '01J0000000000000000000000C'

  it('is the block starting there or above, as the grammar reads the buffer', () => {
    const rows: Array<[string, string | null]> = [
      ['para', A],
      ['## typed under it', null],
      ['', null],
      ['  child', B],
      ['  more', null],
      ['', null],
      ['next', C],
    ]
    editor = new Editor({
      element: document.createElement('div'),
      extensions: sourceBufferExtensions([]),
      content: linesContent({
        text: rows.map(([text]) => text).join('\n'),
        lineIds: rows.map(([, id]) => id),
      }),
    })
    const { doc } = editor.state

    expect(blockAt(doc, 0, 'document')).toEqual({ line: 0, end: 1, subtreeEnd: 1, id: A })
    expect(blockAt(doc, 1, 'document')).toEqual({ line: 1, end: 2, subtreeEnd: 5, id: null })
    expect(blockAt(doc, 2, 'document')?.line).toBe(1)
    expect(blockAt(doc, 4, 'document')).toEqual({ line: 3, end: 5, subtreeEnd: 5, id: B })
    expect(blockAt(doc, 6, 'document')).toEqual({ line: 6, end: 7, subtreeEnd: 7, id: C })
    // Source, the default, reads no block starting on an unmarked line without an id.
    expect(blockAt(doc, 1)?.line).toBe(0)
  })
})
