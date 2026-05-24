/**
 * PEND-70 CR8 MAJOR-1 — tests for `<PropFilterForm>` round-trip validation.
 *
 * The prop DSL has no quoting, so a KEY containing whitespace / `=` / `"`,
 * or a VALUE containing whitespace / `"`, would silently corrupt the
 * serialised query on re-parse. The form rejects those: Add stays disabled
 * and an inline `role="alert"` error is shown.
 *
 * Coverage:
 *  - invalid key (`a=b`, and with a space) disables Add + shows the error
 *  - invalid value (with a space) disables Add + shows the error
 *  - valid key+value enables Add and fires `onAddFilter` with the token
 *  - axe(container) clean
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { t } from '@/lib/i18n'
import { PropFilterForm } from '../filter-forms/PropFilterForm'

function setup(): { onAddFilter: ReturnType<typeof vi.fn>; container: HTMLElement } {
  const onAddFilter = vi.fn()
  const onBack = vi.fn()
  const { container } = render(<PropFilterForm onAddFilter={onAddFilter} onBack={onBack} />)
  return { onAddFilter, container }
}

const keyInput = (): HTMLElement => screen.getByLabelText(t('search.filterHelper.propKeyLabel'))
const valueInput = (): HTMLElement => screen.getByLabelText(t('search.filterHelper.propValueLabel'))
const addButton = (): HTMLElement =>
  screen.getByRole('button', { name: t('search.filterHelper.add') })

describe('PropFilterForm — round-trip validation (PEND-70 CR8 MAJOR-1)', () => {
  it('rejects a key containing `=` — Add disabled + inline error', async () => {
    const user = userEvent.setup()
    const { onAddFilter } = setup()
    await user.type(keyInput(), 'a=b')
    await user.type(valueInput(), 'x')
    expect(addButton()).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent(t('search.filterHelper.propKeyInvalid'))
    expect(keyInput()).toHaveAttribute('aria-invalid', 'true')
    // submitting via Enter is also a no-op
    await user.type(valueInput(), '{Enter}')
    expect(onAddFilter).not.toHaveBeenCalled()
  })

  it('rejects a key containing whitespace — Add disabled + inline error', async () => {
    const user = userEvent.setup()
    setup()
    await user.type(keyInput(), 'my key')
    await user.type(valueInput(), 'x')
    expect(addButton()).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent(t('search.filterHelper.propKeyInvalid'))
  })

  it('rejects a value containing whitespace — Add disabled + inline error', async () => {
    const user = userEvent.setup()
    const { onAddFilter } = setup()
    await user.type(keyInput(), 'status')
    await user.type(valueInput(), 'in progress')
    expect(addButton()).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent(t('search.filterHelper.propValueInvalid'))
    expect(valueInput()).toHaveAttribute('aria-invalid', 'true')
    await user.click(addButton())
    expect(onAddFilter).not.toHaveBeenCalled()
  })

  it('enables Add for a valid key+value and emits the expected token', async () => {
    const user = userEvent.setup()
    const { onAddFilter } = setup()
    expect(addButton()).toBeDisabled()
    await user.type(keyInput(), 'area')
    await user.type(valueInput(), 'work')
    expect(addButton()).toBeEnabled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await user.click(addButton())
    expect(onAddFilter).toHaveBeenCalledWith({
      kind: 'prop',
      key: 'area',
      value: 'work',
      span: [0, 0],
    })
  })

  it('allows a `=` inside the value (parser splits on the first `=`)', async () => {
    const user = userEvent.setup()
    const { onAddFilter } = setup()
    await user.type(keyInput(), 'eq')
    await user.type(valueInput(), 'a=b')
    expect(addButton()).toBeEnabled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await user.click(addButton())
    expect(onAddFilter).toHaveBeenCalledWith({
      kind: 'prop',
      key: 'eq',
      value: 'a=b',
      span: [0, 0],
    })
  })

  it('has no axe violations', async () => {
    const { container } = setup()
    // biome-ignore lint/suspicious/noExplicitAny: vitest-axe loose typing.
    expect(await axe(container as any)).toHaveNoViolations()
  })
})
