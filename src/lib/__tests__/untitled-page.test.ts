/**
 * Tests for the blank-title "New page" name (#4723).
 *
 * `create_page_in_space` resolves an existing title to that page, so the
 * suffix search is what stops a second blank create from reopening the
 * Untitled page the user left un-renamed.
 */

import { describe, expect, it } from 'vitest'

import { untitledTitle } from '@/lib/untitled-page'

describe('untitledTitle', () => {
  it('returns "Untitled" when nothing holds it', () => {
    expect(untitledTitle([])).toBe('Untitled')
    expect(untitledTitle(['Groceries', 'Meeting notes'])).toBe('Untitled')
  })

  it('suffixes past the titles already taken', () => {
    expect(untitledTitle(['Untitled'])).toBe('Untitled 2')
    expect(untitledTitle(['Untitled', 'Untitled 2'])).toBe('Untitled 3')
  })

  it('takes the first free name, not the next number', () => {
    expect(untitledTitle(['Untitled 2'])).toBe('Untitled')
  })

  it('ignores null titles', () => {
    expect(untitledTitle([null, null])).toBe('Untitled')
    expect(untitledTitle([null, 'Untitled'])).toBe('Untitled 2')
  })
})
