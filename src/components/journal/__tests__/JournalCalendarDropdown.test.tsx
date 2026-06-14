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

import { JournalCalendarDropdown } from '@/components/journal/JournalCalendarDropdown'

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
          highlightedDays={[]}
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
  mockedInvoke.mockResolvedValue({})
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
