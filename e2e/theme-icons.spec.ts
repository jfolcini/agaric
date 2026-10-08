/**
 * #5368 — the alternate themes paint sidebar nav and ghost / outline button
 * icons with their palette `--icon`; Light and Dark keep ink icons, the
 * row's own text color. Each theme also attaches screenshots of the journal
 * (with the sidebar) and of a page header for review.
 */

import type { Locator } from '@playwright/test'

import { expect, openPage, test, waitForBoot } from './helpers'

const INK_THEMES = ['light', 'dark'] as const
const PALETTE_THEMES = ['solarized-light', 'solarized-dark', 'dracula', 'one-dark-pro'] as const

/** The computed color of a control's icon, its label, and `var(--icon)` itself. */
function iconColors(control: Locator) {
  return control.evaluate((el) => {
    const probe = document.createElement('span')
    probe.style.color = 'var(--icon)'
    document.body.append(probe)
    const token = getComputedStyle(probe).color
    probe.remove()
    const color = (node: Element | null) => (node ? getComputedStyle(node).color : 'missing')
    return { icon: color(el.querySelector(':scope > svg')), label: color(el), token }
  })
}

for (const theme of [...INK_THEMES, ...PALETTE_THEMES]) {
  test.describe(`icon colors (${theme})`, () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test.beforeEach(async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem('theme-preference', t), theme)
      await waitForBoot(page)
    })

    test('sidebar nav and ghost button icon colors, with journal and page header screenshots', async ({
      page,
    }, testInfo) => {
      const controls = {
        'sidebar nav row': page
          .locator('[data-slot="sidebar"]')
          .getByRole('button', { name: 'Pages', exact: true }),
        // A ghost Button whose className sets only a text size keeps the tint.
        'journal date button': page.locator('button:has([data-testid="date-display"])'),
      }
      for (const [control, locator] of Object.entries(controls)) {
        const { icon, label, token } = await iconColors(locator)
        if ((INK_THEMES as readonly string[]).includes(theme)) {
          expect(icon, `${control}: ink icon matches its label`).toBe(label)
        } else {
          expect(icon, `${control}: palette icon is --icon`).toBe(token)
          expect(icon, `${control}: palette icon differs from its label`).not.toBe(label)
        }
      }

      await testInfo.attach(`${theme}-journal`, {
        body: await page.screenshot(),
        contentType: 'image/png',
      })
      await openPage(page, 'Getting Started')
      await testInfo.attach(`${theme}-page-header`, {
        body: await page.screenshot(),
        contentType: 'image/png',
      })
    })
  })
}
