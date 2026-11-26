/**
 * E2E — on a 390 × 844 phone, overlays rise from the bottom (#5931): the block
 * properties panel, History, Outline, Keyboard shortcuts, New page and the
 * block date picker are bottom sheets, and the block long-press menu and the
 * page ⋮ menu are bottom-sheet lists. Each must sit on the bottom edge and span
 * the width, and a tall one stops at the header. Toasts sit at the bottom too,
 * beside the floating capture button and clear of the soft keyboard and the
 * field being typed in. The search sheet keeps one close button (#5930), and
 * no sheet has a grab bar (#7040).
 *
 * A sheet's bottom is the viewport's: `SheetContent` anchors at `bottom-0` and
 * Chromium reports no safe-area inset.
 */

import { devices, type Locator, type Page } from '@playwright/test'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import { expectToastCloseInside, runSlashCommand } from './domain'
import {
  activeMenu,
  activePopover,
  activeSheet,
  centerOf,
  emitMockEvent,
  expect,
  focusBlock,
  ipc,
  navigateMobile,
  navigateToView,
  openMobileSidebar,
  openPage,
  openPageMobile,
  saveBlock,
  test,
  touchLongPress,
  waitForBoot,
} from './helpers'

const iPhone13 = devices['iPhone 13']
const PAGE = 'Getting Started'
const TOUCH_FLOOR = 44

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

