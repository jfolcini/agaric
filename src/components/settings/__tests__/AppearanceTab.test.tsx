/**
 * Tests for AppearanceTab's tooltip-delay Select (#2851) and its language
 * Select (#4555).
 *
 * The theme / font-size / motion / week-start / journal-date-format
 * controls on this tab are already covered end-to-end via
 * `SettingsView.test.tsx`; this file focuses on the tooltip-delay and
 * language preferences plus a standalone a11y audit of the tab.
 *
 * Radix Select is mocked globally via `src/test-setup.ts` (see
 * `src/__tests__/mocks/ui-select.tsx`) — it renders as a native `<select>`,
 * so it's exercised with `getByLabelText` + `userEvent.selectOptions`.
 */

import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'

import { AppearanceTab } from '@/components/settings/AppearanceTab'
import { i18n, t } from '@/lib/i18n'

const KEY = 'agaric-tooltip-delay'
const LANGUAGE_KEY = 'agaric-language'

afterEach(async () => {
  await act(async () => {
    await i18n.changeLanguage('en')
  })
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

// #4555 — the language control. Asserted through the RE-QUERIED effect (the
// strings the tab actually renders, and `documentElement.lang`), not through
// the call shape of a setter.
describe('AppearanceTab — language', () => {
  it('defaults to English, not to the device', () => {
    render(<AppearanceTab />)
    // Phase 1 ships one substantially-translated locale. Following the device
    // would put a Spanish-OS user into a ~99% English UI announced as Spanish
    // — see the `agaric-language` preference for the full argument, and flip
    // both together when a second catalog is real.
    expect(screen.getByLabelText(t('settings.languageLabel'))).toHaveValue('en')
  })

  it('offers exactly system/en/es', () => {
    render(<AppearanceTab />)
    const select = screen.getByLabelText(t('settings.languageLabel')) as HTMLSelectElement
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['system', 'en', 'es'])
  })

  it('reflects a stored preference on mount', () => {
    localStorage.setItem(LANGUAGE_KEY, 'en')
    render(<AppearanceTab />)
    expect(screen.getByLabelText(t('settings.languageLabel'))).toHaveValue('en')
  })

  it('choosing Español persists it and re-renders the tab in Spanish', async () => {
    const user = userEvent.setup()
    render(<AppearanceTab />)

    await user.selectOptions(screen.getByLabelText(t('settings.languageLabel')), 'es')

    expect(localStorage.getItem(LANGUAGE_KEY)).toBe('es')
    // The label itself is one of the keys this PR translates, so the control
    // renames itself — no reload, no remount.
    await waitFor(() => {
      expect(screen.getByLabelText('Idioma')).toBeInTheDocument()
    })
    expect(document.documentElement.lang).toBe('es')
    // An untranslated key on the same screen still renders English, which is
    // the partial-catalog fallback working rather than a bug.
    expect(screen.getByLabelText('Theme')).toBeInTheDocument()
  })

  it('switching back to English restores the English labels', async () => {
    const user = userEvent.setup()
    render(<AppearanceTab />)
    const label = screen.getByLabelText(t('settings.languageLabel'))

    await user.selectOptions(label, 'es')
    await waitFor(() => {
      expect(screen.getByLabelText('Idioma')).toBeInTheDocument()
    })

    await user.selectOptions(screen.getByLabelText('Idioma'), 'en')
    await waitFor(() => {
      expect(screen.getByLabelText('Language')).toBeInTheDocument()
    })
    expect(document.documentElement.lang).toBe('en')
  })

  it('has no a11y violations in Spanish', async () => {
    localStorage.setItem(LANGUAGE_KEY, 'es')
    const { container } = render(<AppearanceTab />)
    await waitFor(() => {
      expect(screen.getByLabelText('Idioma')).toBeInTheDocument()
    })
    expect(await axe(container)).toHaveNoViolations()
  })
})
