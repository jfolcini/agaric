/**
 * The language switch, end to end (#4555).
 *
 * The unit suites prove the pieces; this proves the one thing they cannot:
 * that each locale's catalog is really DELIVERABLE from a production build.
 * vitest resolves `@/lib/i18n/es` straight from source, so a chunk that a
 * real build emits but the runtime cannot fetch is green everywhere else
 * and red only here — verified by deleting `dist/assets/es-*.js` and
 * watching the Spanish tests below fail on the Spanish label never appearing.
 * (It does NOT pin the code-splitting itself: a static import would render
 * Spanish just as well. The chunk boundary is a bundle-size claim, and the
 * bundle-size gate is where it belongs.)
 *
 * Asserted through re-queried, durable effect: the strings on screen after
 * navigating away and back, plus `<html lang>` — never the call shape.
 */

import type { Page } from '@playwright/test'

import { expect, navigateToView, test, waitForBoot } from './helpers'

/**
 * The labels this spec navigates by, per language: the option that picks it,
 * and the shell strings that prove its catalog rendered.
 */
const LABELS = {
  en: {
    option: 'English',
    settings: 'Settings',
    general: 'General',
    journal: 'Journal',
    language: 'Language',
    weekStart: 'Week starts on',
  },
  es: {
    option: 'Español',
    settings: 'Configuración',
    general: 'General',
    journal: 'Diario',
    language: 'Idioma',
    weekStart: 'La semana empieza el',
  },
  pt: {
    option: 'Português',
    settings: 'Configurações',
    general: 'Geral',
    journal: 'Diário',
    language: 'Idioma',
    weekStart: 'A semana começa em',
  },
  de: {
    option: 'Deutsch',
    settings: 'Einstellungen',
    general: 'Allgemein',
    journal: 'Journal',
    language: 'Sprache',
    weekStart: 'Woche beginnt am',
  },
  fr: {
    option: 'Français',
    settings: 'Paramètres',
    general: 'Général',
    journal: 'Journal',
    language: 'Langue',
    weekStart: 'Premier jour de la semaine',
  },
} as const

/** Open Settings → General, where the language control lives, from the shell. */
async function openGeneral(page: Page, labels: (typeof LABELS)[keyof typeof LABELS]) {
  await navigateToView(page, labels.settings)
  await page.getByRole('tab', { name: labels.general, exact: true }).click()
  await expect(page.locator('[data-testid="settings-panel-general"]')).toBeVisible()
}

async function pickLanguage(page: Page, current: string, option: string): Promise<void> {
  await page.getByRole('combobox', { name: current }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
}

test.describe('Language preference @settings', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('switching to Español survives a navigation round trip', async ({ page }) => {
    await openGeneral(page, LABELS.en)

    // A browser set to English follows it, with `<html lang>` following
    // i18next rather than the build-time literal `index.html` hardcodes.
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')

    await pickLanguage(page, LABELS.en.language, LABELS.es.option)

    // The lazily-imported catalog arrived and the tab re-rendered in Spanish —
    // no reload, no remount.
    await expect(page.getByRole('combobox', { name: LABELS.es.weekStart })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'es')

    // Navigate away and back, through the Spanish shell. The preference is
    // device-scoped localStorage, so it must still be Spanish on return.
    await navigateToView(page, LABELS.es.journal)
    await expect(page.locator('[data-testid="settings-panel-general"]')).not.toBeVisible()
    await openGeneral(page, LABELS.es)

    await expect(page.getByRole('combobox', { name: LABELS.es.language })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'es')
  })

  for (const tag of ['pt', 'de', 'fr'] as const) {
    const labels = LABELS[tag]
    test(`switching to ${labels.option} renders the shell in it`, async ({ page }) => {
      await openGeneral(page, LABELS.en)
      await pickLanguage(page, LABELS.en.language, labels.option)

      await expect(page.getByRole('combobox', { name: labels.weekStart })).toBeVisible()
      await expect(page.locator('html')).toHaveAttribute('lang', tag)

      await navigateToView(page, labels.journal)
      await expect(page.locator('[data-testid="settings-panel-general"]')).not.toBeVisible()
      await openGeneral(page, labels)
      await expect(page.getByRole('combobox', { name: labels.language })).toBeVisible()
    })
  }

  test('switching back to English restores the English labels', async ({ page }) => {
    await openGeneral(page, LABELS.en)
    await pickLanguage(page, LABELS.en.language, LABELS.es.option)
    await expect(page.getByRole('combobox', { name: LABELS.es.language })).toBeVisible()

    await pickLanguage(page, LABELS.es.language, LABELS.en.option)

    await expect(page.getByRole('combobox', { name: LABELS.en.language })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  })
})
