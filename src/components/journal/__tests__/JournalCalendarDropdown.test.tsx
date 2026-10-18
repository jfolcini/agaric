/**
 * Tests for JournalCalendarDropdown focus restoration (WCAG 2.4.3, #1101).
 *
 * The dropdown is a non-modal role="dialog" popover. On every dismiss path
 * (Escape, backdrop click, date/week/month select) it unmounts; without focus
 * restoration the page focus falls to <body>, stranding keyboard/SR users.
 * These tests assert that closing the dropdown returns focus to whatever held
 * it when the dropdown opened (the trigger button), via a self-contained
 * snapshot-on-mount / restore-on-unmount effect (no focus trap added).
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { stubInvoke } from '@/__tests__/helpers/invoke'
import { JournalCalendarDropdown } from '@/components/journal/JournalCalendarDropdown'
import { useIsMobile } from '@/hooks/useIsMobile'
import { logger } from '@/lib/logger'
import { useSpaceStore } from '@/stores/space'

// Mock the heavy react-day-picker Calendar with a minimal interactive stub that
// exposes a day button (to exercise the date-select dismiss path) while keeping
// the dropdown's own dialog/backdrop markup intact.
vi.mock('@/components/ui/calendar', () => ({
  Calendar: ({ onSelect }: { onSelect?: (day: Date) => void }) => (
    <div data-testid="mock-calendar">
      <button type="button" onClick={() => onSelect?.(new Date(2025, 5, 20))}>
        pick-day
      </button>
    </div>
  ),
}))

vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: vi.fn(() => false) }))

const mockedInvoke = vi.mocked(invoke)

/** Render a real trigger button alongside the (initially closed) dropdown so we
 * can verify focus returns to the trigger after close, exactly as in app use. */
function Harness({ onClose }: { onClose?: () => void } = {}) {
  const [open, setOpen] = useState(false)
  const close = () => {
    setOpen(false)
    onClose?.()
  }
  return (
    <div className="relative">
      <button
        type="button"
        aria-label="Open calendar picker"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        cal
      </button>
      {open && (
        <JournalCalendarDropdown
          currentDate={new Date(2025, 5, 15)}
          onSelectDate={close}
          onSelectWeek={close}
          onSelectMonth={close}
          onClose={close}
        />
      )}
    </div>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(useIsMobile).mockReturnValue(false)
  // #5415 — the agenda-count IPC carries the active space.
  useSpaceStore.setState({ currentSpaceId: 'SPACE_1' })
  // The two reads the dropdown fires for the displayed month: per-date agenda
  // counts by source, and the journal pages to highlight.
  stubInvoke(mockedInvoke, {
    count_agenda_batch_by_source: () => ({}),
    list_journal_pages_in_range: () => [],
  })
})

describe('JournalCalendarDropdown focus restoration (#1101)', () => {
  it('returns focus to the trigger when closed via Escape', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    const trigger = screen.getByRole('button', { name: /open calendar picker/i })
    await user.click(trigger)
    expect(screen.getByRole('dialog', { name: /date picker/i })).toBeInTheDocument()

    await user.keyboard('{Escape}')

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(trigger).toHaveFocus()
  })

  it('returns focus to the trigger when closed via a date select', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    const trigger = screen.getByRole('button', { name: /open calendar picker/i })
    await user.click(trigger)
    expect(screen.getByRole('dialog', { name: /date picker/i })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'pick-day' }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(trigger).toHaveFocus()
  })

  it('returns focus to the trigger when closed via the backdrop', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    const trigger = screen.getByRole('button', { name: /open calendar picker/i })
    await user.click(trigger)
    const backdrop = document.querySelector('[role="presentation"]') as HTMLElement
    expect(backdrop).not.toBeNull()

    await user.click(backdrop)

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(trigger).toHaveFocus()
  })

  it('has no a11y violations while open', async () => {
    const user = userEvent.setup()
    const { container } = render(<Harness />)

    await user.click(screen.getByRole('button', { name: /open calendar picker/i }))
    expect(screen.getByRole('dialog', { name: /date picker/i })).toBeInTheDocument()

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})

describe('JournalCalendarDropdown IPC error path (#1270)', () => {
  it('logs a warning and keeps rendering when the agenda-count fetch rejects', async () => {
    const user = userEvent.setup()
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    // The `countAgendaBatchBySource` IPC (routed through `invoke`) rejects on
    // mount — the dropdown must swallow it (catch branch), not crash.
    stubInvoke(mockedInvoke, {
      count_agenda_batch_by_source: () => Promise.reject(new Error('agenda fetch failed')),
    })

    render(<Harness />)
    await user.click(screen.getByRole('button', { name: /open calendar picker/i }))

    // The dropdown still opens — the rejection is caught, not propagated.
    expect(screen.getByRole('dialog', { name: /date picker/i })).toBeInTheDocument()
    // The catch branch logged the failure with the block's diagnostic tuple.
    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        'JournalCalendarDropdown',
        'Failed to load agenda counts for calendar',
        undefined,
        expect.any(Error),
      )
    })

    warnSpy.mockRestore()
  })
})

// #5925 — the anchored panel is wider than a 360 px phone, so a phone gets the
// same picker as a bottom sheet.
describe('JournalCalendarDropdown on a phone (#5925)', () => {
  beforeEach(() => {
    vi.mocked(useIsMobile).mockReturnValue(true)
  })

  it('opens as a bottom sheet titled Date picker', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole('button', { name: /open calendar picker/i }))

    const sheet = screen.getByRole('dialog', { name: 'Date picker' })
    expect(sheet).toHaveAttribute('data-slot', 'sheet-content')
    expect(sheet).toContainElement(screen.getByTestId('mock-calendar'))
    expect(sheet).toContainElement(screen.getByTestId('calendar-legend'))
  })

  it('selects a date and closes, returning focus to the trigger', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)

    const trigger = screen.getByRole('button', { name: /open calendar picker/i })
    await user.click(trigger)
    await user.click(screen.getByRole('button', { name: 'pick-day' }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(onClose).toHaveBeenCalled()
    expect(trigger).toHaveFocus()
  })

  it("closes from the sheet's close button", async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)

    await user.click(screen.getByRole('button', { name: /open calendar picker/i }))
    await user.click(screen.getByRole('button', { name: 'Close' }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('has no a11y violations while open', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole('button', { name: /open calendar picker/i }))
    const sheet = screen.getByRole('dialog', { name: 'Date picker' })
    await waitFor(() => expect(sheet).toHaveAttribute('aria-busy', 'false'))

    expect(await axe(sheet)).toHaveNoViolations()
  })
})
