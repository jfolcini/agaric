/**
 * #5974 — a numbered block's marker is drawn by the block's node view, outside
 * its editable text, so the syntax revealed at the start of its text can never
 * come before it: `1. [label` stays that on ArrowLeft, never `[1. label`
 * (block mode's widget order, `list-marker-decoration.ts`, has no part here).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { caret, press, type Row } from '@/editor/page-mode/__tests__/page-mode-fixtures'
import {
  blockEl,
  getIn,
  mountNodeViews,
} from '@/editor/page-mode/__tests__/page-node-view-fixtures'
import { PageLists } from '@/editor/page-mode/page-lists'
import { PREFERENCES, writePreference } from '@/lib/preferences'

const A = '01J00000000000000000000001'

let teardown: (() => void) | null = null

beforeEach(() => {
  localStorage.clear()
  writePreference(PREFERENCES.revealMarkdownSyntax, true)
  vi.stubGlobal('IntersectionObserver', undefined)
})

afterEach(() => {
  teardown?.()
  teardown = null
  vi.unstubAllGlobals()
})

describe('MarkdownReveal beside a page-mode list marker', () => {
  it('draws a link’s brackets after the marker, whichever side of the caret', () => {
    const rows: Row[] = [[A, 0, '[label](https://e.com) x']]
    const lists = new PageLists(
      {
        [A]: [
          {
            key: 'listStyle',
            value_text: 'ordered',
            value_num: null,
            value_date: null,
            value_ref: null,
            value_bool: null,
          },
        ],
      },
      [{ id: A, depth: 0 }],
    )
    const mounted = mountNodeViews(rows, undefined, lists)
    teardown = () => {
      mounted.unmount()
      mounted.editor.destroy()
    }
    mounted.editor.view.focus()
    caret(mounted.editor, 0, 0)
    const block = blockEl(mounted.container, A)
    const listMarker = getIn(block, '[data-testid="list-marker"]')
    const drawn = () => [...block.querySelectorAll('.md-reveal-marker')]
    expect(drawn().map((el) => el.textContent)).toEqual(['[', '](https://e.com)'])
    const leads = () =>
      drawn().every(
        (el) => listMarker.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING,
      )
    expect(leads()).toBe(true)

    // ArrowLeft over `[`: the caret is left of it, the list marker still first.
    press(mounted.editor, 'ArrowLeft')
    expect(drawn().map((el) => el.textContent)).toEqual(['[', '](https://e.com)'])
    expect(leads()).toBe(true)
  })
})
