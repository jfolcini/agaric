/**
 * Interaction states (#7040, C5): every focusable control draws the one
 * keyboard ring, `focus-ring-visible` (opaque `--ring`, 3 px, 3:1 or more),
 * uncut by the box around it, and a selected block row is highlighted as a
 * whole, like the editing box and the cursor ring.
 *
 * The ring is read from the computed `box-shadow`: its `0 0 0 3px` layer, the
 * colour's alpha and the browser's own outline. A control left on the
 * browser's outline draws a thin ring of the engine's choosing, black or white
 * here and another on WebKit; one with a translucent ring all but loses it.
 *
 * Seed (`src/lib/tauri-mock/seed.ts`): the tags `work` and `personal`, the
 * "Meeting Notes Template" page template, "Getting Started" referenced from
 * "Quick Notes", and the "Projects" tasks with priority and date chips, one
 * due today (on the journal's Due panel, under its "→ Projects" breadcrumb).
 */
import type { Locator, Page } from '@playwright/test'

import { activeAlertDialog, expect, navigateToView, openPage, test, waitForBoot } from './helpers'

interface Ring {
  focusVisible: boolean
  /** The widest `0 0 0 Npx` layer's spread, 0 for none. */
  width: number
  /** That layer's colour alpha. */
  alpha: number
  /** The browser's own outline, which `focus-ring-visible` hides. */
  outline: string
}

async function ringOf(target: Locator): Promise<Ring> {
  return target.evaluate((el) => {
    const style = getComputedStyle(el)
    const alphaOf = (color: string): number => {
      const m = /\/\s*([\d.]+)\)$/.exec(color) ?? /rgba\([^)]*,\s*([\d.]+)\)$/.exec(color)
      return m ? Number(m[1]) : 1
    }
    let width = 0
    let alpha = 0
    for (const layer of style.boxShadow.split(/,(?![^(]*\))/)) {
      const m = /^(.*\))\s+0px 0px 0px ([\d.]+)px/.exec(layer.trim())
      if (m && Number(m[2]) > width) {
        width = Number(m[2])
        alpha = alphaOf(m[1] as string)
      }
    }
    return {
      focusVisible: el.matches(':focus-visible'),
      width,
      alpha,
      outline: style.outlineStyle,
    }
  })
}

/** Genuine keyboard focus: `:focus-visible` is a modality, not a state. */
async function tabTo(page: Page, target: Locator): Promise<void> {
  for (let i = 0; i < 120; i++) {
    await page.keyboard.press('Tab')
    if (await target.evaluate((el) => el === document.activeElement)) return
  }
  throw new Error('Tab never reached the target')
}

async function expectTheRing(target: Locator): Promise<void> {
  await expect
    .poll(() => ringOf(target))
    .toEqual({
      focusVisible: true,
      width: 3,
      alpha: 1,
      outline: 'none',
    })
}

