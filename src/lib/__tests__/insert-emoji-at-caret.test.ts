/**
 * #286 — `insert-emoji-at-caret` unit tests.
 *
 * Covers the pure string splice used by the page-title and tag-name surfaces,
 * plus the `<input>` helper that reads/writes a live element's selection.
 */

import { describe, expect, it } from 'vitest'

import { insertEmojiIntoInput, spliceEmojiIntoText } from '../insert-emoji-at-caret'

const ROCKET = '\u{1F680}'

describe('spliceEmojiIntoText', () => {
  it('inserts at a collapsed caret in the middle', () => {
    expect(spliceEmojiIntoText('abcd', ROCKET, 2, 2)).toEqual({
      value: `ab${ROCKET}cd`,
      caret: 2 + ROCKET.length,
    })
  })

  it('replaces a selected range', () => {
    expect(spliceEmojiIntoText('abcd', ROCKET, 1, 3)).toEqual({
      value: `a${ROCKET}d`,
      caret: 1 + ROCKET.length,
    })
  })

  it('appends at end when no offsets given', () => {
    expect(spliceEmojiIntoText('hi', ROCKET)).toEqual({
      value: `hi${ROCKET}`,
      caret: 2 + ROCKET.length,
    })
  })

  it('clamps out-of-range offsets', () => {
    expect(spliceEmojiIntoText('ab', ROCKET, -5, 99)).toEqual({
      value: ROCKET,
      caret: ROCKET.length,
    })
  })

  it('normalises a reversed selection (start > end)', () => {
    const r = spliceEmojiIntoText('abcd', ROCKET, 3, 1)
    // hi clamps to >= lo, so [3,3): insert after index 3.
    expect(r.value).toBe(`abc${ROCKET}d`)
    expect(r.caret).toBe(3 + ROCKET.length)
  })
})

describe('insertEmojiIntoInput', () => {
  it('splices at the input caret and moves the caret after the emoji', () => {
    const el = document.createElement('input')
    el.value = 'hello'
    document.body.append(el)
    el.setSelectionRange(2, 2)

    const next = insertEmojiIntoInput(el, ROCKET)

    expect(next).toBe(`he${ROCKET}llo`)
    expect(el.value).toBe(`he${ROCKET}llo`)
    expect(el.selectionStart).toBe(2 + ROCKET.length)
    expect(el.selectionEnd).toBe(2 + ROCKET.length)
    el.remove()
  })

  it('replaces the selected range', () => {
    const el = document.createElement('input')
    el.value = 'hello'
    document.body.append(el)
    el.setSelectionRange(0, 5)

    expect(insertEmojiIntoInput(el, ROCKET)).toBe(ROCKET)
    expect(el.value).toBe(ROCKET)
    el.remove()
  })
})
