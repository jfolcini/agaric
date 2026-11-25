/**
 * E2E — on a 390 × 844 phone, overlays rise from the bottom (#5931): the block
 * properties panel, History, Outline, Keyboard shortcuts, New page and the
 * block date picker are bottom sheets, and the block long-press menu and the
 * page ⋮ menu are bottom-sheet lists. Each must sit on the bottom edge and span
 * the width, and a tall one stops at the header. Toasts sit at the bottom too,
 * clear of the header, the floating capture button, the soft keyboard and the
 * field being typed in. The search sheet keeps one close button and a 44 px
 * drag handle (#5930).
 *
 * A sheet's bottom is the viewport's: `SheetContent` anchors at `bottom-0` and
 * Chromium reports no safe-area inset.
 */

import { devices, type Locator, type Page } from '@playwright/test'

import {
  activeMenu,
  activeSheet,
  centerOf,
  emitMockEvent,
  expect,
  focusBlock,
  navigateMobile,
  openPageMobile,
  test,
  touchLongPress,
  waitForBoot,
} from './helpers'

const iPhone13 = devices['iPhone 13']
const PAGE = 'Getting Started'
const TOUCH_FLOOR = 44
/** `--radius-xl`, the modal tier a bottom sheet's free edge takes (docs/UX.md). */
const SHEET_RADIUS = 12

interface Edges {
  left: number
  right: number
  bottom: number
}

/** The edges of the sheet holding `loc` (or of `loc` itself when it has none). */
function sheetEdges(loc: Locator): Promise<Edges> {
  return loc.evaluate((el) => {
    const r = (el.closest('[data-slot="sheet-content"]') ?? el).getBoundingClientRect()
    return { left: Math.round(r.left), right: Math.round(r.right), bottom: Math.round(r.bottom) }
  })
}

async function expectBottomSheet(page: Page, loc: Locator): Promise<void> {
  await expect(loc).toBeVisible()
  const { width, height } = page.viewportSize() ?? { width: 0, height: 0 }
  await expect.poll(() => sheetEdges(loc)).toEqual({ left: 0, right: width, bottom: height })
}

async function openBlockMenu(page: Page): Promise<Locator> {
  await openPageMobile(page, PAGE)
  const id = await page
    .locator('[data-testid="sortable-block"]')
    .first()
    .getAttribute('data-block-id')
  await touchLongPress(page, `[data-testid="block-static"][data-block-id="${id}"]`)
  return activeMenu(page)
}

/** The open sheet rises on a rounded top, from a 44 px grab handle. */
async function expectGrabbable(page: Page): Promise<void> {
  const sheet = activeSheet(page)
  await expect(sheet).toBeVisible()
  const corners = await sheet.evaluate((el) => {
    const s = getComputedStyle(el)
    return [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomLeftRadius]
  })
  expect(corners).toEqual([`${SHEET_RADIUS}px`, `${SHEET_RADIUS}px`, '0px'])
  const handle = await box(sheet.locator('[data-slot="sheet-drag-handle"]'))
  expect(handle.height).toBe(TOUCH_FLOOR)
}

/** Drag from the open sheet's grab handle straight down by `dy`. */
async function pullHandle(page: Page, dy: number): Promise<void> {
  const { x, y } = await centerOf(
    activeSheet(page).locator('[data-slot="sheet-drag-handle"]'),
    'drag handle',
  )
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x, y + dy, { steps: 5 })
  await page.mouse.up()
}

/** `row` takes the `accent` fill while pressed, and not at rest. */
async function expectPressedFill(page: Page, row: Locator, accent: string): Promise<void> {
  const fill = () => row.evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(await fill()).not.toBe(accent)
  const { x, y } = await centerOf(row, 'row')
  await page.mouse.move(x, y)
  await page.mouse.down()
  await expect.poll(fill).toBe(accent)
  await page.mouse.up()
}

/** `--accent`, resolved by the browser to the colour a pressed row should show. */
function accentColor(page: Page): Promise<string> {
  return page.evaluate(() => {
    const probe = document.createElement('div')
    probe.className = 'bg-accent'
    document.body.append(probe)
    const color = getComputedStyle(probe).backgroundColor
    probe.remove()
    return color
  })
}

/** Simulate the soft keyboard: on Android the webview ends at its top (#6790), so the viewport shrinks by `height`. */
async function showKeyboard(page: Page, height: number): Promise<void> {
  const { width, height: full } = page.viewportSize() ?? { width: 0, height: 0 }
  await page.setViewportSize({ width, height: full - height })
}

function overlaps(a: DOMRectLike, b: DOMRectLike): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

interface DOMRectLike {
  x: number
  y: number
  width: number
  height: number
}

