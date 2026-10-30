/**
 * Page mode on a touch phone (#5691) against the mock backend: *Page actions*
 * opens and leaves it, the header keeping one row, as does *Page* under Edit as
 * Markdown's buffer. The toolbar is pinned to the screen's foot only while the
 * text is edited, its menus open included, and the quick-capture button is
 * there otherwise, on a page and on the journal's day. The toolbar's *Block
 * actions*, inline or under *More* on a narrow phone, opens the block menu on
 * the block the cursor was tapped into, as no grip, right click or menu key can
 * there. A row's move and typed text are read back after leaving the page and
 * coming back. Typing at the foot of the screen keeps the cursor above the
 * pinned toolbar, and a tap in a link shows page mode's link bubble alone,
 * inside the screen. The lane left of the text is narrower than a desktop's,
 * its chevron and checkbox still 44 px to a finger.
 */

import { devices, type Page } from '@playwright/test'

import {
  expect,
  fingerTap,
  ipc,
  navigateMobile,
  openPageMobile,
  test,
  waitForBoot,
} from './helpers'

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

const toolbar = (page: Page) => page.getByTestId('formatting-toolbar')

const blockActions = (page: Page) => toolbar(page).getByRole('button', { name: 'Block actions' })

const fab = (page: Page) => page.getByTestId('quick-capture-fab')

/** Nothing is being edited: no toolbar pinned to the screen's foot, the quick-capture button there. */
async function expectNotEditing(page: Page): Promise<void> {
  await expect(toolbar(page)).toHaveCount(0)
  await expect(fab(page)).toBeVisible()
}

/** The text is being edited: its toolbar pinned to the screen's foot, the quick-capture button gone. */
async function expectEditing(page: Page): Promise<void> {
  await expect(toolbar(page)).toHaveAttribute('data-pinned', 'true')
  await expect(toolbar(page)).toBeVisible()
  await expect(fab(page)).toBeHidden()
}

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
    // The menu opens on the finger's lift, not under it, where the lift's click would hit a row.
    await fingerTap(page, blockActions(page))
    const menu = page.getByRole('menu', { name: 'Block actions' })
    await expect(menu).toBeVisible()
    await expect(pageText(page)).toHaveText(['first', 'second', 'third'])
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
    const ids = await seedPage(page, 'Touch foot', lines)
    await openInPageMode(page, 'Touch foot', lines.length)
    // The toolbar shows once the text is tapped.
    await tapInto(page, ids[0])
    const barTop = (await toolbar(page).boundingBox())?.y ?? 0
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

  test('the toolbar shows while the text is edited, through its menus, and the quick-capture button otherwise', async ({
    page,
  }) => {
    const ids = await seedPage(page, 'Touch editing', ['alpha', 'beta'])
    await openInPageMode(page, 'Touch editing', 2)
    await expectNotEditing(page)

    await tapInto(page, ids[1])
    await expectEditing(page)
    await toolbar(page).getByRole('button', { name: 'Format', exact: true }).tap()
    await expect(page.locator('[data-slot="popover-content"]').last()).toBeVisible()
    await expectEditing(page)
    // The block menu takes the focus from the text: the toolbar under the finger stays.
    await blockActions(page).tap()
    const menu = page.getByRole('menu', { name: 'Block actions' })
    await expect(menu).toBeVisible()
    await expect(menu.locator(':focus')).toHaveCount(1)
    await expectEditing(page)
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expectEditing(page)

    await page.getByLabel('Page title').tap()
    await expect(page.getByLabel('Page title')).toBeFocused()
    await expectNotEditing(page)

    await tapInto(page, ids[0])
    await expectEditing(page)
    await navigateMobile(page, 'Journal')
    await expect(page.locator(EDITOR)).toHaveCount(0)
    await expectNotEditing(page)
  })

  test('the journal’s day in page mode shows the quick-capture button until its text is tapped', async ({
    page,
  }) => {
    await page.evaluate(() => localStorage.setItem('agaric-edit-mode', 'page'))
    await waitForBoot(page)
    const day = page.locator(`.journal-day-page ${EDITOR}`)
    await expect(day.locator('[data-page-block]').first()).toBeVisible()
    await expectNotEditing(page)

    await day.locator('[data-page-block] .page-block-content').first().tap()
    await expect(day).toBeFocused()
    await expectEditing(page)
  })

  test.describe('on a narrow phone', () => {
    test.use({ viewport: devices['iPhone SE'].viewport })

    test('Block actions under the toolbar’s More opens the block menu on the tapped block', async ({
      page,
    }) => {
      const ids = await seedPage(page, 'Touch narrow', ['first', 'second'])
      await openInPageMode(page, 'Touch narrow', 2)

      await tapInto(page, ids[1])
      await toolbar(page).getByRole('button', { name: 'More', exact: true }).tap()
      // The overflow popover takes the focus from the text.
      const row = page.getByTestId('toolbar-overflow-menu').getByRole('button', {
        name: 'Block actions',
      })
      await expect(row).toBeEnabled()
      await row.tap()
      const menu = page.getByRole('menu', { name: 'Block actions' })
      await menu.getByRole('menuitem', { name: 'Move & arrange' }).tap()
      await menu.getByRole('menuitem', { name: 'Move Up' }).tap()
      await expect(pageText(page)).toHaveText(['second', 'first'])
    })
  })

  test('the lane left of the text is narrow, its chevron and checkbox 44 px to a finger', async ({
    page,
  }) => {
    const [task] = await seedPage(page, 'Touch lane', ['task'])
    await ipc(page, 'create_block', {
      blockType: 'content',
      content: 'under it',
      parentId: task,
      index: null,
      scope: SCOPE,
    })
    await ipc(page, 'set_todo_state', { blockId: task, state: 'TODO' })
    await openInPageMode(page, 'Touch lane', 2)
    // The caret in the task shows its chevron.
    await tapInto(page, task)

    const lane = await page.evaluate(
      ({ selector, id }) => {
        const editor = document.querySelector(selector) as HTMLElement
        const block = editor.querySelector(`[data-page-block-id="${id}"]`) as HTMLElement
        const center = (el: Element | null) => {
          const at = (el as HTMLElement).getBoundingClientRect()
          return { x: at.left + at.width / 2, y: at.top + at.height / 2 }
        }
        const hit = (x: number, y: number) => {
          const el = document.elementFromPoint(x, y)
          if (el?.closest('[data-testid="collapse-toggle"]')) return 'chevron'
          if (el?.closest('[data-testid="task-marker"]')) return 'checkbox'
          return el?.closest('.page-block-content') ? 'text' : 'other'
        }
        const text = block.querySelector(':scope > .page-block-content') as HTMLElement
        const textLeft = text.getBoundingClientRect().left
        const chevron = center(block.querySelector('[data-testid="collapse-toggle"]'))
        const checkbox = center(block.querySelector('[data-testid="task-marker"]'))
        return {
          offset: textLeft - editor.getBoundingClientRect().left,
          hits: [
            hit(chevron.x - 21, chevron.y),
            hit(chevron.x, chevron.y - 21),
            hit(chevron.x, chevron.y + 21),
            hit(checkbox.x - 21, checkbox.y),
            hit(checkbox.x + 21, checkbox.y),
            hit(textLeft + 1, checkbox.y),
          ],
        }
      },
      { selector: EDITOR, id: task },
    )
    // A phone's `pl-14` (`index.css`), not the `pl-20` the controls' boxes took side by side.
    expect(lane.offset).toBeLessThan(60)
    expect(lane.hits).toEqual(['chevron', 'chevron', 'chevron', 'checkbox', 'checkbox', 'text'])
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
