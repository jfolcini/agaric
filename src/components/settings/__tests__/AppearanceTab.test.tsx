/**
 * Tests for AppearanceTab's tooltip-delay (#2851), note-text-size and
 * interface-zoom (#5646) Selects.
 *
 * The theme / font-size / motion controls on this tab are already covered
 * end-to-end via `SettingsView.test.tsx`; this file focuses on the rest plus
 * a standalone a11y audit of the tab.
 *
 * Radix Select is mocked globally via `src/test-setup.ts` (see
 * `src/__tests__/mocks/ui-select.tsx`) — it renders as a native `<select>`,
 * so it's exercised with `getByLabelText` + `userEvent.selectOptions`.
 */

import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'

import { AppearanceTab } from '@/components/settings/AppearanceTab'
import { i18n, t } from '@/lib/i18n'
import { PREFERENCES, readPreference } from '@/lib/preferences'

const KEY = 'agaric-tooltip-delay'

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
  it('labels the select by its row and describes it with the help text', () => {
    render(<AppearanceTab />)
    expect(screen.getByLabelText(t('settings.tooltipDelayLabel'))).toHaveAccessibleDescription(
      t('settings.tooltipDelayHelp'),
    )
  })

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

describe('AppearanceTab — note text size and interface zoom (#5646)', () => {
  const ZOOM_KEY = 'agaric-interface-zoom'

  it('says the text size is for notes only', () => {
    render(<AppearanceTab />)
    expect(screen.getByLabelText(t('settings.fontSizeLabel'))).toHaveAccessibleDescription(
      t('settings.fontSizeHelp'),
    )
  })

  it('offers the zoom levels as percentages, 100% by default', () => {
    render(<AppearanceTab />)
    const select = screen.getByLabelText(t('settings.zoomLabel')) as HTMLSelectElement
    expect(select).toHaveAccessibleDescription(t('settings.zoomHelp'))
    expect(select).toHaveValue('1')
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      '50%',
      '67%',
      '75%',
      '80%',
      '90%',
      '100%',
      '110%',
      '125%',
      '150%',
      '175%',
      '200%',
      '250%',
    ])
  })

  it('reflects a level the shortcuts stored', () => {
    localStorage.setItem(ZOOM_KEY, '1.5')
    render(<AppearanceTab />)
    expect(screen.getByLabelText(t('settings.zoomLabel'))).toHaveValue('1.5')
  })

  it('saves the chosen level for the device', async () => {
    const user = userEvent.setup()
    render(<AppearanceTab />)

    await user.selectOptions(screen.getByLabelText(t('settings.zoomLabel')), '1.25')

    expect(readPreference(PREFERENCES.interfaceZoom)).toBe(1.25)
    expect(screen.getByLabelText(t('settings.zoomLabel'))).toHaveValue('1.25')
  })

  it('hides the zoom on a phone, which follows the system font size', () => {
    const originalUA = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      get: () => 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0',
    })
    try {
      render(<AppearanceTab />)
      expect(screen.getByLabelText(t('settings.fontSizeLabel'))).toBeInTheDocument()
      expect(screen.queryByLabelText(t('settings.zoomLabel'))).not.toBeInTheDocument()
    } finally {
      Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => originalUA })
    }
  })
})