test.describe('Interaction states: one keyboard ring, whole-row selection @pages @editor', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await waitForBoot(page)
  })

  test('a destructive button keeps the opaque ring', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await page.getByRole('button', { name: 'Page actions' }).click()
    await page.getByRole('menuitem', { name: 'Delete page' }).click()
    const confirm = activeAlertDialog(page).getByRole('button', { name: 'Delete page' })
    await expect(confirm).toBeVisible()
    await tabTo(page, confirm)
    await expectTheRing(confirm)
  })

  test('an invalid field keeps the opaque ring @search', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await page.keyboard.down('Control')
    await page.keyboard.press('f')
    await page.keyboard.up('Control')
    const find = page.getByRole('toolbar', { name: /find/i })
    await find.getByRole('button', { name: 'Regex', exact: true }).click()
    const input = find.getByRole('textbox', { name: 'Find in page' })
    await input.fill('(')
    await expect(input).toHaveAttribute('aria-invalid', 'true')
    await tabTo(page, input)
    await expectTheRing(input)
  })

  test('the skip link and the page title draw the ring', async ({ page }) => {
    const skip = page.getByRole('link', { name: 'Skip to main content' })
    await tabTo(page, skip)
    await expectTheRing(skip)

    await openPage(page, 'Getting Started')
    const title = page.getByRole('textbox', { name: 'Page title' })
    await tabTo(page, title)
    await expectTheRing(title)
  })

  test('the Tags list, the Templates list and the references rows draw the ring', async ({
    page,
  }) => {
    await navigateToView(page, 'Tags')
    const tag = page.getByTestId('tag-item-work')
    await tabTo(page, tag)
    await expectTheRing(tag)

    await navigateToView(page, 'Templates')
    const template = page.getByRole('button', { name: /^Open template Meeting Notes/ })
    await tabTo(page, template)
    await expectTheRing(template)

    await openPage(page, 'Getting Started')
    const reference = page.locator('.linked-reference-item').first()
    await tabTo(page, reference)
    await expectTheRing(reference)
  })

  test('the search results take the list cursor, and the list box no outline @search', async ({
    page,
  }) => {
    await navigateToView(page, 'Search')
    const input = page.getByPlaceholder('Search blocks...')
    await input.fill('Review')
    await input.press('Enter')
    const listbox = page.getByTestId('search-result-region').getByRole('listbox').first()
    await expect(listbox.getByRole('option')).toHaveCount(2)
    await tabTo(page, listbox)
    await listbox.press('ArrowDown')
    const cursor = listbox.locator('[role="option"][aria-selected="true"]')
    await expect(cursor).toHaveCount(1)
    // The list family's cursor: the 2 px bar and the inset 2 px ring.
    await expect
      .poll(() =>
        cursor.evaluate((el) => ({
          bar: getComputedStyle(el, '::before').width,
          ring: /0px 0px 0px 2px inset/.test(getComputedStyle(el).boxShadow),
        })),
      )
      .toEqual({ bar: '2px', ring: true })
    await expect(listbox).toHaveCSS('outline-style', 'none')
  })

  test('a breadcrumb link in a task row shows its whole ring @journal', async ({ page }) => {
    await navigateToView(page, 'Journal')
    const link = page
      .getByTestId('due-panel-item')
      .getByRole('link', { name: 'Projects', exact: true })
      .first()
    await tabTo(page, link)
    await expectTheRing(link)
    // Every box that clips its content holds the 3 px ring around the link.
    const cut = await link.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const ring = { l: r.left - 3, t: r.top - 3, r: r.right + 3, b: r.bottom + 3 }
      // clientWidth and clientHeight round to whole pixels, so a box whose text
      // ends on a fraction can read up to half a pixel short.
      const rounding = 0.5
      const clippers: string[] = []
      for (let box = el.parentElement; box; box = box.parentElement) {
        const s = getComputedStyle(box)
        if (s.overflowX === 'visible' && s.overflowY === 'visible') continue
        const b = box.getBoundingClientRect()
        const l = b.left + box.clientLeft
        const t = b.top + box.clientTop
        if (
          ring.l < l ||
          ring.t < t ||
          ring.r > l + box.clientWidth + rounding ||
          ring.b > t + box.clientHeight + rounding
        )
          clippers.push(box.className.toString().slice(0, 60))
      }
      return clippers
    })
    expect(cut).toEqual([])
  })

  test('a selected task row is highlighted with its checkbox and chips', async ({ page }) => {
    await openPage(page, 'Projects')
    const rows = page.getByTestId('sortable-block')
    for (const i of [0, 1]) {
      await rows
        .nth(i)
        .getByTestId('block-static')
        .click({ modifiers: ['Control'], position: { x: 6, y: 6 } })
    }
    const row = rows.nth(1)
    const highlight = row.locator('.block-selected')
    await expect(highlight).toHaveCount(1)
    const box = await highlight.boundingBox()
    for (const part of [
      row.locator('[data-testid^="task-checkbox"]'),
      row.getByTestId('block-metadata-row'),
    ]) {
      const p = await part.boundingBox()
      expect(box, 'highlight').not.toBeNull()
      expect(p, 'part').not.toBeNull()
      if (box === null || p === null) return
      expect(p.x).toBeGreaterThanOrEqual(box.x)
      expect(p.y).toBeGreaterThanOrEqual(box.y)
      expect(p.x + p.width).toBeLessThanOrEqual(box.x + box.width)
      expect(p.y + p.height).toBeLessThanOrEqual(box.y + box.height)
    }
  })
})
