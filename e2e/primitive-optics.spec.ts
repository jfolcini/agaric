/**
 * E2E — how the shared primitives look on a dark desktop (#7155): a disabled
 * primary button is the primary, dimmed, not a secondary; a button or badge
 * that starts with an icon pulls the icon into its start padding, whose box
 * carries whitespace beside the glyph; a menu's shortcut hints are muted text,
 * not keycaps. Computed styles and boxes, which the vitest DOM does not have.
 */

import type { Locator, Page } from '@playwright/test'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import {
  activeMenu,
  emitMockEvent,
  expect,
  focusBlockById,
  navigateToView,
  openPage,
  replaceEditorText,
  saveBlock,
  test,
  waitForBoot,
} from './helpers'

/** The colour a probe element with `className` computes to `property`. */
function tokenColor(page: Page, className: string, property: 'backgroundColor' | 'color') {
  return page.evaluate(
    ({ cls, prop }) => {
      const probe = document.createElement('div')
      probe.className = cls
      document.body.append(probe)
      const value = getComputedStyle(probe)[prop]
      probe.remove()
      return value
    },
    { cls: className, prop: property },
  )
}

/** How far the leading icon's box starts inside `el`'s padding box, against its start padding. */
function leadingIconInset(el: Locator) {
  return el.evaluate((node) => {
    const icon = node.querySelector(':scope > svg:first-child')
    if (icon === null) throw new Error('no leading icon')
    return {
      inset: Math.round(icon.getBoundingClientRect().left - node.getBoundingClientRect().left),
      padding: Math.round(parseFloat(getComputedStyle(node).paddingLeft)),
      border: Math.round(parseFloat(getComputedStyle(node).borderLeftWidth)),
    }
  })
}

test.describe('Shared primitives on a dark desktop @pages @editor', () => {
  test.use({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })

  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await waitForBoot(page)
  })

  test("a disabled primary keeps the primary's fill, dimmed", async ({ page }) => {
    await emitMockEvent(page, 'deeplink:capture', { kind: 'prefill', text: '' })
    const capture = page
      .getByTestId('quick-capture-dialog')
      .getByRole('button', { name: 'Capture', exact: true })
    await expect(capture).toBeDisabled()
    await expect(capture).toHaveCSS(
      'background-color',
      await tokenColor(page, 'bg-primary', 'backgroundColor'),
    )
    await expect(capture).toHaveCSS('opacity', '0.5')
  })

  test('a button and a badge that start with an icon pull it into their start padding; an icon alone stays centred', async ({
    page,
  }) => {
    await navigateToView(page, 'Pages')
    const addFilter = page.getByRole('button', { name: 'Add filter', exact: true })
    const button = await leadingIconInset(addFilter)
    expect(button.inset).toBe(button.border + button.padding - 2)
    // An icon alone is no leading icon: it stays centred.
    const iconOnly = page.getByRole('button', { name: 'Back', exact: true })
    const offCentre = await iconOnly.evaluate((node) => {
      const b = node.getBoundingClientRect()
      const i = node.querySelector('svg')?.getBoundingClientRect()
      if (i === undefined) throw new Error('no icon')
      return Math.round(i.left - b.left - (b.right - i.right))
    })
    expect(offCentre).toBe(0)

    // An edited block's history row leads with its op badge, "✎ Edit".
    await openPage(page, 'Getting Started')
    await focusBlockById(page, SEED_IDS.BLOCK_GS_1)
    await replaceEditorText(page, 'Edited once')
    await saveBlock(page, 'Escape')
    await focusBlockById(page, SEED_IDS.BLOCK_GS_1)
    await page.keyboard.press('Control+Shift+Y')
    const badge = page
      .getByRole('dialog', { name: 'Block history' })
      .getByTestId('history-type-badge')
      .first()
    await expect(badge).toBeVisible()
    const chip = await leadingIconInset(badge)
    expect(chip.inset).toBe(chip.border + chip.padding - 2)
  })

  test("a menu's shortcut hints are muted text, not keycaps", async ({ page }) => {
    await openPage(page, 'Getting Started')
    await page
      .locator('[data-testid="block-static"]')
      .nth(1)
      .click({ button: 'right', position: { x: 8, y: 8 } })
    const hint = activeMenu(page)
      .getByRole('menuitem', { name: /History/ })
      .locator('kbd')
    await expect(hint).toBeVisible()
    await expect(hint).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(hint).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)')
    await expect(hint).toHaveCSS('color', await tokenColor(page, 'text-muted-foreground', 'color'))
  })
})
