import { afterEach, describe, expect, it, vi } from 'vitest'

import { logger } from '@/lib/logger'
import { isLogseqGraph, logseqGraph, logseqTitleProperty } from '@/lib/logseq-import'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('isLogseqGraph', () => {
  it('reads a pick as a graph by its config, or by `pages/` and `journals/` at its root', () => {
    expect(isLogseqGraph(['logseq/config.edn', 'notes.md'])).toBe(true)
    expect(isLogseqGraph(['pages/a.md', 'journals/2026_10_21.md'])).toBe(true)
    expect(isLogseqGraph(['pages/a.md', 'b.md'])).toBe(false)
    expect(isLogseqGraph(['journals/2026_10_21.md'])).toBe(false)
    expect(isLogseqGraph(['sub/pages/a.md', 'sub/journals/b.md', 'sub/logseq/config.edn'])).toBe(
      false,
    )
  })
})

describe('logseqGraph titles', () => {
  const titles = (paths: string[], edn: string | null = null) => logseqGraph(edn, paths).titles

  it('titles a page by its file name alone: `___` a namespace, any `%XX` decoded', () => {
    expect(
      titles([
        'pages/a___b___c.md',
        'pages/What%3F.md',
        'pages/x%2Fy.md',
        'pages/Caf%C3%A9.md',
        'pages/100% done.md',
        'pages/sub/deep.md',
        'pages/v1.2.md',
      ]),
    ).toEqual(['a/b/c', 'What?', 'x/y', 'Café', '100% done', 'deep', 'v1.2'])
  })

  it('titles a journal by the day its file name names, else as a page', () => {
    expect(titles(['journals/2026_10_21.md', 'journals/2026_1_2.md', 'journals/notes.md'])).toEqual(
      ['2026-10-21', '2026_1_2', 'notes'],
    )
  })

  it('leaves a file outside `pages/` and `journals/` untitled', () => {
    expect(titles(['README.md', 'whiteboards/x.md'])).toEqual([null, null])
  })

  it('reads the journal file-name format from the config, never a commented one', () => {
    const custom = '{:journal/file-name-format "yyyy-MM-dd"\n :file/name-format :triple-lowbar}'
    expect(titles(['journals/2026-10-21.md', 'journals/2026_10_21.md'], custom)).toEqual([
      '2026-10-21',
      '2026_10_21',
    ])
    const commented = ';; :journal/file-name-format "yyyy-MM-dd"\n:file/name-format :triple-lowbar'
    expect(titles(['journals/2026-10-21.md', 'journals/2026_10_21.md'], commented)).toEqual([
      '2026-10-21',
      '2026-10-21',
    ])
  })

  it('reads a journal file name by its day tokens and literals, else as a page', () => {
    const quoted = `{:journal/file-name-format "'day' yyyy+M+d"\n :file/name-format :triple-lowbar}`
    expect(titles(['journals/day 2026+10+2.md', 'journals/day 2026+2+30.md'], quoted)).toEqual([
      '2026-10-02',
      'day 2026+2+30',
    ])
    const unsupported =
      '{:journal/file-name-format "yyyy_MMM_dd"\n :file/name-format :triple-lowbar}'
    expect(titles(['journals/2026_Oct_21.md'], unsupported)).toEqual(['2026_Oct_21'])
  })

  it('reads a `.` as the namespace in a graph of the legacy file-name format', () => {
    expect(titles(['pages/a.b.md', 'pages/a___b.md'], '{:meta/version 1}')).toEqual([
      'a/b',
      'a___b',
    ])
    expect(titles(['pages/a.b.md'], '{:file/name-format :triple-lowbar}')).toEqual(['a.b'])
  })
})

describe('logseqGraph journal links', () => {
  const paths = ['journals/2026_10_21.md', 'pages/a.md']

  it("links a journal's default title to its day, in any case, and leaves other dates", () => {
    const { rewrite } = logseqGraph(null, paths)
    expect(rewrite('- [[Oct 21st, 2026]], [[ oct 21ST, 2026 ]] and [[Oct 22nd, 2026]]')).toBe(
      '- [[2026-10-21]], [[2026-10-21]] and [[Oct 22nd, 2026]]',
    )
  })

  it('formats each journal with the configured title format', () => {
    const edn = '{:journal/page-title-format "yyyy-MM-dd EEE"}'
    expect(logseqGraph(edn, paths).rewrite('[[2026-10-21 Wed]] [[Oct 21st, 2026]]')).toBe(
      '[[2026-10-21]] [[Oct 21st, 2026]]',
    )
  })

  it("reads an older graph's `:date-formatter` when it has no title format", () => {
    const edn = '{:date-formatter "EEEE, dd.MM.yyyy"}'
    expect(logseqGraph(edn, paths).rewrite('[[Wednesday, 21.10.2026]]')).toBe('[[2026-10-21]]')
  })

  it('leaves journal links as written, with one warning, for a format it cannot write', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const edn = '{:journal/page-title-format "MMM do, YYYY"}'
    const { rewrite } = logseqGraph(edn, [...paths, 'journals/2026_10_22.md'])

    expect(rewrite('[[Oct 21st, 2026]]')).toBe('[[Oct 21st, 2026]]')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('leaves the links inside a code fence, a bullet one included', () => {
    const { rewrite } = logseqGraph(null, paths)
    const text = [
      '```',
      '[[Oct 21st, 2026]]',
      '```',
      '- ```md',
      '  [[Oct 21st, 2026]]',
      '  ```',
      '- [[Oct 21st, 2026]]',
    ].join('\n')

    expect(rewrite(text)).toBe(text.replace(/- \[\[Oct 21st, 2026\]\]$/, '- [[2026-10-21]]'))
  })
})

describe('logseqTitleProperty', () => {
  it("reads `title::` among the page's leading property lines", () => {
    expect(logseqTitleProperty('title:: My Page\nalias:: x\n\n- body')).toBe('My Page')
    expect(logseqTitleProperty('alias:: x\r\nTitle:: a/b\r\n- body')).toBe('a/b')
  })

  it('reads no title from a block, after prose, or when empty', () => {
    expect(logseqTitleProperty('- title:: x')).toBeNull()
    expect(logseqTitleProperty('intro\ntitle:: x')).toBeNull()
    expect(logseqTitleProperty('title::   \n- body')).toBeNull()
  })
})
