/**
 * Tests for DateChipEditor component (F-22).
 *
 * Validates:
 *  1. Renders quick date options (Today, Tomorrow, Next Week, Clear)
 *  2. Clicking "Today" calls setDueDate with today's date
 *  3. Clicking "Clear" calls setDueDate with null
 *  4. Natural language input works (typing + Enter)
 *  5. axe(container) a11y audit
 *  6. Popover opens and closes correctly (integration with Popover wrapper)
 *  7. Clicking "Tomorrow" calls setDueDate with tomorrow's date
 *  8. Clicking "Next Week" calls setDueDate with date +7 days
 *  9. Uses setScheduledDate when dateType is 'scheduled'
 * 10. Shows toast on success and error
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

// ── Mocks ──────────────────────────────────────────────────────────────

vi.mock('@/lib/tauri', () => ({
  setDueDate: vi.fn().mockResolvedValue({}),
  setScheduledDate: vi.fn().mockResolvedValue({}),
}))

vi.mock('@/lib/announcer', () => ({
  announce: vi.fn(),
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}))

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { announce } from '@/lib/announcer'
import { formatDate } from '@/lib/date-utils'
import { setDueDate, setScheduledDate } from '@/lib/tauri'
import { DateChipEditor } from '../DateChipEditor'

const mockedSetDueDate = vi.mocked(setDueDate)
const mockedSetScheduledDate = vi.mocked(setScheduledDate)
const mockedToast = vi.mocked(toast)
const mockedAnnounce = vi.mocked(announce)

function todayStr(): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return formatDate(d)
}

function tomorrowStr(): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + 1)
  return formatDate(d)
}

function nextWeekStr(): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + 7)
  return formatDate(d)
}

describe('DateChipEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedSetDueDate.mockResolvedValue({} as never)
    mockedSetScheduledDate.mockResolvedValue({} as never)
  })

  // 1. Renders quick date options
  it('renders quick date options (Today, Tomorrow, Next Week, Clear)', () => {
    render(<DateChipEditor blockId="B1" dateType="due" currentDate="2025-06-15" />)

    expect(screen.getByTestId('quick-today')).toHaveTextContent('Today')
    expect(screen.getByTestId('quick-tomorrow')).toHaveTextContent('Tomorrow')
    expect(screen.getByTestId('quick-next-week')).toHaveTextContent('Next Week')
    expect(screen.getByTestId('quick-clear')).toHaveTextContent('Clear')
  })

  // 2. Clicking "Today" calls setDueDate with today's date
  it('clicking "Today" calls setDueDate with today\'s date', async () => {
    const user = userEvent.setup()
    const onSuccess = vi.fn()

    render(
      <DateChipEditor blockId="B1" dateType="due" currentDate="2025-01-01" onSuccess={onSuccess} />,
    )

    await user.click(screen.getByTestId('quick-today'))

    await waitFor(() => {
      expect(mockedSetDueDate).toHaveBeenCalledWith('B1', todayStr())
    })
    await waitFor(() => {
      expect(mockedToast.success).toHaveBeenCalledWith('Date updated')
    })
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalled()
    })
  })

  // 3. Clicking "Clear" calls setDueDate with null
  it('clicking "Clear" calls setDueDate with null', async () => {
    const user = userEvent.setup()
    const onSuccess = vi.fn()

    render(
      <DateChipEditor blockId="B1" dateType="due" currentDate="2025-06-15" onSuccess={onSuccess} />,
    )

    await user.click(screen.getByTestId('quick-clear'))

    await waitFor(() => {
      expect(mockedSetDueDate).toHaveBeenCalledWith('B1', null)
    })
    await waitFor(() => {
      expect(mockedToast.success).toHaveBeenCalledWith('Date cleared')
    })
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalled()
    })
  })

  // 4. Natural language input works
  it('natural language input: typing "tomorrow" and pressing Enter calls setDueDate', async () => {
    const user = userEvent.setup()
    const onSuccess = vi.fn()

    render(<DateChipEditor blockId="B1" dateType="due" currentDate={null} onSuccess={onSuccess} />)

    const input = screen.getByRole('textbox')
    await user.type(input, 'tomorrow')

    // Preview appears after the 300ms NL parse debounce (useDateInput).
    await waitFor(
      () => {
        expect(screen.getByText(/Parsed:/)).toBeInTheDocument()
      },
      { timeout: 2000 },
    )

    await user.keyboard('{Enter}')

    await waitFor(() => {
      expect(mockedSetDueDate).toHaveBeenCalledWith('B1', tomorrowStr())
    })
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalled()
    })
  })

  // 4b. Invalid input shows parse error
  it('shows parse error for invalid input', async () => {
    const user = userEvent.setup()

    render(<DateChipEditor blockId="B1" dateType="due" currentDate={null} />)

    const input = screen.getByRole('textbox')
    await user.type(input, 'not-a-date')

    expect(screen.getByText('Could not parse date')).toBeInTheDocument()
  })

  // 5. axe a11y audit
  it('a11y: no violations', async () => {
    const { container } = render(
      <DateChipEditor blockId="B1" dateType="due" currentDate="2025-06-15" />,
    )

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  // 6. Popover opens and closes correctly
  it('popover opens on trigger click and shows DateChipEditor', async () => {
    const user = userEvent.setup()

    render(
      <Popover>
        <PopoverTrigger>Open Date Editor</PopoverTrigger>
        <PopoverContent>
          <DateChipEditor blockId="B1" dateType="due" currentDate="2025-06-15" />
        </PopoverContent>
      </Popover>,
    )

    // DateChipEditor should not be visible initially
    expect(screen.queryByTestId('date-chip-editor')).not.toBeInTheDocument()

    // Click to open
    await user.click(screen.getByText('Open Date Editor'))

    // Now the editor should be visible
    await waitFor(() => {
      expect(screen.getByTestId('date-chip-editor')).toBeInTheDocument()
    })
  })

  // 7. Clicking "Tomorrow" calls setDueDate with tomorrow's date
  it('clicking "Tomorrow" calls setDueDate with tomorrow\'s date', async () => {
    const user = userEvent.setup()

    render(<DateChipEditor blockId="B1" dateType="due" currentDate="2025-01-01" />)

    await user.click(screen.getByTestId('quick-tomorrow'))

    await waitFor(() => {
      expect(mockedSetDueDate).toHaveBeenCalledWith('B1', tomorrowStr())
    })
  })

  // 8. Clicking "Next Week" calls setDueDate with +7 days
  it('clicking "Next Week" calls setDueDate with date +7 days', async () => {
    const user = userEvent.setup()

    render(<DateChipEditor blockId="B1" dateType="due" currentDate="2025-01-01" />)

    await user.click(screen.getByTestId('quick-next-week'))

    await waitFor(() => {
      expect(mockedSetDueDate).toHaveBeenCalledWith('B1', nextWeekStr())
    })
  })

  // 9. Uses setScheduledDate when dateType is 'scheduled'
  it('uses setScheduledDate when dateType is "scheduled"', async () => {
    const user = userEvent.setup()

    render(<DateChipEditor blockId="B1" dateType="scheduled" currentDate="2025-01-01" />)

    await user.click(screen.getByTestId('quick-today'))

    await waitFor(() => {
      expect(mockedSetScheduledDate).toHaveBeenCalledWith('B1', todayStr())
    })
    expect(mockedSetDueDate).not.toHaveBeenCalled()
  })

  // 10. Shows error toast when API call fails
  it('shows error toast when API call fails', async () => {
    const user = userEvent.setup()
    mockedSetDueDate.mockRejectedValueOnce(new Error('Network error'))

    render(<DateChipEditor blockId="B1" dateType="due" currentDate="2025-01-01" />)

    await user.click(screen.getByTestId('quick-today'))

    await waitFor(() => {
      expect(mockedToast.error).toHaveBeenCalledWith('Failed to update date')
    })
  })

  // UX-282: screen-reader announcements paired with date-chip toast feedback
  it('announces date updated when applying a new date', async () => {
    const user = userEvent.setup()

    render(<DateChipEditor blockId="B1" dateType="due" currentDate="2025-01-01" />)

    await user.click(screen.getByTestId('quick-today'))

    await waitFor(() => {
      expect(mockedAnnounce).toHaveBeenCalledWith(`Date updated to ${todayStr()}`)
    })
  })

  it('announces date cleared when clearing the date', async () => {
    const user = userEvent.setup()

    render(<DateChipEditor blockId="B1" dateType="due" currentDate="2025-06-15" />)

    await user.click(screen.getByTestId('quick-clear'))

    await waitFor(() => {
      expect(mockedAnnounce).toHaveBeenCalledWith('Date cleared')
    })
  })
})
