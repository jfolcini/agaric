/**
 * E2E — the bar above a phone's keyboard (#6532).
 *
 * At phone widths the formatting toolbar keeps only its highest-priority
 * buttons and folds the rest into More. The TODO toggle, the action of a task
 * list, stays on the bar at 412 and 360 px; on touch Undo and Redo give way to
 * it. A phone's keyboard has no Tab, so on touch the bar carries Indent and
 * Outdent, ranked just below TODO; with a fine pointer it does not.
 */

import { devices } from '@playwright/test'

import {
  expect,
  focusBlock,
  focusBlockById,
  ipc,
  openPage,
  openPageMobile,
  test,
  waitForBoot,
} from './helpers'

type Page = import('@playwright/test').Page

const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' }

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

const toolbar = (page: Page) => page.getByTestId('formatting-toolbar')

const row = (page: Page, id: string | undefined) => page.locator(`li[data-block-id="${id}"]`)

const PAGE_EDITOR = '[data-testid="page-mode-editor"]'

/** Tap into a page-mode block's text, once ProseMirror has taken the focus and put its selection back. */
async function tapIntoPageBlock(page: Page, id: string | undefined): Promise<void> {
  await page.locator(`${PAGE_EDITOR} [data-page-block-id="${id}"] .page-block-content`).tap()
  await expect(page.locator(PAGE_EDITOR)).toBeFocused()
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 20)))
}

/** Leave the page and come back, which reads its tree again. */
async function reopen(page: Page, title: string): Promise<void> {
  await openPageMobile(page, 'Getting Started')
  await openPageMobile(page, title)
}

// A 360 px bar keeps Indent beside Toggle TODO and folds Outdent into More.
const PHONES = [
  { name: 'Pixel 7', width: 412, onBar: ['Toggle TODO state', 'Indent', 'Outdent'] },
  { name: 'Galaxy S8', width: 360, onBar: ['Toggle TODO state', 'Indent'] },
] as const

for (const { name, width, onBar } of PHONES) {
  const phone = devices[name]

  test.describe(`the phone toolbar at ${width} px @editor @mobile`, () => {
    test.use({
      viewport: phone.viewport,
      hasTouch: phone.hasTouch,
      isMobile: phone.isMobile,
      deviceScaleFactor: phone.deviceScaleFactor,
      userAgent: phone.userAgent,
    })

    test.beforeEach(async ({ page }) => {
      await waitForBoot(page)
      await expect(page.locator('[data-testid="block-static"]').first()).toBeVisible()
    })

    test(`${onBar.join(', ')} are on the bar, not behind More`, async ({ page }) => {
      expect(page.viewportSize()?.width).toBe(width)
      await focusBlock(page, 0)
      await expect(toolbar(page)).toHaveAttribute('data-pinned', 'true')
      // The overflow pass settles a frame after the bar mounts; More is shown once it has.
      await expect(toolbar(page).getByRole('button', { name: 'More', exact: true })).toBeVisible()
      for (const label of onBar) {
        await expect(toolbar(page).getByRole('button', { name: label, exact: true })).toBeVisible()
      }
    })
  })
}

test.describe('Indent and Outdent on the phone toolbar @editor @mobile', () => {
  const phone = devices['Pixel 7']
  test.use({
    viewport: phone.viewport,
    hasTouch: phone.hasTouch,
    isMobile: phone.isMobile,
    deviceScaleFactor: phone.deviceScaleFactor,
    userAgent: phone.userAgent,
  })

  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Indent makes the block a child of the one above, Outdent takes it back out', async ({
    page,
  }) => {
    const [first, second] = await seedPage(page, 'Phone indent', ['first', 'second'])
    await openPageMobile(page, 'Phone indent')
    await expect(row(page, second)).toHaveAttribute('aria-level', '1')

    await focusBlockById(page, second as string)
    await toolbar(page).getByRole('button', { name: 'Indent', exact: true }).tap()
    await expect(row(page, second)).toHaveAttribute('aria-level', '2')

    await reopen(page, 'Phone indent')
    await expect(row(page, second)).toHaveAttribute('aria-level', '2')
    const indented = await ipc<{ parent_id: string | null }>(page, 'get_block', {
      blockId: second,
    })
    expect(indented.parent_id).toBe(first)

    await focusBlockById(page, second as string)
    await toolbar(page).getByRole('button', { name: 'Outdent', exact: true }).tap()
    await expect(row(page, second)).toHaveAttribute('aria-level', '1')

    await reopen(page, 'Phone indent')
    await expect(row(page, second)).toHaveAttribute('aria-level', '1')
  })

  test('in page mode, Indent and Outdent move the block the caret is in', async ({ page }) => {
    const [first, second] = await seedPage(page, 'Phone page indent', ['first', 'second'])
    await openPageMobile(page, 'Phone page indent')
    await page.getByRole('button', { name: 'Page actions', exact: true }).tap()
    await page.getByRole('menuitem', { name: 'Edit as page', exact: true }).tap()
    const pageBlock = page.locator(`${PAGE_EDITOR} [data-page-block-id="${second}"]`)
    await expect(pageBlock).toHaveAttribute('data-depth', '0')

    await tapIntoPageBlock(page, second)
    await toolbar(page).getByRole('button', { name: 'Indent', exact: true }).tap()
    await expect(pageBlock).toHaveAttribute('data-depth', '1')

    // Page mode is remembered for the page, so it opens in page mode again.
    await reopen(page, 'Phone page indent')
    await expect(pageBlock).toHaveAttribute('data-depth', '1')
    const indented = await ipc<{ parent_id: string | null }>(page, 'get_block', {
      blockId: second,
    })
    expect(indented.parent_id).toBe(first)

    // Page mode's bar also carries Block actions, which takes Outdent's slot: it is under More.
    await tapIntoPageBlock(page, second)
    await toolbar(page).getByRole('button', { name: 'More', exact: true }).tap()
    await page
      .getByTestId('toolbar-overflow-menu')
      .getByRole('button', { name: 'Outdent', exact: true })
      .tap()
    await expect(pageBlock).toHaveAttribute('data-depth', '0')

    await reopen(page, 'Phone page indent')
    await expect(pageBlock).toHaveAttribute('data-depth', '0')
  })
})

test.describe('the toolbar with a fine pointer @editor', () => {
  test('carries no Indent or Outdent button, on the bar or behind More', async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
    await focusBlock(page, 0)
    await expect(toolbar(page)).toBeVisible()
    await expect(toolbar(page)).not.toHaveAttribute('data-pinned', 'true')
    // The off-screen sentinel mirrors every item the bar has, shown or folded into More.
    const items = toolbar(page).locator('[data-toolbar-item-key]')
    await expect(
      items.filter({ has: page.locator('[aria-label="Toggle TODO state"]') }),
    ).toHaveCount(1)
    for (const label of ['Indent', 'Outdent']) {
      await expect(items.filter({ has: page.locator(`[aria-label="${label}"]`) })).toHaveCount(0)
    }
  })
})
