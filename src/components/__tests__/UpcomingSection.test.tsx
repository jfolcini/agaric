/**
 * Tests for UpcomingSection component.
 *
 * Validates:
 *  - Renders upcoming blocks with count badge
 *  - Returns null for empty blocks
 *  - Shows todo_state badge
 *  - Sorts blocks by due_date
 *  - Navigation on click
 *  - Navigation on keyboard (Enter)
 *  - Renders due_date for each block
 *  - Does not navigate when page_id is null
 *  - a11y audit passes (axe)
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { t } from '@/lib/i18n'

import { makeBlock as _makeBlock } from '../../__tests__/fixtures'
import { UpcomingSection } from '../UpcomingSection'

/** Shared factory + domain defaults for UpcomingSection tests. */
const makeBlock = (overrides: Parameters<typeof _makeBlock>[0] = {}) =>
  _makeBlock({
    id: 'B1',
    block_type: 'block',
    content: 'upcoming block',
    parent_id: 'PAGE1',
    page_id: 'PAGE1',
    todo_state: 'TODO',
    due_date: '2025-07-01',
    ...overrides,
  })

describe('UpcomingSection', () => {
  const defaultTitles = new Map([['PAGE1', 'My Page']])

  it('renders upcoming title and count badge', () => {
    const blocks = [makeBlock({ id: 'B1' }), makeBlock({ id: 'B2', content: 'second' })]

    render(<UpcomingSection blocks={blocks} pageTitles={defaultTitles} />)

    expect(screen.getByText(t('duePanel.upcomingTitle'))).toBeInTheDocument()
    expect(screen.getByText('(2)')).toBeInTheDocument()
  })

  it('returns null when blocks array is empty', () => {
    const { container } = render(<UpcomingSection blocks={[]} pageTitles={new Map()} />)

    expect(container.innerHTML).toBe('')
  })

  it('shows todo_state badge when present', () => {
    render(
      <UpcomingSection
        blocks={[makeBlock({ id: 'B1', todo_state: 'DOING' })]}
        pageTitles={defaultTitles}
      />,
    )

    expect(screen.getByText('DOING')).toBeInTheDocument()
  })

  it('does not show todo_state badge when null', () => {
    render(
      <UpcomingSection
        blocks={[makeBlock({ id: 'B1', todo_state: null })]}
        pageTitles={defaultTitles}
      />,
    )

    expect(screen.queryByText(/^(TODO|DOING|DONE)$/)).not.toBeInTheDocument()
  })

  it('sorts blocks by due_date ascending', () => {
    const blocks = [
      makeBlock({ id: 'B1', content: 'later', due_date: '2025-07-10' }),
      makeBlock({ id: 'B2', content: 'earlier', due_date: '2025-07-01' }),
      makeBlock({ id: 'B3', content: 'middle', due_date: '2025-07-05' }),
    ]

    render(<UpcomingSection blocks={blocks} pageTitles={defaultTitles} />)

    const items = screen.getAllByText(/earlier|middle|later/)
    expect(items[0]).toHaveTextContent('earlier')
    expect(items[1]).toHaveTextContent('middle')
    expect(items[2]).toHaveTextContent('later')
  })

  it('navigates to parent page on click', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()

    render(
      <UpcomingSection
        blocks={[
          makeBlock({ id: 'BK1', parent_id: 'PAGE1', page_id: 'PAGE1', content: 'click me' }),
        ]}
        pageTitles={new Map([['PAGE1', 'Source Page']])}
        onNavigateToPage={onNavigate}
      />,
    )

    const item = screen.getByText('click me')
    await user.click(item.closest('li') as HTMLElement)

    expect(onNavigate).toHaveBeenCalledWith('PAGE1', 'Source Page', 'BK1')
  })

  it('navigates to parent page on Enter key', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()

    render(
      <UpcomingSection
        blocks={[
          makeBlock({ id: 'BK2', parent_id: 'PAGE1', page_id: 'PAGE1', content: 'key block' }),
        ]}
        pageTitles={new Map([['PAGE1', 'Key Page']])}
        onNavigateToPage={onNavigate}
      />,
    )

    const item = screen.getByText('key block')
    const li = item.closest('li') as HTMLElement
    li.focus()
    await user.keyboard('{Enter}')

    expect(onNavigate).toHaveBeenCalledWith('PAGE1', 'Key Page', 'BK2')
  })

  it('renders due_date for each block', () => {
    render(
      <UpcomingSection
        blocks={[makeBlock({ id: 'B1', due_date: '2025-07-15' })]}
        pageTitles={defaultTitles}
      />,
    )

    expect(screen.getByText('2025-07-15')).toBeInTheDocument()
  })

  it('does not navigate when parent_id is null', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()

    render(
      <UpcomingSection
        blocks={[makeBlock({ id: 'B1', parent_id: null, page_id: null, content: 'orphan' })]}
        pageTitles={new Map()}
        onNavigateToPage={onNavigate}
      />,
    )

    const item = screen.getByText('orphan')
    await user.click(item.closest('li') as HTMLElement)

    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('a11y: no violations', async () => {
    const { container } = render(
      <UpcomingSection
        blocks={[makeBlock({ id: 'B1', todo_state: 'TODO', content: 'a11y block' })]}
        pageTitles={defaultTitles}
      />,
    )

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('a11y: no violations when empty', async () => {
    const { container } = render(<UpcomingSection blocks={[]} pageTitles={new Map()} />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
