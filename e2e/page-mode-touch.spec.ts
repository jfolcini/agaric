/**
 * Page mode on a touch phone (#5691) against the mock backend: *Page actions*
 * opens and leaves it, the header keeping one row, as does *Page* under Edit as
 * Markdown's buffer, and the
 * toolbar's *Block actions* opens the block menu on the block the cursor was
 * tapped into, as no grip, right click or menu key can there, once a tap has
 * put the cursor in the page. A row's move and
 * typed text are read back after leaving the page and coming back. Typing at
 * the foot of the screen keeps the cursor above the pinned toolbar, and a tap
 * in a link shows page mode's link bubble alone, inside the screen.
 */

import { devices, type Page } from '@playwright/test'

import { expect, ipc, openPageMobile, test, waitForBoot } from './helpers'

const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' }
const EDITOR = '[data-testid="page-mode-editor"]'
const iPhone13 = devices['iPhone 13']

/** A page titled `title` holding `texts`, top-level; resolves the blocks' ids. */
async function seedPage(page: Page, title: string, texts: readonly string[]): Promise<string[]> {
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: title,
    spaceId: SCOPE.space_id,
  })
  const ids: string[] = []
  for (const content of texts) {
    const row = await ipc<{ id: string }>(page, 'create_block', {
      blockType: 'content',
      content,
      parentId: pageId,
      index: null,
      scope: SCOPE,
    })
    ids.push(row.id)
  }
  return ids
}

/** Tap *Page actions*, then its row `name`. */
async function pageAction(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Page actions', exact: true }).tap()
  await page.getByRole('menuitem', { name, exact: true }).tap()
}

/** Open `title` and switch it to page mode through *Page actions*. */
async function openInPageMode(page: Page, title: string, count: number): Promise<void> {
  await openPageMobile(page, title)
  await pageAction(page, 'Edit as page')
  await expect(page.locator(`${EDITOR} [data-page-block]`)).toHaveCount(count)
}

/** Open `title` in Edit as Markdown and tap the *Page* under its buffer. */
async function openInPageModeFromMarkdown(page: Page, title: string, count: number): Promise<void> {
  await openPageMobile(page, title)
  await pageAction(page, 'Edit as Markdown')
  await expect(page.getByTestId('page-source-editor')).toBeVisible()
  await page.getByRole('button', { name: 'Page', exact: true }).tap()
  await expect(page.locator(`${EDITOR} [data-page-block]`)).toHaveCount(count)
}

const blockText = (page: Page, id: string | undefined) =>
  page.locator(`${EDITOR} [data-page-block-id="${id}"] .page-block-content`)

/** Tap into a block, as a finger puts the cursor there, once ProseMirror has taken the focus. */
async function tapInto(page: Page, id: string | undefined): Promise<void> {
  await blockText(page, id).tap()
  await expect(page.locator(EDITOR)).toBeFocused()
  // ProseMirror puts its own selection back 20 ms after a focus; a timer set now runs after it.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 20)))
}

/** Leave the page and come back, which reads it again; it opens in the mode *Page actions* left it in. */
async function reopen(page: Page, title: string): Promise<void> {
  await openPageMobile(page, 'Getting Started')
  await openPageMobile(page, title)
}

const pageText = (page: Page) => page.locator(`${EDITOR} .page-block-content`)

const blockActions = (page: Page) =>
  page.getByTestId('formatting-toolbar').getByRole('button', { name: 'Block actions' })

