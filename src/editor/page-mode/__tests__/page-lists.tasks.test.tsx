/**
 * Page mode's lists with tasks (#5691 D3): a task is a list kind, so a block
 * holding a task state shows its checkbox and no marker, whatever style it
 * stores, is numbered as a plain block, and is keyed as one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  blockId,
  caret,
  idMinter,
  openPage,
  press,
  rowsOf,
} from '@/editor/page-mode/__tests__/page-mode-fixtures'
import { listSource } from '@/editor/page-mode/__tests__/page-node-view-fixtures'
import { PageLists } from '@/editor/page-mode/page-lists'
import type { PropertyRow } from '@/lib/bindings'

const A = blockId(1)
const B = blockId(2)
const C = blockId(3)

const style = (value: string): PropertyRow[] => [
  {
    key: 'listStyle',
    value_text: value,
    value_num: null,
    value_date: null,
    value_ref: null,
    value_bool: null,
  },
]
const flat = (...ids: string[]) => ids.map((id) => ({ id, depth: 0 }))

let teardown: (() => void) | null = null

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', undefined)
})

afterEach(() => {
  teardown?.()
  teardown = null
  vi.unstubAllGlobals()
})

describe('PageLists with tasks', () => {
  it('a task shows no marker and ends a numbered run; it keeps the style it stores', () => {
    const tasks = new Set([B])
    const lists = new PageLists(
      { [A]: style('ordered'), [B]: style('ordered'), [C]: style('ordered') },
      flat(A, B, C),
      (id) => tasks.has(id),
    )

    expect([A, B, C].map((id) => lists.markerOf(id))).toEqual(['1.', '', '1.'])
    expect([A, B, C].map((id) => lists.shownStyleOf(id))).toEqual(['ordered', 'none', 'ordered'])
    expect(lists.styleOf(B)).toBe('ordered')
  })

  it('a task state set or cleared redraws the markers, and tells the blocks whose marker changed', () => {
    const tasks = new Set<string>()
    const lists = new PageLists(
      { [A]: style('ordered'), [B]: style('ordered') },
      flat(A, B),
      (id) => tasks.has(id),
    )
    const onA = vi.fn()
    const onB = vi.fn()
    lists.subscribe(A, onA)
    lists.subscribe(B, onB)

    tasks.add(A)
    lists.tasksChanged()
    expect([lists.markerOf(A), lists.markerOf(B)]).toEqual(['', '1.'])
    expect([onA.mock.calls.length, onB.mock.calls.length]).toEqual([1, 1])

    tasks.delete(A)
    lists.tasksChanged()
    expect([lists.markerOf(A), lists.markerOf(B)]).toEqual(['1.', '2.'])
    expect([onA.mock.calls.length, onB.mock.calls.length]).toEqual([2, 2])
  })

  it('Enter and Backspace on a task are not the list’s, whatever style it stores', () => {
    const lists = new PageLists({ [A]: style('bullet') }, flat(A), () => true)
    const source = listSource(lists)
    const editor = openPage([[A, 0, 'one']], idMinter(), undefined, source)
    teardown = () => editor.destroy()

    caret(editor, 0, 0)
    expect(press(editor, 'Backspace')).toBe(false)
    caret(editor, 0, 3)
    press(editor, 'Enter')

    expect(source.setStyle).not.toHaveBeenCalled()
    expect(rowsOf(editor.state.doc).map(([id]) => lists.styleOf(id))).toEqual(['bullet', 'none'])
  })
})
