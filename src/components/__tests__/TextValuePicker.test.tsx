import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { TextValuePicker } from '../TextValuePicker'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('TextValuePicker', () => {
  const defaultProps = {
    selected: [] as string[],
    onChange: vi.fn(),
  }

  function renderPicker(overrides?: Partial<typeof defaultProps>) {
    const props = { ...defaultProps, ...overrides }
    return render(<TextValuePicker {...props} />)
  }

  // -----------------------------------------------------------------------
  // Rendering
  // -----------------------------------------------------------------------
  it('renders a text input with accessible label', () => {
    renderPicker()
    expect(screen.getByLabelText('Tag name')).toBeInTheDocument()
  })

  it('initializes input with first selected value', () => {
    renderPicker({ selected: ['my-tag'] })
    expect(screen.getByLabelText('Tag name')).toHaveValue('my-tag')
  })

  it('initializes empty when no selected values', () => {
    renderPicker()
    expect(screen.getByLabelText('Tag name')).toHaveValue('')
  })

  // -----------------------------------------------------------------------
  // Interaction
  // -----------------------------------------------------------------------
  it('calls onChange with trimmed value on input', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderPicker({ onChange })

    await user.type(screen.getByLabelText('Tag name'), 'work')
    expect(onChange).toHaveBeenLastCalledWith(['work'])
  })

  it('calls onChange with empty array when input is cleared', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderPicker({ selected: ['tag'], onChange })

    await user.clear(screen.getByLabelText('Tag name'))
    expect(onChange).toHaveBeenLastCalledWith([])
  })

  it('trims whitespace from input value', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderPicker({ onChange })

    const input = screen.getByLabelText('Tag name')
    await user.type(input, '  hello  ')

    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1]
    expect(lastCall?.[0][0]).not.toMatch(/^\s/)
    expect(lastCall?.[0][0]).not.toMatch(/\s$/)
  })

  it('calls onChange with empty array for whitespace-only input', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderPicker({ onChange })

    await user.type(screen.getByLabelText('Tag name'), '   ')
    expect(onChange).toHaveBeenLastCalledWith([])
  })

  // -----------------------------------------------------------------------
  // A11y
  // -----------------------------------------------------------------------
  it('has no a11y violations', async () => {
    const { container } = renderPicker()
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations with pre-filled value', async () => {
    const { container } = renderPicker({ selected: ['existing-tag'] })
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
