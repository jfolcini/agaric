/**
 * Footnotes `[^label]` in the static view (#6033): references numbered by the
 * order their labels first appear on the page, read once per page from the
 * page store; a definition block's marker; an undefined reference muted with a
 * tooltip; a click that focuses the definition.
 */

import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeBlock } from '@/__tests__/fixtures'
import { axe } from '@/__tests__/helpers/axe'
import { useRichContent } from '@/components/editor/useRichContent'
import { renderRichContent } from '@/components/RichContentRenderer'
import { t } from '@/lib/i18n'
import { createPageBlockStore, PageBlockContext, usePageBlockStore } from '@/stores/page-blocks'

const BLOCKS = [
  makeBlock({ id: 'B1', content: 'first [^b], then [^a]' }),
  makeBlock({ id: 'B2', content: 'again [^b] and [^gone]' }),
  makeBlock({ id: 'DA', content: '[^a]: alpha note' }),
  makeBlock({ id: 'DB', content: '[^b]: beta note' }),
]

/** A block as StaticBlock renders it: through `useRichContent`. */
function Row({ id, onNavigate }: { id: string; onNavigate: (id: string) => void }) {
  const content = usePageBlockStore((s) => s.blocksById.get(id)?.content ?? '')
  return <div data-testid={`row-${id}`}>{useRichContent(content, { onNavigate })}</div>
}

function Page({ onNavigate }: { onNavigate: (id: string) => void }) {
  const blocks = usePageBlockStore((s) => s.blocks)
  return (
    <>
      {blocks.map(({ id }) => (
        <Row key={id} id={id} onNavigate={onNavigate} />
      ))}
    </>
  )
}

function renderPage(blocks = BLOCKS) {
  const store = createPageBlockStore('PAGE')
  store.setState({ blocks, blocksById: new Map(blocks.map((b) => [b.id, b])) })
  const onNavigate = vi.fn()
  const view = render(
    <PageBlockContext.Provider value={store}>
      <Page onNavigate={onNavigate} />
    </PageBlockContext.Provider>,
  )
  return { ...view, store, onNavigate }
}

function row(id: string): HTMLElement {
  return screen.getByTestId(`row-${id}`)
}

/** The numbers a row's references show, in order. */
function refNumbers(id: string): string[] {
  return within(row(id))
    .queryAllByTestId('footnote-ref')
    .map((el) => el.firstChild?.textContent ?? '')
}

describe('footnotes in the static view (#6033)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('numbers references by the order their labels first appear on the page', () => {
    renderPage()
    expect(refNumbers('B1')).toEqual(['1', '2'])
    expect(refNumbers('B2')).toEqual(['1', '3'])
  })

  it('renumbers when the page’s blocks change', () => {
    const { store } = renderPage()
    const blocks = [makeBlock({ id: 'B0', content: 'now [^a] comes first' }), ...BLOCKS]
    act(() => store.setState({ blocks, blocksById: new Map(blocks.map((b) => [b.id, b])) }))
    expect(refNumbers('B0')).toEqual(['1'])
    expect(refNumbers('B1')).toEqual(['2', '1'])
  })

  it('shows a definition block’s prefix as its label’s number, then its text', () => {
    renderPage()
    expect(within(row('DA')).getByTestId('footnote-definition')).toHaveTextContent('2')
    expect(row('DA')).toHaveTextContent(/^2alpha note$/)
    expect(within(row('DB')).getByTestId('footnote-definition')).toHaveTextContent('1')
  })

  it('a click on a reference focuses its definition block, so does Enter', async () => {
    const user = userEvent.setup()
    const { onNavigate } = renderPage()
    await user.click(
      within(row('B1')).getByRole('link', { name: t('editor.footnoteLink', { number: 2 }) }),
    )
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith('DA')
    within(row('B2'))
      .getByRole('link', { name: t('editor.footnoteLink', { number: 1 }) })
      .focus()
    await user.keyboard('{Enter}')
    expect(onNavigate).toHaveBeenLastCalledWith('DB')
  })

  it('mutes a reference whose label nothing defines, with a tooltip', async () => {
    const user = userEvent.setup()
    const { onNavigate } = renderPage()
    const missing = within(row('B2')).getAllByTestId('footnote-ref')[1] as HTMLElement
    expect(missing).toHaveClass('footnote-ref-missing')
    expect(missing).not.toHaveAttribute('role')
    await user.hover(missing)
    expect(await screen.findByRole('tooltip')).toHaveTextContent(t('editor.footnoteMissing'))
    await user.click(missing)
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('shows the label as written where no page numbers it', () => {
    const { container } = render(<>{renderRichContent('see [^note]', {})}</>)
    expect(container).toHaveTextContent(/^see note$/)
    expect(container.querySelector('sup.footnote-ref')).toHaveTextContent('note')
  })

  it('has no a11y violations', async () => {
    const { container } = renderPage()
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })
})
