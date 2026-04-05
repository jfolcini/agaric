import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { ChoiceValuePicker } from '../ChoiceValuePicker'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ChoiceValuePicker', () => {
  const defaultProps = {
    choices: ['TODO', 'DOING', 'DONE'],
    label: 'Status',
    selected: [] as string[],
    onChange: vi.fn(),
  }

  function renderPicker(overrides?: Partial<typeof defaultProps>) {
    const props = { ...defaultProps, ...overrides }
    return render(<ChoiceValuePicker {...props} />)
  }

  // -----------------------------------------------------------------------
  // Rendering
  // -----------------------------------------------------------------------
  it('renders a checkbox for each choice', () => {
    renderPicker()
    const group = screen.getByRole('group', { name: /Status options/i })
    expect(within(group).getByLabelText('TODO')).toBeInTheDocument()
    expect(within(group).getByLabelText('DOING')).toBeInTheDocument()
    expect(within(group).getByLabelText('DONE')).toBeInTheDocument()
  })

  it('renders a fieldset with sr-only legend', () => {
    const { container } = renderPicker()
    const legend = container.querySelector('fieldset legend')
    expect(legend).toBeInTheDocument()
    expect(legend).toHaveClass('sr-only')
  })

  it('checks boxes that match selected values', () => {
    renderPicker({ selected: ['TODO', 'DONE'] })
    expect(screen.getByLabelText('TODO')).toBeChecked()
    expect(screen.getByLabelText('DOING')).not.toBeChecked()
    expect(screen.getByLabelText('DONE')).toBeChecked()
  })

  it('renders no checkboxes when choices array is empty', () => {
    renderPicker({ choices: [] })
    const group = screen.getByRole('group')
    expect(within(group).queryByRole('checkbox')).not.toBeInTheDocument()
  })

  // -----------------------------------------------------------------------
  // Interaction
  // -----------------------------------------------------------------------
  it('calls onChange with added value when unchecked box is clicked', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderPicker({ onChange })

    await user.click(screen.getByLabelText('TODO'))
    expect(onChange).toHaveBeenCalledWith(['TODO'])
  })

  it('calls onChange with removed value when checked box is clicked', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderPicker({ selected: ['TODO', 'DOING'], onChange })

    await user.click(screen.getByLabelText('TODO'))
    expect(onChange).toHaveBeenCalledWith(['DOING'])
  })

  it('supports selecting multiple values in sequence', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderPicker({ onChange })

    await user.click(screen.getByLabelText('TODO'))
    expect(onChange).toHaveBeenCalledWith(['TODO'])

    await user.click(screen.getByLabelText('DONE'))
    expect(onChange).toHaveBeenCalledWith(['DONE'])
  })

  it('uses custom label in aria attributes', () => {
    renderPicker({ label: 'Priority', choices: ['1', '2', '3'] })
    expect(screen.getByRole('group', { name: /Priority options/i })).toBeInTheDocument()
  })

  // -----------------------------------------------------------------------
  // A11y
  // -----------------------------------------------------------------------
  it('has no a11y violations with no selections', async () => {
    const { container } = renderPicker()
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations with selections', async () => {
    const { container } = renderPicker({ selected: ['TODO'] })
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