/** The open sheet is square, edge to edge, with no grab bar (#7040). */
async function expectSquareNoHandle(page: Page): Promise<void> {
  const sheet = activeSheet(page)
  await expect(sheet).toBeVisible()
  const corners = await sheet.evaluate((el) => {
    const s = getComputedStyle(el)
    return [s.borderTopLeftRadius, s.borderTopRightRadius]
  })
  expect(corners).toEqual(['0px', '0px'])
  await expect(sheet.locator('[data-slot="sheet-drag-handle"]')).toHaveCount(0)
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

  test('the search sheet has one close button and no grab bar', async ({ page }) => {
    await page.getByTestId('search-sheet-trigger').tap()
    const sheet = page.getByTestId('search-sheet')
    await expect(sheet.getByTestId('in-page-find-input')).toBeVisible()
    await expect(sheet.getByRole('button', { name: /^Close/ })).toHaveCount(1)
    await expectSquareNoHandle(page)
  })

  // One of each kind: a MenuSheet, a plain Sheet, and a `useDialogOrSheet` dialog.
  test('each kind of bottom sheet is square, with no grab bar', async ({ page }) => {
    await openBlockMenu(page)
    await expectSquareNoHandle(page)
    await activeMenu(page)
      .getByRole('menuitem', { name: /Properties/ })
      .tap()
    await expect(page.getByRole('dialog', { name: 'Block properties' })).toBeVisible()
    await expectSquareNoHandle(page)
    await page.keyboard.press('Escape')
    await navigateMobile(page, 'Pages')
    await page
      .locator('.page-browser-header')
      .getByRole('button', { name: 'New page', exact: true })
      .tap()
    await expect(page.getByTestId('new-page-dialog')).toBeVisible()
    await expectSquareNoHandle(page)
  })

  test('menu rows and list rows fill while pressed', async ({ page }) => {
    const accent = await accentColor(page)
    // Every menu row is `menuRowVariants`: the journal mode menu (`PopoverMenuItem`).
    await page.getByRole('button', { name: /^Journal view mode/ }).tap()
    await expectPressedFill(page, page.getByRole('button', { name: 'Week', exact: true }), accent)
    // The block menu.
    const menu = await openBlockMenu(page)
    await expectPressedFill(page, menu.getByRole('menuitem', { name: 'Turn into' }), accent)
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    // The page menu.
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
  test('a toast sits beside the floating button, on its line, with a 44 px close', async ({
    page,
  }) => {
    const toast = await toastOnSearch(page)
    const header = await box(page.locator('header').first())
    const fab = await box(page.getByTestId('quick-capture-fab'))
    await expect.poll(async () => (await box(toast)).y).toBeGreaterThan(header.y + header.height)
    const t = await box(toast)
    // On the button's bottom line and just left of it: it costs width, not height.
    expect(Math.abs(t.y + t.height - (fab.y + fab.height))).toBeLessThanOrEqual(1)
    expect(fab.x - (t.x + t.width)).toBeGreaterThanOrEqual(0)
    expect(fab.x - (t.x + t.width)).toBeLessThanOrEqual(12)

    // The 24 px close button answers a tap anywhere in a 44 px square around it.
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

  test("a toast's close button sits inside it, on its text's line", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expectToastCloseInside(await toastOnSearch(page))
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

// A phone on its side is wider than 768 px and still a phone: one rule
// (`usePhoneLayout`) picks every surface below, as it picks the drawer (#7040).
test.describe('A phone in landscape keeps the phone surfaces (#7040) @mobile @editor @pages @journal', () => {
  const LANDSCAPE = { width: 915, height: 412 }
  // `screen` too: the rule reads the screen's height, and the project's desktop
  // descriptor leaves a 1080 px one.
  test.use({
    viewport: LANDSCAPE,
    screen: LANDSCAPE,
    hasTouch: iPhone13.hasTouch,
    isMobile: iPhone13.isMobile,
    deviceScaleFactor: iPhone13.deviceScaleFactor,
    userAgent: iPhone13.userAgent,
  })

  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await waitForBoot(page)
  })

  test('a dialog (New page) opens as a bottom sheet', async ({ page }) => {
    await navigateMobile(page, 'Pages')
    await page
      .locator('.page-browser-header')
      .getByRole('button', { name: 'New page', exact: true })
      .tap()
    await expectBottomSheet(page, page.getByTestId('new-page-dialog'))
  })

  test('the block menu is a bottom-sheet list, and Properties and History bottom sheets', async ({
    page,
  }) => {
    const menu = await openBlockMenu(page)
    await expectBottomSheet(page, menu)
    await menu.getByRole('menuitem', { name: /Properties/ }).tap()
    await expectBottomSheet(page, page.getByRole('dialog', { name: 'Block properties' }))
    await page.keyboard.press('Escape')
    await expect(activeSheet(page)).toHaveCount(0)
    await (await openBlockMenu(page)).getByRole('menuitem', { name: /History/ }).tap()
    await expectBottomSheet(page, page.getByRole('dialog', { name: 'Block history' }))
  })

  test('the page ⋮ menu is a bottom-sheet list holding the editing mode, and Outline a bottom sheet', async ({
    page,
  }) => {
    await openPageMobile(page, PAGE)
    // The Blocks | Page switch is a row of the menu, as on a phone held upright.
    await expect(page.getByRole('radiogroup', { name: 'Editing mode' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Page actions' }).tap()
    const menu = page.getByRole('menu', { name: 'Page actions' })
    await expectBottomSheet(page, menu)
    await expect(menu.getByRole('menuitem', { name: 'Edit as page' })).toBeVisible()
    await menu.getByRole('menuitem', { name: 'Open outline' }).tap()
    await expectBottomSheet(page, page.getByRole('dialog', { name: 'Outline' }))
  })

  test('keyboard shortcuts open as a bottom sheet', async ({ page }) => {
    await page.keyboard.type('?')
    await expect(page.getByTestId('shortcuts-table')).toBeVisible()
    await expectBottomSheet(page, activeSheet(page))
  })

  test('the header is the phone header, and the journal day has its ⋮ menu', async ({ page }) => {
    const header = page.locator('header').first()
    await expect(page.getByTestId('mobile-sidebar-trigger')).toBeVisible()
    await expect(header.getByRole('button', { name: 'Back', exact: true })).toBeHidden()
    await expect(header.getByTestId('search-sheet-trigger')).toBeVisible()
    // Room for the 44 px targets (`--phone-header-h`).
    expect((await box(header)).height).toBeGreaterThanOrEqual(56)
    await page.getByRole('button', { name: 'Page actions' }).tap()
    await expectBottomSheet(page, page.getByRole('menu', { name: 'Page actions' }))
  })

  test('no recent-pages strip under the header', async ({ page }) => {
    for (const title of [PAGE, 'Quick Notes']) {
      await openPageMobile(page, title)
      await expect(page.locator('[aria-label="Page title"]')).toHaveText(title)
    }
    await expect(page.getByTestId('quick-access-bar')).toHaveCount(0)
  })

  test('a view header scrolls with its view, edge to edge', async ({ page }) => {
    await navigateMobile(page, 'Pages')
    const outlet = page.locator('[data-slot="main-content"] [data-testid="view-header-outlet"]')
    await expect(outlet.getByPlaceholder('Search pages...')).toBeVisible()
    const edges = await outlet.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const scroller = el.closest('[data-slot="main-content"]')?.getBoundingClientRect()
      return { left: r.left, right: r.right, top: r.top - (scroller?.top ?? 0) }
    })
    expect(edges).toEqual({ left: 0, right: LANDSCAPE.width, top: 0 })
  })

  test('the calendar and the emoji picker are bottom sheets, and a page offers no new tab', async ({
    page,
  }) => {
    await page
      .locator('header')
      .first()
      .getByRole('button', { name: /Open calendar picker$/ })
      .tap()
    await expectBottomSheet(page, page.getByTestId('calendar-legend'))
    await page.keyboard.press('Escape')
    await expect(activeSheet(page)).toHaveCount(0)
    await openPageMobile(page, PAGE)
    await page.getByRole('button', { name: 'Page actions' }).tap()
    const menu = page.getByRole('menu', { name: 'Page actions' })
    // No tab bar on a phone, so nowhere for a new tab to show.
    await expect(menu.getByRole('menuitem', { name: 'Add alias' })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Open in new tab' })).toHaveCount(0)
    await menu.getByRole('menuitem', { name: 'Insert emoji' }).tap()
    await expectBottomSheet(page, page.getByRole('dialog', { name: 'Insert emoji' }))
  })

  test('Pages rows show no checkbox, the header no Today, and Agenda no scroll box of its own', async ({
    page,
  }) => {
    await navigateMobile(page, 'Pages')
    await expect(page.locator('[data-page-item]').first()).toBeVisible()
    await expect(page.locator('[data-testid^="page-select-"]').first()).toBeHidden()
    await expect(
      page.locator('header').first().getByRole('button', { name: 'Go to today' }),
    ).toHaveCount(0)
    await navigateMobile(page, 'Agenda')
    await expect(page.getByTestId('agenda-results-item').first()).toBeVisible()
    await expect(page.locator('.agenda-results-scroll')).toHaveCount(0)
  })

  test('a toast sits beside the floating button, not under it', async ({ page }) => {
    const toast = await toastOnSearch(page)
    const fab = await box(page.getByTestId('quick-capture-fab'))
    await expect.poll(async () => overlaps(await box(toast), fab)).toBe(false)
    const t = await box(toast)
    expect(fab.x - (t.x + t.width)).toBeGreaterThanOrEqual(0)
  })
})

// On Android the soft keyboard shrinks the webview (#6790), so a tablet on its
// side is left with a viewport under 500 px tall: its screen is no shorter, and
// the dialog being typed in must not be swapped for a sheet, which would drop
// the text and the focus.
test.describe('A tablet stays a tablet with its keyboard up (#7040) @mobile @pages', () => {
  const tablet = devices['Galaxy Tab S9 landscape']
  const KEYBOARD = 300
  test.use({
    viewport: tablet.viewport,
    hasTouch: tablet.hasTouch,
    isMobile: tablet.isMobile,
    deviceScaleFactor: tablet.deviceScaleFactor,
    userAgent: tablet.userAgent,
  })

  test('typing in a dialog keeps the dialog and the text', async ({ page }) => {
    await waitForBoot(page)
    await page.getByRole('button', { name: 'Pages', exact: true }).tap()
    await page
      .locator('.page-browser-header')
      .getByRole('button', { name: 'New page', exact: true })
      .tap()
    const dialog = page.getByTestId('new-page-dialog')
    const title = dialog.getByRole('textbox').first()
    await title.fill('Typed before the keyboard')
    await expect(dialog).toHaveAttribute('data-slot', 'dialog-content')

    // `page.setViewportSize` would shrink the emulated screen with the viewport.
    const cdp = await page.context().newCDPSession(page)
    const { width, height } = tablet.viewport
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height: height - KEYBOARD,
      screenWidth: width,
      screenHeight: height,
      deviceScaleFactor: tablet.deviceScaleFactor,
      mobile: true,
    })
    await expect.poll(() => page.evaluate(() => window.innerHeight)).toBe(height - KEYBOARD)

    await expect(dialog).toHaveAttribute('data-slot', 'dialog-content')
    await expect(title).toHaveValue('Typed before the keyboard')
    await expect(page.locator('[data-slot="sidebar"]:not([data-mobile])')).toBeInViewport()
  })
})

const MEETINGS = '00000000000000000000PAGE05'

/** Open the Pages view on a phone or a desktop. */
async function openPages(page: Page, phone: boolean): Promise<void> {
  if (phone) await navigateMobile(page, 'Pages')
  else await page.getByRole('button', { name: 'Pages', exact: true }).first().click()
  await expect(page.locator('[data-page-item]').first()).toBeVisible()
}

/** Meetings with a select property, whose row in its Properties offers Edit options. */
async function openMeetingsProperties(page: Page, phone: boolean): Promise<void> {
  await ipc(page, 'set_property', {
    blockId: MEETINGS,
    key: 'project',
    value: { value_text: 'alpha' },
  })
  if (phone) await openPageMobile(page, 'Meetings')
  else await openPage(page, 'Meetings')
  await page.getByRole('button', { name: /^Properties/ }).click()
  await page.getByRole('button', { name: 'Edit options for project', exact: true }).click()
}

/** The page ⋮ menu's Add tag, which opens the page's tag picker. */
async function openTagPicker(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Page actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Add tag', exact: true }).click()
}

/** The Tags view's colour picker for `work`, opened from its row. */
async function openTagColorPicker(page: Page): Promise<Locator> {
  await navigateToView(page, 'Tags')
  const row = page.getByRole('listitem').filter({ has: page.getByTestId('tag-item-work') })
  await row.hover()
  await row.getByRole('button', { name: 'Set tag color', exact: true }).click()
  return page.getByRole('dialog', { name: 'Set tag color' })
}

/** A page `title` holding one JavaScript code block. */
async function seedCodePage(page: Page, title: string): Promise<void> {
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: title,
    spaceId: SEED_IDS.SPACE_PERSONAL,
  })
  await ipc(page, 'create_block', {
    blockType: 'content',
    content: '```javascript\nconst x = 1\n```',
    parentId: pageId,
    index: null,
    scope: { kind: 'active', space_id: SEED_IDS.SPACE_PERSONAL },
  })
}

/** Open the toolbar's Turn into, inline or under More; on a code block it shows the language filter. */
async function openTurnInto(page: Page): Promise<void> {
  const toolbar = page.getByTestId('formatting-toolbar')
  const inline = toolbar.getByRole('button', { name: 'Turn into', exact: true })
  if (await inline.isVisible()) {
    await inline.click()
    return
  }
  await toolbar.getByRole('button', { name: 'More' }).click()
  await page
    .getByTestId('toolbar-overflow-menu')
    .getByRole('button', { name: 'Turn into', exact: true })
    .click()
}

const codeFilter = (page: Page) => page.getByRole('textbox', { name: 'Code block language' })

// One rule, `usePhoneLayout`, makes a popover holding a field, the four
// dialogs that were still centred, and every menu a bottom sheet on a phone
// (#7040 M8, M9, S13); a desktop keeps them anchored or centred.
test.describe('Phone popovers with a field, dialogs and menus are bottom sheets (#7040) @mobile @editor @pages @spaces', () => {
  test.use({
    viewport: { width: 412, height: 915 },
    hasTouch: iPhone13.hasTouch,
    isMobile: iPhone13.isMobile,
    deviceScaleFactor: iPhone13.deviceScaleFactor,
    userAgent: iPhone13.userAgent,
  })

  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await waitForBoot(page)
  })

  test('the page tag picker is a bottom sheet', async ({ page }) => {
    await openPageMobile(page, PAGE)
    await openTagPicker(page)
    const sheet = page.getByRole('dialog', { name: 'Add tag' })
    await expectBottomSheet(page, sheet)
    await expect(sheet.getByPlaceholder('Search or create tag...')).toBeVisible()
    // The first Escape closes it, as it closes the desktop popover.
    await page.keyboard.press('Escape')
    await expect(sheet).toHaveCount(0)
  })

  test("a select property's options editor is a bottom sheet", async ({ page }) => {
    await openMeetingsProperties(page, true)
    await expectBottomSheet(page, page.getByRole('dialog', { name: 'Edit options for project' }))
  })

  test('the Pages ⋮ menu is a bottom-sheet list', async ({ page }) => {
    await openPages(page, true)
    await page.getByTestId('page-browser-more').tap()
    await expectBottomSheet(page, page.getByTestId('saved-views-menu'))
  })

  test('the Pages filter is a bottom sheet', async ({ page }) => {
    await openPages(page, true)
    await page.getByRole('button', { name: 'Add filter', exact: true }).tap()
    await expectBottomSheet(page, page.getByRole('dialog', { name: 'Add filter' }))
  })

  test("the toolbar's More is a bottom-sheet list", async ({ page }) => {
    await openPageMobile(page, PAGE)
    await focusBlock(page)
    await page.getByTestId('formatting-toolbar').getByRole('button', { name: 'More' }).tap()
    await expectBottomSheet(page, page.getByTestId('toolbar-overflow-menu'))
  })

  test('the space switcher is a bottom-sheet list', async ({ page }) => {
    const drawer = await openMobileSidebar(page)
    await drawer.getByLabel('Switch space', { exact: true }).tap()
    const sheet = page.getByRole('dialog', { name: 'Switch space' })
    await expectBottomSheet(page, sheet)
    // Its rows still act: Manage spaces opens Settings › Spaces.
    await sheet.getByRole('button', { name: 'Manage spaces…' }).tap()
    await expect(page.getByRole('region', { name: 'Spaces' })).toBeVisible()
  })

  test('the voice note recorder is a bottom sheet', async ({ page }) => {
    await openPageMobile(page, PAGE)
    await focusBlock(page)
    await runSlashCommand(page, 'voice', 'VOICE — Record a voice note')
    await expectBottomSheet(page, page.getByTestId('voice-note-dialog'))
  })

  // A tap in the sheet, or on its scrim, is the sheet's: it must not reach the
  // query block through React's portal and put the query's text in an editor.
  test("a query table cell's page picker is a bottom sheet a tap leaves the table up", async ({
    page,
  }) => {
    await ipc(page, 'create_property_def', {
      spaceId: SEED_IDS.SPACE_PERSONAL,
      key: 'owner',
      valueType: 'ref',
      options: null,
    })
    await ipc(page, 'set_property', {
      blockId: SEED_IDS.BLOCK_MTG_1,
      key: 'owner',
      value: { value_ref: SEED_IDS.PAGE_QUICK_NOTES },
    })
    await openPageMobile(page, PAGE)
    await focusBlock(page)
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.type('{{query type:property key:owner table:true}}', { delay: 20 })
    await saveBlock(page)
    const block = page.locator('[data-testid="sortable-block"]').first()
    const cell = block.getByRole('button', { name: /^Edit owner/ })
    await cell.tap()
    const sheet = page.getByRole('dialog', { name: 'Select a page' })
    await expectBottomSheet(page, sheet)

    await sheet.getByRole('heading', { name: 'Select a page' }).tap()
    await expect(sheet).toBeVisible()
    await page.touchscreen.tap(200, (await box(sheet)).y / 2)
    await expect(sheet).toHaveCount(0)
    await expect(cell).toBeVisible()
    await expect(block.locator('[contenteditable="true"]')).toHaveCount(0)
  })

  // #7092: anchored, the custom colour ran off the foot of the screen.
  test('the tag colour picker is a bottom sheet with its hex field on screen', async ({ page }) => {
    const sheet = await openTagColorPicker(page)
    await expectBottomSheet(page, sheet)
    await sheet.getByRole('button', { name: 'Custom color', exact: true }).tap()
    await expect(sheet.getByRole('textbox', { name: 'Hex color', exact: true })).toBeInViewport({
      ratio: 1,
    })
  })

  // The pick lands on the block being edited, which is still being edited after it.
  test("Turn into's code language picker is a bottom sheet the editor keeps its block through", async ({
    page,
  }) => {
    await seedCodePage(page, 'Phone code')
    await openPageMobile(page, 'Phone code')
    await focusBlock(page)
    await openTurnInto(page)
    await expectBottomSheet(page, codeFilter(page))
    await codeFilter(page).fill('python')
    await codeFilter(page).press('Enter')
    await expect(codeFilter(page)).toHaveCount(0)
    const editor = page.locator('[data-testid="block-editor"] [contenteditable="true"]')
    await expect(editor).toBeFocused()
    await expect(editor.locator('pre > code')).toHaveClass('language-python')
  })

  test("page mode's code language picker is a bottom sheet", async ({ page }) => {
    await seedCodePage(page, 'Phone page code')
    await openPageMobile(page, 'Phone page code')
    await page.getByRole('button', { name: 'Page actions', exact: true }).tap()
    await page.getByRole('menuitem', { name: 'Edit as page', exact: true }).tap()
    const editor = page.locator('[data-testid="page-mode-editor"]')
    await editor.locator('pre').tap()
    const language = page.getByTestId('page-code-bubble').getByRole('button', {
      name: 'Code block language',
    })
    await language.tap()
    await expectBottomSheet(page, codeFilter(page))
    await codeFilter(page).fill('python')
    await codeFilter(page).press('Enter')
    await expect(codeFilter(page)).toHaveCount(0)
    await expect(editor).toBeFocused()
    await expect(language).toHaveText('python')
  })
})

