/**
 * CR-MINOR — dedicated tests for `<IncludeExcludeToggle>`.
 *
 * Previously this segmented control was only exercised transitively via
 * `FilterHelperPopover.test.tsx`. It is a controlled WAI-ARIA radiogroup:
 * two `role="radio"` buttons whose selection is driven by the `negate`
 * prop, with `onChange(negate)` fired on click.
 *
 * Coverage:
 *  - renders the group + both radios with the supplied labels
 *  - `aria-checked` reflects the controlled `negate` value
 *  - clicking a radio fires `onChange` with the matching boolean
 *  - axe(container) clean in both states
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { IncludeExcludeToggle } from '../filter-forms/IncludeExcludeToggle'

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

  it('still fires onChange when the already-selected option is clicked (controlled component)', async () => {
    const user = userEvent.setup()
    const { onChange } = setup(false)
    await user.click(includeRadio())
    expect(onChange).toHaveBeenCalledWith(false)
  })
})

describe('IncludeExcludeToggle — a11y', () => {
  it('has no axe violations with include selected', async () => {
    const { container } = setup(false)
    // biome-ignore lint/suspicious/noExplicitAny: vitest-axe loose typing.
    expect(await axe(container as any)).toHaveNoViolations()
  })

  it('has no axe violations with exclude selected', async () => {
    const { container } = setup(true)
    // biome-ignore lint/suspicious/noExplicitAny: vitest-axe loose typing.
    expect(await axe(container as any)).toHaveNoViolations()
  })
})
