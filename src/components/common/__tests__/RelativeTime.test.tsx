/**
 * Tests for RelativeTime (#6895): a relative time that swaps in place to the
 * exact date and time on a press, and back, without acting on its row.
 */

import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { RelativeTime } from '@/components/common/RelativeTime'
import { formatTimestamp } from '@/lib/format'

const NOW = Date.parse('2026-11-18T12:00:00Z')
const THREE_HOURS_AGO = '2026-11-18T09:00:00Z'

describe('RelativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setInterval', 'clearInterval'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('ages while it stays mounted', () => {
    render(<RelativeTime value="2026-11-18T11:01:00Z" />)
    expect(screen.getByRole('button')).toHaveTextContent('59m ago')

    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(screen.getByRole('button')).toHaveTextContent('1h ago')
  })

  it('renders the relative time in a button carrying a machine-readable time', () => {
    render(<RelativeTime value={THREE_HOURS_AGO} />)

    const button = screen.getByRole('button', { name: '3h ago' })
    expect(button.querySelector('time')).toHaveAttribute('datetime', '2026-11-18T09:00:00.000Z')
  })

  it('swaps to the exact time on click and back on a second click', async () => {
    const user = userEvent.setup()
    render(<RelativeTime value={THREE_HOURS_AGO} />)
    const exact = formatTimestamp(THREE_HOURS_AGO, 'full')

    await user.click(screen.getByRole('button', { name: '3h ago' }))
    expect(screen.getByRole('button')).toHaveTextContent(exact)

    await user.click(screen.getByRole('button'))
    expect(screen.getByRole('button')).toHaveTextContent('3h ago')
  })

  it('swaps with Enter and Space', async () => {
    const user = userEvent.setup()
    render(<RelativeTime value={THREE_HOURS_AGO} />)
    const exact = formatTimestamp(THREE_HOURS_AGO, 'full')

    screen.getByRole('button').focus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('button')).toHaveTextContent(exact)
    await user.keyboard(' ')
    expect(screen.getByRole('button')).toHaveTextContent('3h ago')
  })

  it('does not reach a clickable row around it', async () => {
    const user = userEvent.setup()
    const onRowClick = vi.fn()
    render(
      // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- stands in for a selectable History row
      <div onClick={onRowClick}>
        <RelativeTime value={THREE_HOURS_AGO} />
      </div>,
    )

    await user.click(screen.getByRole('button'))
    expect(onRowClick).not.toHaveBeenCalled()
  })

  it('renders an unparseable value without a datetime instead of throwing', () => {
    render(<RelativeTime value="not a date" />)

    expect(screen.getByRole('button').querySelector('time')).not.toHaveAttribute('datetime')
  })

  it('has no a11y violations', async () => {
    const { container } = render(<RelativeTime value={THREE_HOURS_AGO} />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
