/**
 * Tests for DateChip, the one drawing of a due or a scheduled date (#7040 S2).
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { DateChip } from '@/components/common/DateChip'
import { formatCompactDate, formatDate, getTodayString } from '@/lib/date-utils'
import { t } from '@/lib/i18n'

function dayFromToday(offset: number): string {
  const d = new Date(`${getTodayString()}T00:00:00`)
  d.setDate(d.getDate() + offset)
  return formatDate(d)
}

function chipOf(container: HTMLElement): HTMLElement {
  const chip = container.querySelector<HTMLElement>('[data-date-kind]')
  if (!chip) throw new Error('no date chip rendered')
  return chip
}

describe('DateChip', () => {
  it('a due date carries the flag, a scheduled date the calendar clock', () => {
    const { container } = render(
      <>
        <DateChip kind="due" date="2099-06-15" />
        <DateChip kind="scheduled" date="2099-06-16" />
      </>,
    )
    const due = container.querySelector('[data-date-kind="due"]')
    const scheduled = container.querySelector('[data-date-kind="scheduled"]')
    expect(due?.querySelector('svg')).toHaveClass('lucide-flag')
    expect(scheduled?.querySelector('svg')).toHaveClass('lucide-calendar-clock')
    expect(due).toHaveClass('due-date-chip')
    expect(scheduled).toHaveClass('scheduled-chip')
  })

  it('names itself by kind and shows the compact date', () => {
    const { container } = render(
      <>
        <DateChip kind="due" date="2099-06-15" />
        <DateChip kind="scheduled" date="2099-06-16" />
      </>,
    )
    const [due, scheduled] = [...container.querySelectorAll<HTMLElement>('[data-date-kind]')]
    expect(due).toHaveTextContent(formatCompactDate('2099-06-15'))
    expect(due).toHaveTextContent(t('block.dueDate', { date: formatCompactDate('2099-06-15') }))
    expect(scheduled).toHaveTextContent(
      t('block.scheduledDate', { date: formatCompactDate('2099-06-16') }),
    )
  })

  it('a due date is red once past, amber today and neutral later', () => {
    const fills = [-1, 0, 1].map((offset) => {
      const { container, unmount } = render(<DateChip kind="due" date={dayFromToday(offset)} />)
      const classes = chipOf(container).className
      unmount()
      return classes
    })
    expect(fills[0]).toContain('bg-alert-error text-alert-error-foreground')
    expect(fills[1]).toContain('bg-date-due text-date-due-foreground')
    expect(fills[2]).toContain('bg-secondary text-secondary-foreground')
  })

  it('an overdue date says so by a solid flag, not by its colour alone', () => {
    const { container, rerender } = render(<DateChip kind="due" date={dayFromToday(-1)} />)
    expect(chipOf(container).querySelector('svg')).toHaveAttribute('fill', 'currentColor')
    rerender(<DateChip kind="due" date={dayFromToday(0)} />)
    expect(chipOf(container).querySelector('svg')).toHaveAttribute('fill', 'none')
  })

  it('a scheduled date is neutral whatever its day', () => {
    for (const offset of [-1, 0, 1]) {
      const { container, unmount } = render(
        <DateChip kind="scheduled" date={dayFromToday(offset)} />,
      )
      expect(chipOf(container)).toHaveClass('bg-secondary', 'text-secondary-foreground')
      unmount()
    }
  })

  it('is a button only when it is given something to do', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    const { container, rerender } = render(<DateChip kind="due" date="2099-06-15" />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(chipOf(container)).not.toHaveClass('touch-hit-area')

    rerender(<DateChip kind="due" date="2099-06-15" onClick={onClick} />)
    const button = screen.getByRole('button', {
      name: t('block.dueDate', { date: formatCompactDate('2099-06-15') }),
    })
    // The 44 px target is the invisible hit area, never the painted chip.
    expect(button).toHaveClass('touch-hit-area')
    await user.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it("a count keeps its kind: the glyph and the kind colour, with the caller's words", () => {
    const { container } = render(
      <DateChip kind="due" aria-label="4 Due items" onClick={vi.fn()}>
        4 Due
      </DateChip>,
    )
    const chip = chipOf(container)
    expect(chip).toHaveAccessibleName('4 Due items')
    expect(chip).toHaveTextContent('4 Due')
    expect(chip.querySelector('svg')).toHaveClass('lucide-flag')
    expect(chip).toHaveClass('bg-date-due', 'text-date-due-foreground')
  })

  it('has no a11y violations, as text and as a button', async () => {
    const { container } = render(
      <p>
        <DateChip kind="due" date="2099-06-15" />
        <DateChip kind="scheduled" date="2099-06-16" onClick={vi.fn()} />
      </p>,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})
