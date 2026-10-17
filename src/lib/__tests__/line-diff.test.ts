import { describe, expect, it } from 'vitest'

import { diffLines, diffWords } from '@/lib/line-diff'

describe('diffLines', () => {
  it('finds no hunk between equal texts', () => {
    const text = '- one\n- two\n'

    expect(diffLines(text, text).hunks).toEqual([])
  })

  it('an added line is one hunk adding it where it went', () => {
    expect(diffLines('- one\n- three\n', '- one\n- two\n- three\n').hunks).toEqual([
      { beforeStart: 1, afterStart: 1, removed: [], added: ['- two'] },
    ])
  })

  it('a removed line is one hunk removing it from where it was', () => {
    expect(diffLines('- one\n- two\n- three\n', '- one\n- three\n').hunks).toEqual([
      { beforeStart: 1, afterStart: 1, removed: ['- two'], added: [] },
    ])
  })

  it('a changed line is one hunk removing the old and adding the new, apart from another change', () => {
    const { hunks } = diffLines('- a\n- b\n- c\n- d\n', '- a\n- B\n- c\n- D\n')

    expect(hunks).toEqual([
      { beforeStart: 1, afterStart: 1, removed: ['- b'], added: ['- B'] },
      { beforeStart: 3, afterStart: 3, removed: ['- d'], added: ['- D'] },
    ])
  })

  it('reads CRLF and CR line breaks as LF, so a text differing only in them has no hunk', () => {
    expect(diffLines('- one\r\n- two\r\n', '- one\n- two\n').hunks).toEqual([])
    expect(diffLines('- one\r- two', '- one\n- two').hunks).toEqual([])
  })

  it('a dropped last line break is a removed empty line', () => {
    expect(diffLines('- one\n', '- one').hunks).toEqual([
      { beforeStart: 1, afterStart: 1, removed: [''], added: [] },
    ])
  })

  it('an empty page has one empty line: writing into it changes that line', () => {
    expect(diffLines('', '').hunks).toEqual([])
    expect(diffLines('', '- first').hunks).toEqual([
      { beforeStart: 0, afterStart: 0, removed: [''], added: ['- first'] },
    ])
    expect(diffLines('- last', '').hunks).toEqual([
      { beforeStart: 0, afterStart: 0, removed: ['- last'], added: [''] },
    ])
  })

  it('finds the one line changed in a long page', () => {
    const page = Array.from({ length: 20_000 }, (_, i) => `- line ${i}`)
    const edited = page.with(12_345, '- line edited')

    expect(diffLines(page.join('\n'), edited.join('\n')).hunks).toEqual([
      {
        beforeStart: 12_345,
        afterStart: 12_345,
        removed: ['- line 12345'],
        added: ['- line edited'],
      },
    ])
  })

  it('a page changed past the edit cap is one hunk of every line, unchanged lines among them', () => {
    const before = Array.from({ length: 3000 }, (_, i) => `- line ${i}`)
    const after = before.map((line, i) => (i % 2 === 0 ? `${line} edited` : line))

    expect(diffLines(before.join('\n'), after.join('\n')).hunks).toEqual([
      { beforeStart: 0, afterStart: 0, removed: before, added: after },
    ])
  })
})

describe('diffWords', () => {
  it('marks only the changed word in each line, keeping every character', () => {
    const [before, after] = diffWords('- the quick fox', '- the slow fox')

    expect(before).toEqual([
      { text: '- the ', changed: false },
      { text: 'quick', changed: true },
      { text: ' fox', changed: false },
    ])
    expect(after).toEqual([
      { text: '- the ', changed: false },
      { text: 'slow', changed: true },
      { text: ' fox', changed: false },
    ])
  })

  it('marks an added word without the blank before it', () => {
    expect(diffWords('- second', '- second edited')[1]).toEqual([
      { text: '- second', changed: false },
      { text: ' ', changed: false },
      { text: 'edited', changed: true },
    ])
  })

  it('a line changed past the word cap is marked whole', () => {
    const removed = Array.from({ length: 300 }, (_, i) => `a${i}`).join(' ')
    const added = Array.from({ length: 300 }, (_, i) => `b${i}`).join(' ')

    expect(diffWords(removed, added)).toEqual([
      [{ text: removed, changed: true }],
      [{ text: added, changed: true }],
    ])
  })
})