test.describe('A desktop keeps the anchored popovers, dropdowns and dialogs (#7040) @editor @pages @spaces', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('the page tag picker is an anchored popover', async ({ page }) => {
    await openPage(page, PAGE)
    await openTagPicker(page)
    const search = activePopover(page).getByPlaceholder('Search or create tag...')
    await expect(search).toBeVisible()
    await expect(activeSheet(page)).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(search).toHaveCount(0)
  })

  test("a select property's options editor is an anchored popover", async ({ page }) => {
    await openMeetingsProperties(page, false)
    await expect(activePopover(page).getByTestId('options-editor-header-project')).toBeVisible()
    await expect(activeSheet(page)).toHaveCount(0)
  })

  test('saved views and the Pages filter are anchored popovers', async ({ page }) => {
    await openPages(page, false)
    await page.getByTestId('saved-views-trigger').click()
    await expect(page.getByTestId('saved-views-menu')).toHaveAttribute(
      'data-slot',
      'popover-content',
    )
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Add filter', exact: true }).click()
    await expect(activePopover(page).getByRole('button', { name: /^Tag/ }).first()).toBeVisible()
    await expect(activeSheet(page)).toHaveCount(0)
  })

  test('the space switcher is a dropdown', async ({ page }) => {
    await page.getByRole('combobox', { name: 'Switch space', exact: true }).click()
    await expect(page.getByRole('listbox')).toBeVisible()
    await expect(activeSheet(page)).toHaveCount(0)
  })

  test('the voice note recorder is a centred dialog', async ({ page }) => {
    await openPage(page, PAGE)
    await focusBlock(page)
    await runSlashCommand(page, 'voice', 'VOICE — Record a voice note')
    await expect(page.getByTestId('voice-note-dialog')).toHaveAttribute(
      'data-slot',
      'dialog-content',
    )
  })

  test('the tag colour picker and the code language picker are anchored popovers', async ({
    page,
  }) => {
    await openTagColorPicker(page)
    await expect(
      activePopover(page).getByRole('radiogroup', { name: 'Color palette' }),
    ).toBeVisible()
    await expect(activeSheet(page)).toHaveCount(0)
    await page.keyboard.press('Escape')
    await seedCodePage(page, 'Desktop code')
    await openPage(page, 'Desktop code')
    await focusBlock(page)
    await openTurnInto(page)
    await expect(
      activePopover(page).getByRole('textbox', { name: 'Code block language' }),
    ).toBeVisible()
    await expect(activeSheet(page)).toHaveCount(0)
  })
})
