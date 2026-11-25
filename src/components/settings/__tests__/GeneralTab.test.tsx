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
import { PREFERENCES, writePreference } from '@/lib/preferences'

const LANGUAGE_KEY = 'agaric-language'

afterEach(async () => {
  await act(async () => {
    await i18n.changeLanguage('en')
  })
  localStorage.clear()
})

describe('GeneralTab', () => {
  it('renders language, week start, journal date format and journal template, in that order', () => {
    render(<GeneralTab />)

    const ids = screen.getAllByRole('combobox').map((select) => select.id)
    expect(ids).toEqual([
      'language-select',
      'week-start-select',
      'journal-date-format-select',
      'journal-template-select',
    ])
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
  it('defaults to following the device', () => {
    render(<GeneralTab />)
    // Every shipped catalog is complete (`locale-catalogs.test.ts`), so a
    // Spanish-OS user who never opens Settings gets a Spanish UI.
    expect(screen.getByLabelText(t('settings.languageLabel'))).toHaveValue('system')
  })

  it('offers system plus every shipped locale, each named in its own language', () => {
    render(<GeneralTab />)
    const select = screen.getByLabelText(t('settings.languageLabel')) as HTMLSelectElement
    expect(Array.from(select.options).map((o) => [o.value, o.lang, o.text])).toEqual([
      ['system', '', t('settings.languageSystem')],
      ['de', 'de', 'Deutsch'],
      ['en', 'en', 'English'],
      ['es', 'es', 'Español'],
      ['fr', 'fr', 'Français'],
      ['pt', 'pt', 'Português'],
    ])
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
    expect(screen.getByLabelText('La semana empieza el')).toBeInTheDocument()
  })

  it('choosing Português persists it and re-renders the tab in Portuguese', async () => {
    const user = userEvent.setup()
    render(<GeneralTab />)

    await user.selectOptions(screen.getByLabelText(t('settings.languageLabel')), 'pt')

    expect(localStorage.getItem(LANGUAGE_KEY)).toBe('pt')
    await waitFor(() => {
      expect(screen.getByLabelText('A semana começa em')).toBeInTheDocument()
    })
    expect(document.documentElement.lang).toBe('pt')
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

// The pseudo-locale is a layout check, not a language: the options test above
// pins that it is absent while debug mode is off.
describe('GeneralTab — pseudo-locale', () => {
  const PSEUDO_LABEL = '⟦Ĺáñğúáğé ~ ~⟧'

  it('is offered in debug mode', () => {
    writePreference(PREFERENCES.debugMode, true)
    render(<GeneralTab />)
    const select = screen.getByLabelText(t('settings.languageLabel')) as HTMLSelectElement
    const option = Array.from(select.options).find((o) => o.value === 'en-XA')
    expect([option?.lang, option?.text]).toEqual(['en-XA', 'Pseudo-locale (en-XA)'])
  })

  it('choosing it persists it and re-renders the tab accented, padded and in markers', async () => {
    writePreference(PREFERENCES.debugMode, true)
    const user = userEvent.setup()
    render(<GeneralTab />)

    await user.selectOptions(screen.getByLabelText(t('settings.languageLabel')), 'en-XA')

    expect(localStorage.getItem(LANGUAGE_KEY)).toBe('en-XA')
    await waitFor(() => {
      expect(screen.getByLabelText(PSEUDO_LABEL)).toBeInTheDocument()
    })
    expect(document.documentElement.lang).toBe('en-XA')
  })

  it('stays selectable while it is the stored choice, after debug mode is off', async () => {
    localStorage.setItem(LANGUAGE_KEY, 'en-XA')
    render(<GeneralTab />)
    await waitFor(() => {
      expect(screen.getByLabelText(PSEUDO_LABEL)).toHaveValue('en-XA')
    })
  })
})
