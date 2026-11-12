/**
 * Tests for GlobalDateControls component.
 *
 * Validates:
 *  - Renders Today alone on every view but the journal (#6548)
 *  - Clicking Today navigates to journal daily view
 *  - Hidden on a touch phone only
 *  - a11y compliance
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { GlobalDateControls } from '@/components/agenda/GlobalDateControls'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useIsTouch } from '@/hooks/useIsTouch'
import { useJournalStore } from '@/stores/journal'
import { useNavigationStore, type View } from '@/stores/navigation'
import { useTabsStore } from '@/stores/tabs'

vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: vi.fn(() => false) }))
vi.mock('@/hooks/useIsTouch', () => ({ useIsTouch: vi.fn(() => false) }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(useIsMobile).mockReturnValue(false)
  vi.mocked(useIsTouch).mockReturnValue(false)
  useJournalStore.setState({
    mode: 'daily',
    currentDate: new Date(2025, 5, 15),
    scrollToDate: null,
    scrollToPanel: null,
  })
  useNavigationStore.setState({
    currentView: 'pages',
    selectedBlockId: null,
  })
  useTabsStore.setState({
    tabs: [{ id: '0', pageStack: [], label: '' }],
    activeTabIndex: 0,
  })
})

describe('GlobalDateControls', () => {
  // A touch phone reaches the journal from its drawer; a narrow mouse window keeps the row.
  it.each([true, false])('at phone width, hides only on touch (touch: %s)', (touch) => {
    vi.mocked(useIsMobile).mockReturnValue(true)
    vi.mocked(useIsTouch).mockReturnValue(touch)
    render(<GlobalDateControls />)
    expect(screen.queryByRole('button', { name: /go to today/i }) === null).toBe(touch)
  })

  it('renders Today button', () => {
    render(<GlobalDateControls />)
    expect(screen.getByRole('button', { name: /today/i })).toBeInTheDocument()
  })

  it('clicking Today navigates to journal daily view', async () => {
    const user = userEvent.setup()
    render(<GlobalDateControls />)

    await user.click(screen.getByRole('button', { name: /today/i }))

    expect(useNavigationStore.getState().currentView).toBe('journal')
    expect(useJournalStore.getState().mode).toBe('daily')
  })

  // #6548 — Agenda and the calendar used to join Today on an allowlist of
  // views; every view outside the journal now carries the same one button.
  it.each<View>(['pages', 'search', 'tags', 'query', 'settings', 'history', 'graph', 'trash'])(
    'renders Today alone on the %s view',
    async (view) => {
      const user = userEvent.setup()
      useNavigationStore.setState({ currentView: view, selectedBlockId: null })

      render(<GlobalDateControls />)

      expect(screen.getAllByRole('button')).toHaveLength(1)
      await user.click(screen.getByRole('button', { name: /go to today/i }))
      expect(useNavigationStore.getState().currentView).toBe('journal')
      expect(useJournalStore.getState().mode).toBe('daily')
    },
  )

  it('clicking Today sets currentDate to today', async () => {
    const user = userEvent.setup()
    render(<GlobalDateControls />)

    const beforeClick = new Date()
    await user.click(screen.getByRole('button', { name: /today/i }))

    const currentDate = useJournalStore.getState().currentDate
    const diff = Math.abs(currentDate.getTime() - beforeClick.getTime())
    expect(diff).toBeLessThan(5000)
  })

  it('has no a11y violations', async () => {
    const { container } = render(<GlobalDateControls />)
    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
