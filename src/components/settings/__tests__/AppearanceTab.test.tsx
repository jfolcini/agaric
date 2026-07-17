/**
 * Tests for AppearanceTab's tooltip-delay Select (#2851).
 *
 * The theme / font-size / motion / week-start / journal-date-format
 * controls on this tab are already covered end-to-end via
 * `SettingsView.test.tsx`; this file focuses on the new tooltip-delay
 * preference plus a standalone a11y audit of the tab.
 *
 * Radix Select is mocked globally via `src/test-setup.ts` (see
 * `src/__tests__/mocks/ui-select.tsx`) — it renders as a native `<select>`,
 * so it's exercised with `getByLabelText` + `userEvent.selectOptions`.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'

import { AppearanceTab } from '@/components/settings/AppearanceTab'
import { t } from '@/lib/i18n'

const KEY = 'agaric-tooltip-delay'

afterEach(() => {
  localStorage.clear()
  document.documentElement.style.removeProperty('--agaric-font-size')
  document.documentElement.style.removeProperty('--motion-scale')
  document.documentElement.removeAttribute('data-motion')
})

describe('AppearanceTab — tooltip delay', () => {
  it('defaults to "Default" when nothing is stored', () => {
    render(<AppearanceTab />)
    const select = screen.getByLabelText(t('settings.tooltipDelayLabel'))
    expect(select).toHaveValue('default')
  })

  it('reflects a stored preference on mount', () => {
    localStorage.setItem(KEY, 'fast')
    render(<AppearanceTab />)
    const select = screen.getByLabelText(t('settings.tooltipDelayLabel'))
    expect(select).toHaveValue('fast')
  })

  it('changing the value persists the choice to localStorage', async () => {
    const user = userEvent.setup()
    render(<AppearanceTab />)
    const select = screen.getByLabelText(t('settings.tooltipDelayLabel'))

    await user.selectOptions(select, 'instant')
    expect(select).toHaveValue('instant')
    expect(localStorage.getItem(KEY)).toBe('instant')

    await user.selectOptions(select, 'default')
    expect(select).toHaveValue('default')
    expect(localStorage.getItem(KEY)).toBe('default')
  })

  it('offers exactly the instant/fast/default options', () => {
    render(<AppearanceTab />)
    const select = screen.getByLabelText(t('settings.tooltipDelayLabel')) as HTMLSelectElement
    const values = Array.from(select.options).map((o) => o.value)
    expect(values).toEqual(['instant', 'fast', 'default'])
  })

  it('has no a11y violations', async () => {
    const { container } = render(<AppearanceTab />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
