/**
 * Interaction states (#7040, C5): every focusable control draws the one
 * keyboard ring, `focus-ring-visible` (opaque `--ring`, 3 px, 3:1 or more),
 * uncut by the box around it.
 *
 * The ring is read from the computed outline: solid, 3 px, opaque, 2 px off
 * the control (a transparent gap, so an ink ring stays apart from an ink fill)
 * or 3 px inside it where a scroll container would clip it. A control left on
 * the browser's own outline draws a thin ring of the engine's choosing; one
 * with a translucent ring all but loses it.
 *
 * Seed (`src/lib/tauri-mock/seed.ts`): the tags `work` and `personal`, the
 * "Meeting Notes Template" page template, "Getting Started" referenced from
 * "Quick Notes", and the "Projects" tasks with priority and date chips, one
 * due today (on the journal's Due panel, under its "→ Projects" breadcrumb).
 */
import { devices, type Locator, type Page } from '@playwright/test'

import {
  activeAlertDialog,
  expect,
  navigateMobile,
  navigateToView,
  openPage,
  test,
  waitForBoot,
} from './helpers'

interface Ring {
  focusVisible: boolean
  style: string
  width: number
  offset: number
  /** The outline colour's alpha. */
  alpha: number
}

async function ringOf(target: Locator): Promise<Ring> {
  return target.evaluate((el) => {
    const style = getComputedStyle(el)
    const alpha =
      /\/\s*([\d.]+)\)$/.exec(style.outlineColor) ??
      /rgba\([^)]*,\s*([\d.]+)\)$/.exec(style.outlineColor)
    return {
      focusVisible: el.matches(':focus-visible'),
      style: style.outlineStyle,
      width: Number.parseFloat(style.outlineWidth),
      offset: Number.parseFloat(style.outlineOffset),
      alpha: alpha ? Number(alpha[1]) : 1,
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

/** The ring 2 px off the control, or 3 px inside it (`offset: -3`). */
async function expectTheRing(target: Locator, offset = 2): Promise<void> {
  await expect
    .poll(() => ringOf(target))
    .toEqual({ focusVisible: true, style: 'solid', width: 3, offset, alpha: 1 })
}

test.describe('Interaction states: one keyboard ring @pages @editor', () => {
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
    // A row of a scrolling list: the ring sits inside it.
    await expectTheRing(reference, -3)
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
    // Every box that clips its content holds the ring: a 2 px gap and 3 px of outline.
    const cut = await link.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const reach = 5
      const ring = { l: r.left - reach, t: r.top - reach, r: r.right + reach, b: r.bottom + reach }
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
})

const pixel = devices['Pixel 7']

test.describe('Focus rings on a bare phone @mobile @pages', () => {
  test.use({
    viewport: pixel.viewport,
    hasTouch: pixel.hasTouch,
    isMobile: pixel.isMobile,
    deviceScaleFactor: pixel.deviceScaleFactor,
    userAgent: pixel.userAgent,
  })

  test('a tapped field shows its border, not the ring, until a hardware key is pressed', async ({
    page,
  }) => {
    // Android's WebView has no Keyboard Map API; desktop Chromium's reports the host's keyboard.
    await page.addInitScript(() => Reflect.deleteProperty(Navigator.prototype, 'keyboard'))
    await waitForBoot(page)
    await navigateMobile(page, 'Pages')
    const field = page.getByPlaceholder('Search pages...')
    await field.tap()
    await expect(field).toBeFocused()
    expect(await ringOf(field)).toMatchObject({ focusVisible: true, style: 'none' })
    const borderIsRing = () =>
      field.evaluate((el) => {
        const probe = document.createElement('div')
        probe.style.color = 'var(--ring)'
        document.body.append(probe)
        const ring = getComputedStyle(probe).color
        probe.remove()
        return getComputedStyle(el).borderTopColor === ring
      })
    expect(await borderIsRing()).toBe(true)

    await page.keyboard.press('a')
    await expectTheRing(field)
  })
})
