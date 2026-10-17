/**
 * Settings › Appearance: theme, animations and tooltip delay take effect on
 * the live app and survive leaving Settings (#5741). Also the command
 * palette's "Toggle theme" entry.
 *
 * Every one of these is a localStorage preference applied in the browser
 * (classes and attributes on `<html>`, the app-level `TooltipProvider`), so
 * the mock-backed build shows the whole effect.
 */

import type { Page } from '@playwright/test'

import {
  chooseSelectOption,
  expect,
  navigateToView,
  openSettingsTab,
  test,
  waitForBoot,
} from './helpers'

// The whole class token: the palette themes add `theme-*-dark` alongside it.
const DARK_CLASS = /(^|\s)dark(\s|$)/

async function openAppearance(page: Page): Promise<void> {
  await navigateToView(page, 'Settings')
  await openSettingsTab(page, 'Appearance')
  await expect(page.getByTestId('settings-panel-appearance')).toBeVisible()
}

function bodyBackground(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.body).backgroundColor)
}

test.describe('Settings › Appearance', () => {
  test.beforeEach(async ({ page }) => {
    // `auto` resolves to light, so picking Dark is a visible change.
    await page.emulateMedia({ colorScheme: 'light' })
    await waitForBoot(page)
  })

  test('Dark applies to the app and is kept after leaving Settings', async ({ page }) => {
    const html = page.locator('html')
    await expect(html).not.toHaveClass(DARK_CLASS)
    const lightBackground = await bodyBackground(page)

    await openAppearance(page)
    await chooseSelectOption(page, 'Theme', 'Dark')
    await expect(html).toHaveClass(DARK_CLASS)
    await expect.poll(() => bodyBackground(page)).not.toBe(lightBackground)

    await navigateToView(page, 'Journal')
    await openAppearance(page)
    await expect(page.getByRole('combobox', { name: 'Theme' })).toHaveText('Dark')
    await expect(html).toHaveClass(DARK_CLASS)
  })

  test('the palette Toggle theme entry flips Dark to Light', async ({ page }) => {
    const html = page.locator('html')
    const lightBackground = await bodyBackground(page)
    await openAppearance(page)
    await chooseSelectOption(page, 'Theme', 'Dark')
    await expect(html).toHaveClass(DARK_CLASS)

    await page.getByTestId('header-search-button').click()
    await page.getByTestId('command-palette-input').fill('>Toggle theme')
    await page.getByRole('option', { name: 'Toggle theme' }).click()

    await expect(html).not.toHaveClass(DARK_CLASS)
    await expect.poll(() => bodyBackground(page)).toBe(lightBackground)
    await navigateToView(page, 'Journal')
    await openAppearance(page)
    await expect(page.getByRole('combobox', { name: 'Theme' })).toHaveText('Light')
  })

  test('Animations Off marks the root and stops transitions, and is kept', async ({ page }) => {
    const html = page.locator('html')
    const searchButton = page.getByTestId('header-search-button')
    await expect(html).not.toHaveAttribute('data-motion', 'off')
    await expect(searchButton).not.toHaveCSS('transition-property', 'none')

    await openAppearance(page)
    await chooseSelectOption(page, 'Animations', 'Off')
    await expect(html).toHaveAttribute('data-motion', 'off')

    await navigateToView(page, 'Journal')
    await expect(html).toHaveAttribute('data-motion', 'off')
    await expect(searchButton).toHaveCSS('transition-property', 'none')

    // The Settings control applies the choice itself, so only a launch that
    // reopens on the journal shows the app shell applying the stored choice.
    const relaunched = await page.context().newPage()
    await waitForBoot(relaunched)
    await expect(relaunched.locator('html')).toHaveAttribute('data-motion', 'off')

    await openAppearance(page)
    await expect(page.getByRole('combobox', { name: 'Animations' })).toHaveText('Off')
  })

  test('Tooltip delay Fast opens a tooltip after 150 ms, not before', async ({ page }) => {
    await page.clock.install()
    await openAppearance(page)
    await chooseSelectOption(page, 'Tooltip delay', 'Fast')
    await navigateToView(page, 'Journal')

    // Park the pointer off any tooltip trigger, then freeze time past Radix's
    // skip-delay window, so the next hover waits for the full delay.
    await page.getByRole('heading', { level: 1 }).hover()
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000)

    await page.getByTestId('header-search-button').hover()
    const tooltip = page.getByRole('tooltip')
    await page.clock.runFor(100)
    await expect(tooltip).toHaveCount(0)
    // Past 150 ms, still short of the 300 ms default.
    await page.clock.runFor(100)
    await expect(tooltip).toContainText('Find in page')
  })
})
