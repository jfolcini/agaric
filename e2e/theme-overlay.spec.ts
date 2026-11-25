/**
 * Overlays and the disabled primary button in each theme. Dark themes dim the
 * page behind a dialog or sheet with a 65% black scrim and show a disabled
 * primary on the muted surface with muted text; light themes keep the 20%
 * scrim and the half-opacity primary. The pairing dialog's Pair button,
 * disabled until a passphrase is typed, is the sample.
 *
 * Floating surfaces in dark (#7040): a Select's list is lighter than the card
 * it opens over, and a tooltip stays inverted (the text colour as its fill), as
 * in light. Month draws today in ink, not the brand red the capture button wears.
 */

import { devices, type Locator, type Page } from '@playwright/test'

import {
  activeDialog,
  activeSheet,
  expect,
  navigateMobile,
  navigateToView,
  openSettingsTab,
  test,
  waitForBoot,
} from './helpers'

const LIGHT_THEMES = ['light', 'solarized-light'] as const
const DARK_THEMES = ['dark', 'solarized-dark', 'dracula', 'one-dark-pro'] as const
const LIGHT_SCRIM = 'oklab(0 0 0 / 0.2)'
const DARK_SCRIM = 'oklab(0 0 0 / 0.65)'

/** The computed color a token resolves to in the current theme. */
function tokenColor(page: Page, token: string): Promise<string> {
  return page.evaluate((t) => {
    const probe = document.createElement('span')
    probe.style.color = `var(${t})`
    document.body.append(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  }, token)
}

function paint(loc: Locator) {
  return loc.evaluate((el) => {
    const cs = getComputedStyle(el)
    return { background: cs.backgroundColor, color: cs.color, opacity: cs.opacity }
  })
}

/** Opens pairing on the passphrase entry, where Pair stays disabled until typed. */
async function openDisabledPair(page: Page, surface: Locator): Promise<Locator> {
  await openSettingsTab(page, 'Sync & devices')
  await page.locator('.device-pair-btn').click()
  await surface.getByRole('button', { name: /have a code from the other device/i }).click()
  await surface.getByRole('tab', { name: 'Type passphrase', exact: true }).click()
  const pair = surface.getByRole('button', { name: 'Pair', exact: true })
  await expect(pair).toBeDisabled()
  return pair
}

for (const theme of [...LIGHT_THEMES, ...DARK_THEMES]) {
  const dark = (DARK_THEMES as readonly string[]).includes(theme)

  test.describe(`overlay scrim and disabled primary (${theme}) @settings @sync`, () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test.beforeEach(async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem('theme-preference', t), theme)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await waitForBoot(page)
      await navigateToView(page, 'Settings')
    })

    test('the dialog scrim and a disabled primary take the theme’s style', async ({ page }) => {
      const pair = await openDisabledPair(page, activeDialog(page))
      const overlay = page.locator('[data-slot="dialog-overlay"]').last()
      await expect(overlay).toHaveCSS('background-color', dark ? DARK_SCRIM : LIGHT_SCRIM)

      const look = await paint(pair)
      if (dark) {
        expect(look).toEqual({
          background: await tokenColor(page, '--muted'),
          color: await tokenColor(page, '--muted-foreground'),
          opacity: '1',
        })
      } else {
        expect(look).toEqual({
          background: await tokenColor(page, '--primary'),
          color: await tokenColor(page, '--primary-foreground'),
          opacity: '0.5',
        })
      }
      // Still inert: no hover, no click target.
      await expect(pair).toHaveCSS('pointer-events', 'none')
    })
  })
}

test.describe('phone sheet scrim (dark) @mobile @sync', () => {
  const iPhone13 = devices['iPhone 13']
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: iPhone13.hasTouch,
    isMobile: iPhone13.isMobile,
    userAgent: iPhone13.userAgent,
  })

  test('a bottom sheet dims the page with the dark scrim', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('theme-preference', 'dark'))
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await waitForBoot(page)
    await navigateMobile(page, 'Settings')
    await openDisabledPair(page, activeSheet(page))
    await expect(page.locator('[data-slot="sheet-overlay"]').last()).toHaveCSS(
      'background-color',
      DARK_SCRIM,
    )
  })
})

for (const theme of DARK_THEMES) {
  test(`a Select lifts off the card and a tooltip stays inverted (${theme}) @settings @spaces`, async ({
    page,
  }) => {
    await page.addInitScript((t) => localStorage.setItem('theme-preference', t), theme)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await waitForBoot(page)

    // The space switcher is a Select whose trigger carries a tooltip; Escape
    // returns focus to the trigger, which opens it.
    const switcher = page.getByRole('combobox', { name: 'Switch space', exact: true })
    await switcher.click()
    const list = page.locator('[data-slot="select-content"]').last()
    await expect(list).toBeVisible()
    if (theme === 'dark') {
      expect((await paint(list)).background).not.toBe(await tokenColor(page, '--card'))
    }
    await expect(list).toHaveCSS('background-color', await tokenColor(page, '--popover'))

    await page.keyboard.press('Escape')
    const tooltip = page.locator('[data-slot="tooltip-content"]')
    await expect(tooltip).toBeVisible()
    await expect(tooltip).toHaveCSS('background-color', await tokenColor(page, '--foreground'))
    await expect(tooltip).toHaveCSS('color', await tokenColor(page, '--background'))
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`Month draws today in ink, not the brand red (${theme}) @journal`, async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem('theme-preference', t), theme)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await waitForBoot(page)
    await page.getByRole('tab', { name: 'Monthly view' }).click()

    const today = await page.evaluate(() => {
      const d = new Date()
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    })
    const numeral = page
      .getByRole('grid', { name: 'Monthly calendar' })
      .locator(`[role="gridcell"][data-date="${today}"] > span`)
      .first()
    const ink = await tokenColor(page, '--foreground')
    expect(ink).not.toBe(await tokenColor(page, '--brand'))
    await expect(numeral).toHaveCSS('background-color', ink)
    await expect(numeral).toHaveCSS('color', await tokenColor(page, '--background'))
  })
}
