/**
 * Tests for SearchInput — clear-button affordance (UX-221).
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { t } from '@/lib/i18n'
import { SearchInput } from '../search-input'

function Controlled({
  initial = '',
  onChange,
  placeholder,
}: {
  initial?: string
  onChange?: (value: string) => void
  placeholder?: string
}): React.ReactElement {
  const [value, setValue] = React.useState(initial)
  return (
    <SearchInput
      value={value}
      placeholder={placeholder ?? 'Search'}
      onChange={(e) => {
        setValue(e.target.value)
        onChange?.(e.target.value)
      }}
    />
  )
}

describe('SearchInput', () => {
  it('renders the underlying Input primitive', () => {
    render(<SearchInput value="" onChange={() => {}} placeholder="Search" />)
    const input = screen.getByPlaceholderText('Search') as HTMLInputElement
    expect(input.dataset['slot']).toBe('input')
  })

  it('does NOT render the clear button when value is empty', () => {
    render(<SearchInput value="" onChange={() => {}} placeholder="Search" />)
    expect(screen.queryByTestId('search-input-clear')).not.toBeInTheDocument()
  })

  it('renders the clear button when value is non-empty', () => {
    render(<SearchInput value="hello" onChange={() => {}} placeholder="Search" />)
    const clear = screen.getByTestId('search-input-clear')
    expect(clear).toBeInTheDocument()
    expect(clear).toHaveAttribute('aria-label', t('action.clear'))
  })

  it('clicking the clear button fires onChange with an empty value', async () => {
    const onChange = vi.fn()
    render(<Controlled initial="hello" onChange={onChange} placeholder="Search" />)

    const user = userEvent.setup()
    const clear = screen.getByTestId('search-input-clear')
    await user.click(clear)

    // onChange is called at least once with the cleared value.
    expect(onChange).toHaveBeenCalled()
    const calls = onChange.mock.calls.map((c) => c[0])
    expect(calls).toContain('')

    // After clear, the clear button disappears (value is empty).
    expect(screen.queryByTestId('search-input-clear')).not.toBeInTheDocument()
  })

  it('the clear button is type="button" so it does not submit a parent form', () => {
    render(
      <form>
        <SearchInput value="typed" onChange={() => {}} placeholder="Search" />
      </form>,
    )
    const clear = screen.getByTestId('search-input-clear') as HTMLButtonElement
    expect(clear.type).toBe('button')
  })

  it('forwards ref to the underlying input element', () => {
    const ref = React.createRef<HTMLInputElement>()
    render(<SearchInput ref={ref} value="" onChange={() => {}} placeholder="Search" />)
    expect(ref.current).toBeInstanceOf(HTMLInputElement)
  })

  it('allows typing characters — onChange fires with each new value', async () => {
    const onChange = vi.fn()
    render(<Controlled onChange={onChange} placeholder="Search" />)

    const user = userEvent.setup()
    const input = screen.getByPlaceholderText('Search')
    await user.type(input, 'ab')

    expect(onChange).toHaveBeenCalled()
    const last = onChange.mock.calls.at(-1)?.[0]
    expect(last).toBe('ab')
  })

  it('clear button respects 44px touch target via pointer:coarse classes', () => {
    render(<SearchInput value="x" onChange={() => {}} placeholder="Search" />)
    const clear = screen.getByTestId('search-input-clear')
    expect(clear.className).toContain('[@media(pointer:coarse)]:h-11')
    expect(clear.className).toContain('[@media(pointer:coarse)]:w-11')
  })

  it('has no a11y violations when the clear button is visible', async () => {
    const { container } = render(
      <SearchInput value="hello" onChange={() => {}} placeholder="Search" aria-label="Search" />,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations when the clear button is absent', async () => {
    const { container } = render(
      <SearchInput value="" onChange={() => {}} placeholder="Search" aria-label="Search" />,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
