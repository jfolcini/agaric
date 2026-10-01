import { describe, expect, it } from 'vitest'

import { type BufferLines, diffBuffers } from '@/lib/page-source-diff'

const id = (suffix: string): string => `01J${'0'.repeat(22)}${suffix}`
const A = id('A')
const B = id('B')
const C = id('C')
const D = id('D')

/** A buffer of `lines`, each `[text, id]`, ending in a line break as the render does. */
const buffer = (...lines: Array<[string, string | null]>): BufferLines => ({
  text: `${lines.map(([text]) => text).join('\n')}\n`,
  line_ids: [...lines.map(([, carried]) => carried), null],
})

describe('diffBuffers', () => {
  it('finds nothing between identical buffers', () => {
    const lines = buffer(['- one', A], ['  - child', B], ['- two', C])

    expect(diffBuffers(lines, lines)).toEqual([])
  })

  // #5160 S8 — the page's front matter is a change of its own, not of the
  // first block it heads.
  it('reports a change to the front matter apart from the blocks under it', () => {
    const head = (stage: string): Array<[string, null]> => [
      ['---', null],
      [`stage: ${stage}`, null],
      ['---', null],
      ['', null],
    ]
    const base = buffer(...head('open'), ['- one', A])
    const current = buffer(...head('done'), ['- one', A])

    expect(diffBuffers(base, current)).toEqual([{ kind: 'changed', text: '---\nstage: done\n---' }])
    expect(diffBuffers(buffer(['- one', A]), current)).toEqual([
      { kind: 'added', text: '---\nstage: done\n---' },
    ])
  })

  it('does not count a block that only moved', () => {
    const base = buffer(['- one', A], ['- two', B], ['- three', C])
    const current = buffer(['- three', C], ['- one', A], ['- two', B])

    expect(diffBuffers(base, current)).toEqual([])
  })

  it('reports an added, a removed and a changed block, removed ones where they sat in base', () => {
    const base = buffer(['- one', A], ['- two', B], ['- three', C])
    const current = buffer(['- one, edited', A], ['- three', C], ['- four', D])

    expect(diffBuffers(base, current)).toEqual([
      { kind: 'changed', text: '- one, edited' },
      { kind: 'removed', text: '- two' },
      { kind: 'added', text: '- four' },
    ])
  })

  it('keys a block by the id its first line carries and counts the lines up to the next id', () => {
    const base = buffer(['- first line', A], ['  second line', null], ['  priority:: 1', null])
    const current = buffer(['- first line', A], ['  second line', null], ['  priority:: 2', null])

    expect(diffBuffers(base, current)).toEqual([
      { kind: 'changed', text: '- first line\n  second line\n  priority:: 2' },
    ])
  })

  it('keeps a line that looks like a bullet but carries no id in the block above it', () => {
    const fence = (...code: string[]): Array<[string, string | null]> => [
      ['- ```', A],
      ...code.map((line): [string, null] => [`  ${line}`, null]),
      ['  ```', null],
    ]
    const base = buffer(['- one', B], ...fence('- item'))
    const current = buffer(['- one', B], ...fence('- item', '- item 2'))

    expect(diffBuffers(base, current)).toEqual([
      { kind: 'changed', text: '- ```\n  - item\n  - item 2\n  ```' },
    ])
  })
})
