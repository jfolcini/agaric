/**
 * Tests for StatusIcon shared component (M-21).
 *
 * Validates:
 *  1. Renders correct icon for each todo state (TODO, DOING, DONE)
 *  2. Renders TODO icon for null/unknown state (fallback)
 *  3. showDone={false} hides DONE icon (returns null)
 *  4. showDone={false} does not affect TODO or DOING
 *  5. a11y audit passes (axe)
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

vi.mock('lucide-react', () => ({
  Circle: (props: Record<string, unknown>) => <svg data-testid="icon-todo" {...props} />,
  Clock: (props: Record<string, unknown>) => <svg data-testid="icon-doing" {...props} />,
  CheckCircle2: (props: Record<string, unknown>) => <svg data-testid="icon-done" {...props} />,
  XCircle: (props: Record<string, unknown>) => <svg data-testid="icon-cancelled" {...props} />,
}))

import { StatusIcon } from '../status-icon'

describe('StatusIcon', () => {
  // 1. Renders correct icon for each todo state
  it('renders Circle icon for TODO state', () => {
    render(<StatusIcon state="TODO" />)
    expect(screen.getByTestId('icon-todo')).toBeInTheDocument()
    expect(screen.queryByTestId('icon-doing')).not.toBeInTheDocument()
    expect(screen.queryByTestId('icon-done')).not.toBeInTheDocument()
  })

  it('renders Clock icon for DOING state', () => {
    render(<StatusIcon state="DOING" />)
    expect(screen.getByTestId('icon-doing')).toBeInTheDocument()
    expect(screen.queryByTestId('icon-todo')).not.toBeInTheDocument()
    expect(screen.queryByTestId('icon-done')).not.toBeInTheDocument()
  })

  it('renders CheckCircle2 icon for DONE state', () => {
    render(<StatusIcon state="DONE" />)
    expect(screen.getByTestId('icon-done')).toBeInTheDocument()
    expect(screen.queryByTestId('icon-todo')).not.toBeInTheDocument()
    expect(screen.queryByTestId('icon-doing')).not.toBeInTheDocument()
  })

  it('renders XCircle icon for CANCELLED state (UX-202)', () => {
    render(<StatusIcon state="CANCELLED" />)
    expect(screen.getByTestId('icon-cancelled')).toBeInTheDocument()
    expect(screen.queryByTestId('icon-todo')).not.toBeInTheDocument()
    expect(screen.queryByTestId('icon-doing')).not.toBeInTheDocument()
    expect(screen.queryByTestId('icon-done')).not.toBeInTheDocument()
  })

  // 2. Fallback for null / unknown state
  it('renders Circle icon for null state', () => {
    render(<StatusIcon state={null} />)
    expect(screen.getByTestId('icon-todo')).toBeInTheDocument()
  })

  it('renders Circle icon for unknown state', () => {
    render(<StatusIcon state="WAITING" />)
    expect(screen.getByTestId('icon-todo')).toBeInTheDocument()
  })

  // 3. showDone={false} hides DONE
  it('returns null for DONE when showDone is false', () => {
    const { container } = render(<StatusIcon state="DONE" showDone={false} />)
    expect(container.innerHTML).toBe('')
    expect(screen.queryByTestId('icon-done')).not.toBeInTheDocument()
  })

  // 4. showDone={false} does not affect TODO or DOING
  it('still renders TODO when showDone is false', () => {
    render(<StatusIcon state="TODO" showDone={false} />)
    expect(screen.getByTestId('icon-todo')).toBeInTheDocument()
  })

  it('still renders DOING when showDone is false', () => {
    render(<StatusIcon state="DOING" showDone={false} />)
    expect(screen.getByTestId('icon-doing')).toBeInTheDocument()
  })

  // showDone defaults to true
  it('shows DONE icon by default (showDone defaults to true)', () => {
    render(<StatusIcon state="DONE" />)
    expect(screen.getByTestId('icon-done')).toBeInTheDocument()
  })

  // 5. a11y audit passes (axe)
  it('a11y: no violations for TODO state', async () => {
    const { container } = render(<StatusIcon state="TODO" />)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('a11y: no violations for DOING state', async () => {
    const { container } = render(<StatusIcon state="DOING" />)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('a11y: no violations for DONE state', async () => {
    const { container } = render(<StatusIcon state="DONE" />)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('a11y: no violations for CANCELLED state (UX-202)', async () => {
    const { container } = render(<StatusIcon state="CANCELLED" />)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
