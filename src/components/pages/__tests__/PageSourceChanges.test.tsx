/**
 * PageSourceChanges — the Changes view of Edit as Markdown: a hunk's removed
 * lines then its added ones, the changed words marked, unchanged runs folded.
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { PageSourceChanges } from '@/components/pages/PageSourceChanges'
import { t } from '@/lib/i18n'
import { diffLines } from '@/lib/line-diff'

const BEFORE = '- one\n- the quick fox\n- three\n'
const AFTER = '- one\n- the slow fox\n- three\n- four\n'

/** Each row's gutter sign, its screen-reader label and text, and its marked words. */
function rows(container: HTMLElement): Array<[string, string, string[]]> {
  return [...container.querySelectorAll('[data-testid="page-source-changes"] > div')].map((row) => [
    row.firstElementChild?.textContent ?? '',
    (row.lastElementChild ?? row).textContent ?? '',
    [...row.querySelectorAll('mark')].map((mark) => mark.textContent ?? ''),
  ])
}

describe('PageSourceChanges', () => {
  it('shows a changed line as removed then added with the changed word marked, an added line whole', () => {
    const { container } = render(<PageSourceChanges diff={diffLines(BEFORE, AFTER)} />)

    expect(rows(container)).toEqual([
      [' ', '- one', []],
      ['−', `${t('pageSource.changeRemoved')} - the quick fox`, ['quick']],
      ['+', `${t('pageSource.changeAdded')} - the slow fox`, ['slow']],
      [' ', '- three', []],
      ['+', `${t('pageSource.changeAdded')} - four`, []],
      [' ', '', []],
    ])
    expect(container.querySelector('mark')).toHaveClass('line-through')
    expect(container.querySelectorAll('mark')[1]).toHaveClass('underline')
  })

  it('shows a Windows page edited line by line, a line break dropped, and a page emptied or filled', () => {
    const removed = t('pageSource.changeRemoved')
    const added = t('pageSource.changeAdded')
    const texts = (before: string, after: string): string[] =>
      rows(render(<PageSourceChanges diff={diffLines(before, after)} />).container).map(
        ([, text]) => text,
      )

    expect(texts('- one\r\n- two\r\n', '- one\r\n- 2\r\n')).toEqual([
      '- one',
      `${removed} - two`,
      `${added} - 2`,
      '',
    ])
    expect(texts('- one\n', '- one')).toEqual(['- one', `${removed} `])
    expect(texts('- one\n- two\n', '')).toEqual([`${removed} - one`, `${removed} - two`, ''])
    expect(texts('', '- one')).toEqual([`${removed} `, `${added} - one`])
  })

  it('folds a long unchanged run to the lines either side of each hunk', () => {
    const page = Array.from({ length: 20 }, (_, i) => `- line ${i}`)
    const { container } = render(
      <PageSourceChanges diff={diffLines(page.join('\n'), page.with(10, '- edited').join('\n'))} />,
    )

    expect(rows(container).map(([, text]) => text)).toEqual([
      t('pageSource.unchangedLines', { count: 7 }),
      '- line 7',
      '- line 8',
      '- line 9',
      `${t('pageSource.changeRemoved')} - line 10`,
      `${t('pageSource.changeAdded')} - edited`,
      '- line 11',
      '- line 12',
      '- line 13',
      t('pageSource.unchangedLines', { count: 6 }),
    ])
  })

  it('says there is nothing to show when the text is the page’s', () => {
    render(<PageSourceChanges diff={diffLines(BEFORE, BEFORE)} />)

    expect(screen.getByText(t('pageSource.noChanges'))).toBeInTheDocument()
    expect(screen.queryByTestId('page-source-changes')).not.toBeInTheDocument()
  })

  it('has no a11y violations', async () => {
    const { container } = render(<PageSourceChanges diff={diffLines(BEFORE, AFTER)} />)

    expect(await axe(container)).toHaveNoViolations()
  })
})
