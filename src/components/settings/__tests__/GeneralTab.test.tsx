/**
 * Tests for GeneralTab (#5629): render, a11y, and its language Select (#4555).
 *
 * The week-start and journal-date-format controls are covered through
 * `SettingsView.test.tsx`, and the launch-on-login row there and in
 * `AutostartRow.test.tsx`.
 *
 * Radix Select is mocked globally via `src/test-setup.ts` (see
 * `src/__tests__/mocks/ui-select.tsx`) — it renders as a native `<select>`,
 * so it's exercised with `getByLabelText` + `userEvent.selectOptions`.
 */

import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'

import { GeneralTab } from '@/components/settings/GeneralTab'
import { i18n, t } from '@/lib/i18n'

const LANGUAGE_KEY = 'agaric-language'

afterEach(async () => {
  await act(async () => {
    await i18n.changeLanguage('en')
  })
  localStorage.clear()
})

describe('GeneralTab', () => {
  it('renders language, week start, and journal date format, in that order', () => {
    render(<GeneralTab />)

    const ids = screen.getAllByRole('combobox').map((select) => select.id)
    expect(ids).toEqual(['language-select', 'week-start-select', 'journal-date-format-select'])
  })

  it('has no a11y violations', async () => {
    const { container } = render(<GeneralTab />)
    expect(await axe(container)).toHaveNoViolations()
  })
})

// #4555 — the language control. Asserted through the RE-QUERIED effect (the
// strings the tab actually renders, and `documentElement.lang`), not through
// the call shape of a setter.
describe('GeneralTab — language', () => {
  it('defaults to English, not to the device', () => {
    render(<GeneralTab />)
    // Phase 1 ships one substantially-translated locale. Following the device
    // would put a Spanish-OS user into a ~99% English UI announced as Spanish
    // — see the `agaric-language` preference for the full argument, and flip
    // both together when a second catalog is real.
    expect(screen.getByLabelText(t('settings.languageLabel'))).toHaveValue('en')
  })

  it('offers exactly system/en/es', () => {
    render(<GeneralTab />)
    const select = screen.getByLabelText(t('settings.languageLabel')) as HTMLSelectElement
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['system', 'en', 'es'])
  })

  it('reflects a stored preference on mount', () => {
    localStorage.setItem(LANGUAGE_KEY, 'en')
    render(<GeneralTab />)
    expect(screen.getByLabelText(t('settings.languageLabel'))).toHaveValue('en')
  })

  it('choosing Español persists it and re-renders the tab in Spanish', async () => {
    const user = userEvent.setup()
    render(<GeneralTab />)

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
    expect(screen.getByLabelText('Week starts on')).toBeInTheDocument()
  })

  it('switching back to English restores the English labels', async () => {
    const user = userEvent.setup()
    render(<GeneralTab />)
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
    const { container } = render(<GeneralTab />)
    await waitFor(() => {
      expect(screen.getByLabelText('Idioma')).toBeInTheDocument()
    })
    expect(await axe(container)).toHaveNoViolations()
  })
})
