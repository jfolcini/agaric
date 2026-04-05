/**
 * Tests for GlobalDateControls component.
 *
 * Validates:
 *  - Renders Today button and calendar icon button
 *  - Clicking Today navigates to journal daily view
 *  - Clicking calendar icon opens the calendar dropdown
 *  - a11y compliance
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { useJournalStore } from '../../stores/journal'
import { useNavigationStore } from '../../stores/navigation'
import { GlobalDateControls } from '../JournalPage'

// Mock the Calendar component used by JournalCalendarDropdown
vi.mock('../ui/calendar', () => ({
  Calendar: (props: Record<string, unknown>) => (
    <div data-testid="mock-calendar" {...props}>
      Calendar
    </div>
  ),
}))

const mockedInvoke = vi.mocked(invoke)
const emptyPage = { items: [], next_cursor: null, has_more: false }

beforeEach(() => {
  vi.clearAllMocks()
  useJournalStore.setState({
    mode: 'daily',
    currentDate: new Date(2025, 5, 15),
    scrollToDate: null,
    scrollToPanel: null,
  })
  useNavigationStore.setState({
    currentView: 'pages',
    pageStack: [],
    selectedBlockId: null,
  })
  mockedInvoke.mockResolvedValue(emptyPage)
})

describe('GlobalDateControls', () => {
  it('renders Today button', () => {
    render(<GlobalDateControls />)
    expect(screen.getByRole('button', { name: /today/i })).toBeInTheDocument()
  })

  it('renders calendar button', () => {
    render(<GlobalDateControls />)
    expect(screen.getByRole('button', { name: /calendar/i })).toBeInTheDocument()
  })

  it('clicking Today navigates to journal daily view', async () => {
    const user = userEvent.setup()
    render(<GlobalDateControls />)

    await user.click(screen.getByRole('button', { name: /today/i }))

    expect(useNavigationStore.getState().currentView).toBe('journal')
    expect(useJournalStore.getState().mode).toBe('daily')
  })

  it('clicking Today sets currentDate to today', async () => {
    const user = userEvent.setup()
    render(<GlobalDateControls />)

    const beforeClick = new Date()
    await user.click(screen.getByRole('button', { name: /today/i }))

    const currentDate = useJournalStore.getState().currentDate
    const diff = Math.abs(currentDate.getTime() - beforeClick.getTime())
    expect(diff).toBeLessThan(5000)
  })

  it('clicking calendar icon opens calendar dropdown', async () => {
    const user = userEvent.setup()
    render(<GlobalDateControls />)

    await user.click(screen.getByRole('button', { name: /calendar/i }))

    expect(screen.getByRole('dialog', { name: /date picker/i })).toBeInTheDocument()
  })

  it('fetches page list on mount for calendar highlighting', async () => {
    render(<GlobalDateControls />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'list_blocks',
        expect.objectContaining({
          blockType: 'page',
          limit: 500,
        }),
      )
    })
  })

  it('has no a11y violations', async () => {
    const { container } = render(<GlobalDateControls />)
    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
