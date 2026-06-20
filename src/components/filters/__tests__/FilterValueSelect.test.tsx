/**
 * Issue #1647 — tests for the shared `<FilterValueSelect>`, the value
 * control de-duplicated out of the search State/Priority and backlink
 * Status/Priority category forms.
 *
 * The component is vocabulary-AGNOSTIC: each surface passes its OWN
 * `options` so no value set is unified. These tests prove the control
 * renders an arbitrary caller-supplied vocabulary, distinguishes
 * `label` from `value`, forwards the trigger ref, and is axe-clean.
 *
 * `@/components/ui/select` is globally mocked as a native `<select>`
 * (see `src/test-setup.ts`), so `userEvent.selectOptions` drives the
 * value and options surface as `<option>` elements.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { FilterValueSelect, type FilterValueOption } from '../forms/FilterValueSelect'

const OPTIONS: FilterValueOption[] = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
  { value: 'c' }, // label falls back to value
]

function setup(override: Partial<React.ComponentProps<typeof FilterValueSelect>> = {}): {
  onValueChange: ReturnType<typeof vi.fn>
  container: HTMLElement
} {
  const onValueChange = vi.fn()
  const { container } = render(
    <FilterValueSelect
      options={OPTIONS}
      value="a"
      onValueChange={onValueChange}
      ariaLabel="Pick value"
      {...override}
    />,
  )
  return { onValueChange, container }
}

describe('FilterValueSelect — render', () => {
  it('renders one option per supplied vocabulary entry', () => {
    setup()
    expect(screen.getByRole('option', { name: 'Alpha' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Beta' })).toBeInTheDocument()
    // label falls back to value when omitted
    expect(screen.getByRole('option', { name: 'c' })).toBeInTheDocument()
  })

  it('exposes the trigger via the supplied aria-label', () => {
    setup()
    expect(screen.getByLabelText('Pick value')).toBeInTheDocument()
  })

  it('forwards triggerClassName onto the control', () => {
    setup({ triggerClassName: 'custom-cls' })
    expect(screen.getByLabelText('Pick value')).toHaveClass('custom-cls')
  })
})

describe('FilterValueSelect — interaction', () => {
  it('calls onValueChange with the selected value', async () => {
    const user = userEvent.setup()
    const { onValueChange } = setup()
    await user.selectOptions(screen.getByLabelText('Pick value'), 'b')
    expect(onValueChange).toHaveBeenCalledWith('b')
  })

  it('forwards the trigger ref to the control element', () => {
    const ref = createRef<HTMLButtonElement>()
    setup({ triggerRef: ref })
    // The mock renders the trigger as the native <select> that owns the
    // aria-label; the ref resolves to that element.
    expect(ref.current).toBe(screen.getByLabelText('Pick value'))
  })
})

describe('FilterValueSelect — a11y', () => {
  it('has no axe violations', async () => {
    const { container } = setup()
    expect(await axe(container as any)).toHaveNoViolations()
  })
})
