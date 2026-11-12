/**
 * In-page replace in page mode (#6608): DOM matches in the page-mode editor
 * replaced in its document, as one undo step.
 */

import { undo } from '@tiptap/pm/history'
import { afterEach, describe, expect, it } from 'vitest'

import {
  blockId,
  openPage,
  rowsOf,
  type Row,
} from '@/editor/page-mode/__tests__/page-mode-fixtures'
import { collectTextNodes, compileQuery, walkSync } from '@/lib/in-page-find/matcher'
import { replaceInEditor } from '@/lib/in-page-find/replace-in-editor'

const TAG = '01TAG000000000000000000TAG'

let editor: ReturnType<typeof openPage> | null = null

afterEach(() => {
  editor?.destroy()
  editor = null
})

function matchesOf(query: string) {
  const compiled = compileQuery(query, { caseSensitive: false, wholeWord: false, isRegex: false })
  if (compiled.kind !== 'literal') throw new Error(compiled.kind)
  return walkSync(collectTextNodes(editor?.view.dom as HTMLElement), compiled).matches
}

describe('replaceInEditor', () => {
  const rows: Row[] = [
    [blockId(1), 0, 'one **foo** two'],
    [blockId(2), 0, `foo and #[${TAG}]`],
  ]

  it('replaces every match in the document and one undo takes all of them back', () => {
    editor = openPage(rows)
    const items = matchesOf('foo').map((match) => ({ match, text: 'bar' }))

    expect(replaceInEditor(editor, items)).toEqual({ replaced: 2, skipped: 0 })
    expect(rowsOf(editor.state.doc).map(([, , md]) => md)).toEqual([
      'one **bar** two',
      `bar and #[${TAG}]`,
    ])

    undo(editor.state, editor.view.dispatch)
    expect(rowsOf(editor.state.doc).map(([, , md]) => md)).toEqual([
      'one **foo** two',
      `foo and #[${TAG}]`,
    ])
  })

  it('skips a match in a chip, leaving the tag as it is', () => {
    editor = openPage(rows)
    const items = matchesOf('TAG').map((match) => ({ match, text: 'x' }))

    expect(items).toHaveLength(2)
    expect(replaceInEditor(editor, items)).toEqual({ replaced: 0, skipped: items.length })
    expect(rowsOf(editor.state.doc)[1]?.[2]).toBe(`foo and #[${TAG}]`)
  })

  it('skips a match outside the editor, as in the page title', () => {
    editor = openPage(rows)
    const title = document.createTextNode('foo title')
    expect(
      replaceInEditor(editor, [{ match: { node: title, start: 0, end: 3 }, text: 'x' }]),
    ).toEqual({ replaced: 0, skipped: 1 })
  })
})
