/**
 * Shortcut labels tell the truth on the platform they run on (#6548).
 * Playwright's Chromium reports Linux, so a label may not carry a Mac
 * modifier glyph, and the Quick Reference must keep each chord alternative
 * on one line without spilling into the Action column.
 */

import {
  activeSheet,
  expect,
  focusBlock,
  openPage,
  test,
  typeSlashCommand,
  waitForBoot,
} from './helpers'

const MAC_MODIFIER_GLYPH = /[⌘⌃⌥⇧]/

test.describe('shortcut labels on Linux @search @settings @editor', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await waitForBoot(page)
  })

  test('the palette chips and footer name Ctrl, with no Mac glyph', async ({ page }) => {
    await page
      .locator('[data-slot="sidebar"]')
      .getByRole('button', { name: 'Pages', exact: true })
      .click()
    await expect(page.getByTestId('header-label')).toHaveText('Pages')
    await page.keyboard.press('Control+k')

    const palette = page.getByTestId('command-palette')
    const chips = palette.locator('[data-testid^="palette-cmd-shortcut-"]')
    // The first open lists the Navigate commands, some with a chord.
    await expect(chips.first()).toBeVisible()
    await expect(chips.first()).toContainText('Ctrl')
    const footer = page.getByTestId('palette-footer-hint')
    await expect(footer).toContainText('Ctrl')
    await expect(palette).not.toContainText(MAC_MODIFIER_GLYPH)

    // Commands mode lists every command's chord.
    await page.keyboard.type('>')
    await expect(palette.getByTestId('palette-commands-action')).toBeVisible()
    await expect(chips.first()).toContainText('Ctrl')
    await expect(palette).not.toContainText(MAC_MODIFIER_GLYPH)
  })

  test('the slash menu chips name Ctrl, with no Mac glyph', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)
    const list = await typeSlashCommand(page, 'strike')

    const chip = list.getByTestId('suggestion-shortcut-strike')
    await expect(chip).toHaveText('Ctrl+Shift+S')
    await expect(list).not.toContainText(MAC_MODIFIER_GLYPH)
  })

  test('the Quick Reference keeps every chord alternative on one line', async ({ page }) => {
    await page.locator('header').first().click()
    await page.keyboard.type('?')
    const sheet = activeSheet(page)
    await expect(sheet.getByTestId('shortcuts-table')).toBeVisible()

    await expect.poll(async () => (await sheet.boundingBox())?.width).toBe(512)
    await expect(sheet.getByRole('columnheader', { name: 'Shortcut', exact: true })).toHaveCount(1)

    // A chord broken across lines, or one wider than its cell, names its cell.
    const offenders = await sheet.evaluate((root) => {
      const found: string[] = []
      for (const cell of Array.from(root.querySelectorAll('td'))) {
        const kbds = Array.from(cell.querySelectorAll('kbd'))
        const cellRight = cell.getBoundingClientRect().right
        kbds.forEach((kbd, i) => {
          if (kbd.getBoundingClientRect().right > cellRight + 1)
            found.push(`wide: ${cell.textContent}`)
          const prev = kbds[i - 1]
          if (prev === undefined) return
          const between = document.createRange()
          between.setStartAfter(prev)
          between.setEndBefore(kbd)
          if (between.toString().includes('/')) return
          const drop = kbd.getBoundingClientRect().top - prev.getBoundingClientRect().top
          if (Math.abs(drop) > 1) found.push(`wrapped: ${cell.textContent}`)
        })
      }
      return found
    })
    expect(offenders).toEqual([])
  })
})