test.describe('page mode on a touch phone (#5691) @editor @pages @mobile', () => {
  test.use({
    viewport: iPhone13.viewport,
    hasTouch: iPhone13.hasTouch,
    isMobile: iPhone13.isMobile,
    deviceScaleFactor: iPhone13.deviceScaleFactor,
    userAgent: iPhone13.userAgent,
  })

  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await waitForBoot(page)
  })

  test('Page actions switches the page to page mode, which is kept, and back', async ({ page }) => {
    await seedPage(page, 'Touch switch', ['alpha', 'beta'])
    await openPageMobile(page, 'Touch switch')
    await expect(page.getByRole('radiogroup', { name: 'Editing mode' })).toHaveCount(0)

    await pageAction(page, 'Edit as page')
    await expect(pageText(page)).toHaveText(['alpha', 'beta'])
    await expect(page.locator('[data-testid="block-static"]')).toHaveCount(0)
    await reopen(page, 'Touch switch')
    await expect(pageText(page)).toHaveText(['alpha', 'beta'])

    await pageAction(page, 'Edit as blocks')
    await expect(page.locator(EDITOR)).toHaveCount(0)
    await expect(page.locator('[data-testid="block-static"]')).toHaveCount(2)
  })

  test('the toolbar’s Block actions moves the tapped block, and the move is saved', async ({
    page,
  }) => {
    const ids = await seedPage(page, 'Touch reorder', ['first', 'second', 'third'])
    await openInPageModeFromMarkdown(page, 'Touch reorder', 3)

    await tapInto(page, ids[1])
    await blockActions(page).tap()
    const menu = page.getByRole('menu', { name: 'Block actions' })
    await menu.getByRole('menuitem', { name: 'Move & arrange' }).tap()
    await menu.getByRole('menuitem', { name: 'Move Down' }).tap()
    await expect(menu).toBeHidden()
    await expect(pageText(page)).toHaveText(['first', 'third', 'second'])

    await reopen(page, 'Touch reorder')
    await expect(pageText(page)).toHaveText(['first', 'third', 'second'])
  })

  test('text typed after a tap is saved', async ({ page }) => {
    const ids = await seedPage(page, 'Touch typing', ['alpha', 'omega'])
    await openInPageMode(page, 'Touch typing', 2)
    // Before a tap the cursor's block may be out of sight, where the block menu would act.
    await expect(blockActions(page)).toBeDisabled()

    const box = await blockText(page, ids[0]).boundingBox()
    expect(box).not.toBeNull()
    // The far end of the line, so the cursor lands after the text.
    await blockText(page, ids[0]).tap({ position: { x: (box?.width ?? 0) - 2, y: 8 } })
    await expect(page.locator(EDITOR)).toBeFocused()
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 20)))
    await page.keyboard.type(' beta')
    await expect(blockText(page, ids[0])).toHaveText('alpha beta')
    await expect(blockActions(page)).toBeEnabled()

    await reopen(page, 'Touch typing')
    await expect(pageText(page)).toHaveText(['alpha beta', 'omega'])
  })

  test('typing at the foot of the screen keeps the cursor above the toolbar', async ({ page }) => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`)
    await seedPage(page, 'Touch foot', lines)
    await openInPageMode(page, 'Touch foot', lines.length)
    const barTop = (await page.getByTestId('formatting-toolbar').boundingBox())?.y ?? 0
    const lowest = await page.evaluate(
      ({ selector, top }) =>
        [...document.querySelectorAll(`${selector} [data-page-block]`)]
          .findLast((el) => el.getBoundingClientRect().bottom < top)
          ?.getAttribute('data-page-block-id') ?? undefined,
      { selector: EDITOR, top: barTop },
    )

    await tapInto(page, lowest)
    for (const line of ['one', 'two', 'three', 'four']) {
      await page.keyboard.press('Enter')
      await page.keyboard.type(line)
    }

    await expect(page.locator(`${EDITOR} [data-page-block]`)).toHaveCount(lines.length + 4)
    await expect
      .poll(() =>
        page.evaluate(() => window.getSelection()?.getRangeAt(0).getBoundingClientRect().bottom),
      )
      .toBeLessThanOrEqual(barTop)
  })

  test('a tap in a link shows its bubble alone, inside the screen', async ({ page }) => {
    const ids = await seedPage(page, 'Touch link', [
      'first',
      'a line that runs on to [a link](https://example.com/a/rather/long/path/to/read) here',
    ])
    await openInPageMode(page, 'Touch link', 2)

    await tapInto(page, ids[0])
    await page.locator(`${EDITOR} [data-page-block-id="${ids[1]}"] a`).tap()
    const bubble = page.getByTestId('page-link-bubble')
    await expect(bubble.getByRole('button', { name: 'Remove', exact: true })).toBeVisible()
    await expect(page.getByRole('toolbar', { name: 'Selection formatting' })).toBeHidden()
    const width = page.viewportSize()?.width ?? 0
    await expect
      .poll(async () => {
        const at = await bubble.boundingBox()
        return at !== null && at.x >= 0 && at.x + at.width <= width
      })
      .toBe(true)
  })
})
