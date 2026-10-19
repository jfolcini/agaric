/**
 * CR-MINOR — dedicated tests for `<IncludeExcludeToggle>`.
 *
 * Previously this segmented control was only exercised transitively via
 * `FilterHelperPopover.test.tsx`. It is a controlled WAI-ARIA radiogroup:
 * two `role="radio"` segments whose selection is driven by the `negate`
 * prop, with `onChange(negate)` fired on click or arrow key.
 *
 * Coverage:
 *  - renders the group + both radios with the supplied labels
 *  - `aria-checked` reflects the controlled `negate` value
 *  - clicking a radio fires `onChange` with the matching boolean
 *  - an arrow key moves the selection; only the checked radio is a tab stop
 *  - axe(container) clean in both states
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type React from 'react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { IncludeExcludeToggle } from '@/components/search/filter-forms/IncludeExcludeToggle'

const LABEL = 'Match mode'
const INCLUDE = 'Include'
const EXCLUDE = 'Exclude'

function setup(negate: boolean): { onChange: ReturnType<typeof vi.fn>; container: HTMLElement } {
  const onChange = vi.fn()
  const { container } = render(
    <IncludeExcludeToggle
      negate={negate}
      onChange={onChange}
      label={LABEL}
      includeLabel={INCLUDE}
      excludeLabel={EXCLUDE}
    />,
  )
  return { onChange, container }
}

const includeRadio = (): HTMLElement => screen.getByRole('radio', { name: INCLUDE })
const excludeRadio = (): HTMLElement => screen.getByRole('radio', { name: EXCLUDE })

describe('IncludeExcludeToggle — render', () => {
  it('renders a labelled radiogroup with both options', () => {
    setup(false)
    expect(screen.getByRole('radiogroup', { name: LABEL })).toBeInTheDocument()
    expect(screen.getAllByRole('radio')).toHaveLength(2)
    expect(includeRadio()).toBeInTheDocument()
    expect(excludeRadio()).toBeInTheDocument()
  })

  it('marks include checked when negate is false', () => {
    setup(false)
    expect(includeRadio()).toHaveAttribute('aria-checked', 'true')
    expect(excludeRadio()).toHaveAttribute('aria-checked', 'false')
  })

  it('marks exclude checked when negate is true', () => {
    setup(true)
    expect(excludeRadio()).toHaveAttribute('aria-checked', 'true')
    expect(includeRadio()).toHaveAttribute('aria-checked', 'false')
  })
})

describe('IncludeExcludeToggle — interaction', () => {
  it('fires onChange(true) when exclude is clicked from the include state', async () => {
    const user = userEvent.setup()
    const { onChange } = setup(false)
    await user.click(excludeRadio())
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('fires onChange(false) when include is clicked from the exclude state', async () => {
    const user = userEvent.setup()
    const { onChange } = setup(true)
    await user.click(includeRadio())
    expect(onChange).toHaveBeenCalledWith(false)
  })

  it('keeps the selection when the checked option is clicked again', async () => {
    const user = userEvent.setup()
    const { onChange } = setup(false)
    await user.click(includeRadio())
    expect(onChange).not.toHaveBeenCalled()
    expect(includeRadio()).toHaveAttribute('aria-checked', 'true')
  })
})

describe('IncludeExcludeToggle — keyboard', () => {
  function Stateful(): React.ReactElement {
    const [negate, setNegate] = useState(false)
    return (
      <>
        <button type="button">Before</button>
        <IncludeExcludeToggle
          negate={negate}
          onChange={setNegate}
          label={LABEL}
          includeLabel={INCLUDE}
          excludeLabel={EXCLUDE}
        />
      </>
    )
  }

  it('an arrow key moves the selection, and only the checked radio is a tab stop', async () => {
    const user = userEvent.setup()
    render(<Stateful />)
    screen.getByRole('button', { name: 'Before' }).focus()

    await user.tab()
    expect(includeRadio()).toHaveFocus()
    await user.keyboard('{ArrowRight}')

    expect(excludeRadio()).toHaveFocus()
    expect(excludeRadio()).toHaveAttribute('aria-checked', 'true')
    expect(includeRadio()).toHaveAttribute('aria-checked', 'false')
    expect(screen.getAllByRole('radio').filter((r) => r.tabIndex === 0)).toEqual([excludeRadio()])
  })
})

describe('IncludeExcludeToggle — a11y', () => {
  it('has no axe violations with include selected', async () => {
    const { container } = setup(false)
    expect(await axe(container as any)).toHaveNoViolations()
  })

  it('has no axe violations with exclude selected', async () => {
    const { container } = setup(true)
    expect(await axe(container as any)).toHaveNoViolations()
  })
})
