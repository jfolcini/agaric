/**
 * PageSourcePreview — the Preview of Edit as Markdown: the buffer's blocks as
 * the page shows them, names as the chips the save would link.
 */

import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { emptyNewNames, PageSourcePreview, withNameIds } from '@/components/pages/PageSourcePreview'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'

const NOTES = '01J000000000000000000NOTES'
const WORK = '01J0000000000000000000WORK'
const BLOCK = '01J000000000000000000BLOCK'

const PIPED = '01J00000000000000000PIPED1'

const lookup = (name: string): string | null =>
  ({ 'Quick Notes': NOTES, work: WORK, 'Draft|Final': PIPED })[name] ?? null

beforeEach(() => {
  useSpaceStore.setState({ currentSpaceId: 'SPACE_TEST' })
  useResolveStore.setState({ cache: new Map(), version: 0, _preloaded: false })
  useResolveStore.getState().set(NOTES, 'Quick Notes', false, true)
  useResolveStore.getState().set(WORK, 'work', false, true)
})

describe('withNameIds', () => {
  it('writes a known [[Title]] and #tag as their ids, a label kept, a code span left alone', () => {
    expect(
      withNameIds(
        'see [[Quick Notes]] and [[Quick Notes|these]] #work `[[Quick Notes]]`',
        lookup,
        emptyNewNames(),
      ),
    ).toBe(`see [[${NOTES}]] and [[${NOTES}|these]] #[${WORK}] \`[[Quick Notes]]\``)
  })

  it('reads a link body naming a page whole before splitting off a label', () => {
    expect(withNameIds('[[Draft|Final]] [[Quick Notes|Final]]', lookup, emptyNewNames())).toBe(
      `[[${PIPED}]] [[${NOTES}|Final]]`,
    )
  })

  it('writes a name nothing holds as one id, the same each time', () => {
    const newNames = emptyNewNames()
    const once = withNameIds('[[Brand New]]', lookup, newNames)

    expect(once).toMatch(/^\[\[Z{16}\d{10}\]\]$/)
    expect(withNameIds('[[Brand New]]', lookup, newNames)).toBe(once)
    expect(withNameIds('[[Other]]', lookup, newNames)).not.toBe(once)
  })
})

describe('PageSourcePreview', () => {
  const text = [
    '---',
    'aliases: [gs]',
    '---',
    '',
    '- [ ] Read [[Quick Notes]] and [[Brand New]] #work',
    '  priority:: 1',
    '  - **bold** child',
    '',
  ].join('\n')
  const lines = { text, lineIds: [null, null, null, null, BLOCK, null, null, null] }

  it('renders each block as the page shows it: its task, its chips, its properties, its child nested', () => {
    render(<PageSourcePreview lines={lines} />)

    const [first, child] = screen.getAllByTestId('page-source-preview-block')
    expect(within(first as HTMLElement).getByTestId('task-checkbox-todo')).toBeInTheDocument()
    expect(
      within(first as HTMLElement)
        .getAllByTestId('block-link-chip')
        .map((chip) => chip.textContent),
    ).toEqual(['Quick Notes', 'Brand New'])
    expect(within(first as HTMLElement).getByTestId('tag-ref-chip')).toHaveTextContent('work')
    expect(within(first as HTMLElement).getByRole('group')).toHaveTextContent(/1/)
    expect(child).toHaveStyle({ marginInlineStart: '1.5rem' })
    expect(within(child as HTMLElement).getByText('bold').tagName).toBe('STRONG')
    expect(screen.getAllByTestId('property-chip')[0]).toHaveTextContent('[gs]')
  })

  it('shows a link whose case differs in a non-ASCII letter as the page it names (#6052)', () => {
    useResolveStore.getState().set('01J0000000000000000000UBER', 'Über', false, true)
    render(<PageSourcePreview lines={{ text: '- see [[über]]', lineIds: [BLOCK] }} />)

    expect(screen.getByTestId('block-link-chip')).toHaveTextContent('Über')
  })

  it('draws a list marker only on a list block, not on a heading written as one', () => {
    render(<PageSourcePreview lines={{ text: '- - # Title\n- - item', lineIds: [null, null] }} />)

    const [heading, item] = screen.getAllByTestId('page-source-preview-block')
    expect(within(heading as HTMLElement).getByRole('heading')).toHaveTextContent('Title')
    expect(within(heading as HTMLElement).queryByTestId('list-marker')).not.toBeInTheDocument()
    expect(within(item as HTMLElement).getByTestId('list-marker')).toHaveTextContent('•')
  })

  it('numbers a list past a heading that carries a numbered style as a fresh run', () => {
    render(
      <PageSourcePreview
        lines={{ text: '- 1. one\n- 1. # Title\n- 1. two', lineIds: [null, null, null] }}
      />,
    )

    expect(screen.getAllByTestId('list-marker').map((marker) => marker.textContent)).toEqual([
      '1.',
      '1.',
    ])
  })

  it('says the page would have no blocks for an empty buffer', () => {
    render(<PageSourcePreview lines={{ text: '', lineIds: [null] }} />)

    expect(screen.queryByTestId('page-source-preview-block')).not.toBeInTheDocument()
    expect(screen.getByText('Saved like this, the page has no blocks.')).toBeInTheDocument()
  })

  it('has no a11y violations', async () => {
    const { container } = render(<PageSourcePreview lines={lines} />)

    expect(await axe(container)).toHaveNoViolations()
  })
})
