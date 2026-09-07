/**
 * The language switch, end to end (#4555).
 *
 * The unit suites prove the pieces; this proves the one thing they cannot:
 * that the Spanish catalog is really DELIVERABLE from a production build.
 * vitest resolves `@/lib/i18n/es` straight from source, so a chunk that a
 * real build emits but the runtime cannot fetch is green everywhere else
 * and red only here — verified by deleting `dist/assets/es-*.js` and
 * watching both tests below fail on the Spanish label never appearing.
 * (It does NOT pin the code-splitting itself: a static import would render
 * Spanish just as well. The chunk boundary is a bundle-size claim, and the
 * bundle-size gate is where it belongs.)
 *
 * Asserted through re-queried, durable effect: the strings on screen after
 * navigating away and back, plus `<html lang>` — never the call shape.
 */

import type { Page } from '@playwright/test'

import { expect, navigateToView, test, waitForBoot } from './helpers'

/** Open Settings → Appearance from the shell. */
async function openAppearance(page: Page): Promise<void> {
  await navigateToView(page, 'Settings')
  await page.getByRole('tab', { name: 'Appearance' }).click()
  await expect(page.locator('[data-testid="settings-panel-appearance"]')).toBeVisible()
}

test.describe('Language preference', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('switching to Español survives a navigation round trip', async ({ page }) => {
    await openAppearance(page)

    // Ships English, with `<html lang>` following i18next rather than the
    // build-time literal `index.html` used to hardcode.
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    const languageSelect = page.getByRole('combobox', { name: 'Language' })
    await expect(languageSelect).toBeVisible()

    await languageSelect.click()
    await page.getByRole('option', { name: 'Español', exact: true }).click()

    // The lazily-imported catalog arrived and the control renamed itself —
    // no reload, no remount.
    await expect(page.getByRole('combobox', { name: 'Idioma' })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'es')

    // Navigate away and back. The preference is device-scoped localStorage,
    // so it must still be Spanish on return — and the catalog must not have
    // to be re-fetched for it to render.
    await navigateToView(page, 'Journal')
    await expect(page.locator('[data-testid="settings-panel-appearance"]')).not.toBeVisible()
    await openAppearance(page)

    await expect(page.getByRole('combobox', { name: 'Idioma' })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'es')

    // A key this PR does not translate still renders English. That is the
    // partial-catalog fallback working, not a missing translation bug.
    await expect(page.getByRole('combobox', { name: 'Theme' })).toBeVisible()
  })

  test('switching back to English restores the English labels', async ({ page }) => {
    await openAppearance(page)
    await page.getByRole('combobox', { name: 'Language' }).click()
    await page.getByRole('option', { name: 'Español', exact: true }).click()
    await expect(page.getByRole('combobox', { name: 'Idioma' })).toBeVisible()

    await page.getByRole('combobox', { name: 'Idioma' }).click()
    await page.getByRole('option', { name: 'English', exact: true }).click()

    await expect(page.getByRole('combobox', { name: 'Language' })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  })
})