async function box(loc: Locator): Promise<DOMRectLike> {
  const b = await loc.boundingBox()
  if (!b) throw new Error('element has no box')
  return b
}

/** On Search, capture a line through Quick Capture; returns the toast that answers it. */
async function toastOnSearch(page: Page): Promise<Locator> {
  await navigateMobile(page, 'Search')
  await emitMockEvent(page, 'deeplink:capture', { kind: 'prefill', text: 'Toast placement' })
  const dialog = page.getByTestId('quick-capture-dialog')
  await dialog.getByRole('button', { name: 'Capture', exact: true }).tap()
  await expect(dialog).toBeHidden()
  const toast = page.locator('[data-sonner-toast]', { hasText: "Captured to today's journal" })
  await expect(toast).toBeVisible()
  return toast
}

test.describe('Phone overlays are bottom sheets (#5931) @mobile @editor @pages @search', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: iPhone13.hasTouch,
    isMobile: iPhone13.isMobile,
    deviceScaleFactor: iPhone13.deviceScaleFactor,
    userAgent: iPhone13.userAgent,
  })

  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await waitForBoot(page)
  })

  test('the block long-press menu is a bottom-sheet list', async ({ page }) => {
    const menu = await openBlockMenu(page)
    await expectBottomSheet(page, menu)
    // Its rows still act: Properties opens the next sheet.
    await menu.getByRole('menuitem', { name: /Properties/ }).tap()
    await expect(page.getByRole('dialog', { name: 'Block properties' })).toBeVisible()
  })

  test('block properties open as a bottom sheet', async ({ page }) => {
    const menu = await openBlockMenu(page)
    await menu.getByRole('menuitem', { name: /Properties/ }).tap()
    await expectBottomSheet(page, page.getByRole('dialog', { name: 'Block properties' }))
  })

  test('block history opens as a bottom sheet', async ({ page }) => {
    const menu = await openBlockMenu(page)
    await menu.getByRole('menuitem', { name: /History/ }).tap()
    await expectBottomSheet(page, page.getByRole('dialog', { name: 'Block history' }))
  })

  test('the page ⋮ menu is a bottom-sheet list, and Outline a bottom sheet', async ({ page }) => {
    await openPageMobile(page, PAGE)
    await page.getByRole('button', { name: 'Page actions' }).tap()
    const menu = page.getByRole('menu', { name: 'Page actions' })
    await expectBottomSheet(page, menu)
    await menu.getByRole('menuitem', { name: 'Open outline' }).tap()
    await expectBottomSheet(page, page.getByRole('dialog', { name: 'Outline' }))
  })

  test('keyboard shortcuts open as a bottom sheet', async ({ page }) => {
    await page.keyboard.type('?')
    await expect(page.getByTestId('shortcuts-table')).toBeVisible()
    await expectBottomSheet(page, activeSheet(page))
  })

  // Keyboard shortcuts overflow the screen, so the sheet runs up to its cap.
  test('a tall sheet docks under the header without covering its contents', async ({ page }) => {
    await page.keyboard.type('?')
    await expect(page.getByTestId('shortcuts-table')).toBeVisible()
    const edges = await activeSheet(page).evaluate((sheet) => {
      const header = document.querySelector('header')
      if (!header) throw new Error('no app header')
      const bottom = header.getBoundingClientRect().bottom
      return {
        sheetTop: sheet.getBoundingClientRect().top,
        headerContentBottom: bottom - Number.parseFloat(getComputedStyle(header).borderBottomWidth),
        headerBottom: bottom,
      }
    })
    expect(edges.sheetTop).toBeGreaterThanOrEqual(edges.headerContentBottom)
    expect(edges.sheetTop).toBeLessThanOrEqual(edges.headerBottom)
  })

  test('New page opens as a bottom sheet', async ({ page }) => {
    await navigateMobile(page, 'Pages')
    await page
      .locator('.page-browser-header')
      .getByRole('button', { name: 'New page', exact: true })
      .tap()
    await expectBottomSheet(page, page.getByTestId('new-page-dialog'))
  })

  test('the block date picker opens as a bottom sheet', async ({ page }) => {
    await openPageMobile(page, PAGE)
    await focusBlock(page)
    const toolbar = page.getByTestId('formatting-toolbar')
    await toolbar.getByRole('button', { name: 'More' }).tap()
    await page
      .getByTestId('toolbar-overflow-menu')
      .getByRole('button', { name: 'Set due date' })
      .tap()
    await expectBottomSheet(page, page.getByTestId('date-picker-popup'))
  })

  test('the search sheet has one close button and a 44 px drag handle', async ({ page }) => {
    await page.getByTestId('search-sheet-trigger').tap()
    const sheet = page.getByTestId('search-sheet')
    await expect(sheet.getByTestId('in-page-find-input')).toBeVisible()
    await expect(sheet.getByRole('button', { name: /^Close/ })).toHaveCount(1)
    const handle = await box(sheet.locator('[data-slot="sheet-drag-handle"]'))
    expect(handle.height).toBeGreaterThanOrEqual(TOUCH_FLOOR)
    expect(handle.width).toBeGreaterThanOrEqual(TOUCH_FLOOR)
  })

  // One of each kind: a MenuSheet, a plain Sheet, and a `useDialogOrSheet` dialog.
  test('each kind of bottom sheet rises on a rounded top with a 44 px grab handle', async ({
    page,
  }) => {
    await openBlockMenu(page)
    await expectGrabbable(page)
    await activeMenu(page)
      .getByRole('menuitem', { name: /Properties/ })
      .tap()
    await expect(page.getByRole('dialog', { name: 'Block properties' })).toBeVisible()
    await expectGrabbable(page)
    await page.keyboard.press('Escape')
    await navigateMobile(page, 'Pages')
    await page
      .locator('.page-browser-header')
      .getByRole('button', { name: 'New page', exact: true })
      .tap()
    await expect(page.getByTestId('new-page-dialog')).toBeVisible()
    await expectGrabbable(page)
  })

  test('a pull down from the grab handle closes the sheet; a short one springs back', async ({
    page,
  }) => {
    await openBlockMenu(page)
    const sheet = activeSheet(page)
    await pullHandle(page, 30)
    await expectBottomSheet(page, sheet)
    await pullHandle(page, 160)
    await expect(sheet).toHaveCount(0)
    await expect(activeMenu(page)).toHaveCount(0)
  })

  test('menu rows and list rows fill while pressed', async ({ page }) => {
    const accent = await accentColor(page)
    // The journal mode menu (`PopoverMenuItem`).
    await page.getByRole('button', { name: /^Journal view mode/ }).tap()
    await expectPressedFill(page, page.getByRole('button', { name: 'Week', exact: true }), accent)
    // The block menu (`menu-row`).
    const menu = await openBlockMenu(page)
    await expectPressedFill(page, menu.getByRole('menuitem', { name: 'Turn into' }), accent)
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    // The page menu (`MENU_ITEM_CLASS`).
    await page.getByRole('button', { name: 'Page actions' }).tap()
    const pageMenu = page.getByRole('menu', { name: 'Page actions' })
    await expectPressedFill(page, pageMenu.getByRole('menuitem', { name: 'Open outline' }), accent)
    await expect(page.getByRole('dialog', { name: 'Outline' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(activeSheet(page)).toHaveCount(0)
    // A Pages row (`ListItem`), not the one the list cursor rests on.
    await navigateMobile(page, 'Pages')
    await expectPressedFill(page, page.locator('[data-page-item]').nth(2), accent)
  })

  // Raised on Search, where a toast once covered the search field.
  test('a toast sits above the floating button, clear of the header, with a 44 px close', async ({
    page,
  }) => {
    const toast = await toastOnSearch(page)
    const header = await box(page.locator('header').first())
    const fab = await box(page.getByTestId('quick-capture-fab'))
    await expect.poll(async () => (await box(toast)).y).toBeGreaterThan(header.y + header.height)
    const t = await box(toast)
    expect(t.y + t.height).toBeLessThanOrEqual(fab.y)

    // The 20 px close button answers a tap anywhere in a 44 px square around
    // it, as far as the screen edge it overhangs.
    const close = toast.locator('[data-close-button]')
    const c = await box(close)
    const cx = c.x + c.width / 2
    const cy = c.y + c.height / 2
    const half = TOUCH_FLOOR / 2 - 1
    for (const [x, y] of [
      [Math.max(1, cx - half), cy],
      [cx + half, cy],
      [cx, cy - half],
      [cx, cy + half],
    ] as const) {
      const hit = await page.evaluate(
        ({ px, py }) => document.elementFromPoint(px, py)?.closest('[data-close-button]') != null,
        { px: x, py: y },
      )
      expect(hit, `tap at ${Math.round(x)},${Math.round(y)} reaches the close button`).toBe(true)
    }
  })

  test('with the keyboard up, a toast sits above it and off the focused input', async ({
    page,
  }) => {
    const toast = await toastOnSearch(page)
    const input = page.getByPlaceholder('Search blocks...')
    // Focus without a tap: a toast lying over the field would take the tap.
    await input.focus()
    await expect(input).toBeFocused()
    const KEYBOARD = 320
    await showKeyboard(page, KEYBOARD)

    const keyboardTop = 844 - KEYBOARD
    await expect
      .poll(async () => {
        const t = await box(toast)
        return t.y + t.height <= keyboardTop
      })
      .toBe(true)
    expect(overlaps(await box(toast), await box(input))).toBe(false)
  })
})
