/**
 * Tests for TaskStatesSection component.
 *
 * Validates:
 *  - Renders existing task states (defaults: TODO, DOING, DONE)
 *  - Adds a new task state
 *  - Deletes a task state
 *  - Has no a11y violations (axe)
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import { TaskStatesSection } from '../TaskStatesSection'

beforeEach(() => {
  localStorage.removeItem('task_cycle')
})

describe('TaskStatesSection', () => {
  it('renders existing task states', () => {
    render(<TaskStatesSection />)

    expect(screen.getByText('none')).toBeInTheDocument()
    expect(screen.getByText('TODO')).toBeInTheDocument()
    expect(screen.getByText('DOING')).toBeInTheDocument()
    expect(screen.getByText('DONE')).toBeInTheDocument()
  })

  it('renders task states from localStorage', () => {
    localStorage.setItem('task_cycle', JSON.stringify([null, 'OPEN', 'CLOSED']))

    render(<TaskStatesSection />)

    expect(screen.getByText('none')).toBeInTheDocument()
    expect(screen.getByText('OPEN')).toBeInTheDocument()
    expect(screen.getByText('CLOSED')).toBeInTheDocument()
    expect(screen.queryByText('TODO')).not.toBeInTheDocument()
  })

  it('adds a new task state', async () => {
    const user = userEvent.setup()

    render(<TaskStatesSection />)

    const input = screen.getByPlaceholderText('New state (e.g., CANCELLED)')
    await user.type(input, 'REVIEW')

    const addBtn = screen.getByRole('button', { name: /Add/i })
    await user.click(addBtn)

    expect(screen.getByText('REVIEW')).toBeInTheDocument()
    expect(input).toHaveValue('')

    // Verify persisted to localStorage
    const stored = JSON.parse(localStorage.getItem('task_cycle') as string)
    expect(stored).toContain('REVIEW')
  })

  it('adds a new task state via Enter key', async () => {
    const user = userEvent.setup()

    render(<TaskStatesSection />)

    const input = screen.getByPlaceholderText('New state (e.g., CANCELLED)')
    await user.type(input, 'BLOCKED{Enter}')

    expect(screen.getByText('BLOCKED')).toBeInTheDocument()
    expect(input).toHaveValue('')
  })

  it('uppercases the input when adding', async () => {
    const user = userEvent.setup()

    render(<TaskStatesSection />)

    const input = screen.getByPlaceholderText('New state (e.g., CANCELLED)')
    await user.type(input, 'review{Enter}')

    expect(screen.getByText('REVIEW')).toBeInTheDocument()
  })

  it('does not add duplicate states', async () => {
    const user = userEvent.setup()

    render(<TaskStatesSection />)

    const input = screen.getByPlaceholderText('New state (e.g., CANCELLED)')
    await user.type(input, 'TODO{Enter}')

    // Should still have exactly one TODO
    const todos = screen.getAllByText('TODO')
    expect(todos).toHaveLength(1)
  })

  it('deletes a task state', async () => {
    const user = userEvent.setup()

    render(<TaskStatesSection />)

    expect(screen.getByText('DOING')).toBeInTheDocument()

    const removeBtn = screen.getByRole('button', { name: /Remove state DOING/i })
    await user.click(removeBtn)

    expect(screen.queryByText('DOING')).not.toBeInTheDocument()

    // Verify persisted to localStorage
    const stored = JSON.parse(localStorage.getItem('task_cycle') as string)
    expect(stored).not.toContain('DOING')
  })

  it('disables add button when input is empty', () => {
    render(<TaskStatesSection />)

    const addBtn = screen.getByRole('button', { name: /Add/i })
    expect(addBtn).toBeDisabled()
  })

  it('has no a11y violations', async () => {
    const { container } = render(<TaskStatesSection />)

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
