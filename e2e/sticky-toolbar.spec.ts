import { devices } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'

import {
  activePopover,
  activeSuggestionPopup,
  expect,
  focusBlockById,
  getInvokeCalls,
  installIpcRecorder,
  ipc,
  navigateToView,
  openPage,
  openPageMobile,
  openSettingsTab,
  selectEditorRange,
  test,
  waitForBoot,
} from './helpers'

/**
 * One formatting toolbar per view, hidden at rest (#6562). Block mode's bar
 * sits pinned under the view header in room the view keeps for it, covering
 * no content, so focusing a block, moving between blocks and leaving the editor move no
 * text, and a double-click on a word cannot land on a toolbar button. The
 * view owns the bar, so it stays mounted while the focus moves between blocks,
 * and a journal week or stream view, one tree per day, shows exactly one.
 */

const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' }
const TEXTS = ['alpha one', 'bravo two', 'charlie three', 'delta four', 'echo five']

const toolbar = (page: Page): Locator => page.getByTestId('formatting-toolbar')
const editor = (page: Page): Locator => page.getByRole('textbox', { name: 'Block editor' })
const rows = (page: Page): Locator => page.locator('[data-testid="sortable-block"]')

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

/**
 * Every row's box and the box of its first line of text, static or edited, as
 * `top,left`: what a layout shift moves.
 */
function layout(page: Page): Promise<string[]> {
  return rows(page).evaluateAll((els) =>
    els.flatMap((row) => {
      const at = (box: DOMRect) => `${Math.round(box.top)},${Math.round(box.left)}`
      const content = row.querySelector(
        '[data-testid="block-static"], [data-testid="block-editor"] [contenteditable="true"]',
      )
      const walker = document.createTreeWalker(content ?? row, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) =>
          (n.textContent ?? '').trim() === '' ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_ACCEPT,
      })
      const text = walker.nextNode()
      const range = document.createRange()
      if (text) range.selectNodeContents(text)
      return [`row ${at(row.getBoundingClientRect())}`, `text ${at(range.getBoundingClientRect())}`]
    }),
  )
}

/** Click a static row's text, where a user clicks: on the first word. */
async function clickRow(page: Page, text: string): Promise<void> {
  await page
    .locator('[data-testid="block-static"]')
    .filter({ hasText: text })
    .getByText(text.split(' ')[0] as string)
    .click()
  await expect(editor(page)).toBeFocused()
  await expect(editor(page)).toContainText(text)
}

/**
 * Put the caret at the end of the edited block's text: a click leaves it where it landed, and
 * ProseMirror reads a native End too late for the next key.
 */
async function caretAtEnd(page: Page): Promise<void> {
  const length = ((await editor(page).textContent()) ?? '').length
  await selectEditorRange(page, length, length)
}

/** Watch the bar from now on: frames it was missing or hidden in, and whether it is still the same element. */
async function watchBar(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __bar: { el: Element | null; missed: number; on: boolean } }
    w.__bar = {
      el: document.querySelector('[data-testid="formatting-toolbar"]'),
      missed: 0,
      on: true,
    }
    const tick = () => {
      if (!w.__bar.on) return
      const el = document.querySelector('[data-testid="formatting-toolbar"]')
      if (el === null || !el.checkVisibility()) w.__bar.missed += 1
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

async function barWatch(page: Page): Promise<{ missed: number; same: boolean }> {
  return page.evaluate(() => {
    const w = window as unknown as { __bar: { el: Element | null; missed: number; on: boolean } }
    w.__bar.on = false
    const same = document.querySelector('[data-testid="formatting-toolbar"]') === w.__bar.el
    return { missed: w.__bar.missed, same }
  })
}

/** The main scroller's top edge, under the view header. */
function scrollportTop(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (
        document.querySelector(
          '[data-slot="main-content"] [data-slot="scroll-area-viewport"]',
        ) as Element
      ).getBoundingClientRect().top,
  )
}

async function startEmptyDay(page: Page): Promise<void> {
  await navigateToView(page, 'Journal')
  await page.getByRole('button', { name: 'Next day' }).click()
  await page.getByRole('button', { name: 'Add your first block' }).click()
  await expect(editor(page)).toBeFocused()
  for (const [i, text] of TEXTS.entries()) {
    if (i > 0) await page.keyboard.press('Enter')
    await page.keyboard.insertText(text)
  }
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(rows(page)).toHaveText(TEXTS)
}

test.describe('block mode formatting toolbar, one per view (#6562) @editor @pages @journal', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await page.emulateMedia({ reducedMotion: 'reduce' })
  })

  for (const where of ['page', 'journal day'] as const) {
    test(`on a ${where}, focusing, moving between and leaving blocks moves no row and no text`, async ({
      page,
    }) => {
      if (where === 'page') {
        await seedPage(page, 'Still page', TEXTS)
        await openPage(page, 'Still page')
        await expect(rows(page)).toHaveText(TEXTS)
      } else {
        await startEmptyDay(page)
      }
      await expect(toolbar(page)).toHaveCount(0)
      const atRest = await layout(page)

      await clickRow(page, 'bravo two')
      await expect(toolbar(page)).toBeVisible()
      expect(await layout(page)).toEqual(atRest)

      await caretAtEnd(page)
      await page.keyboard.press('ArrowDown')
      await expect(editor(page)).toContainText('charlie three')
      expect(await layout(page)).toEqual(atRest)

      await clickRow(page, 'echo five')
      expect(await layout(page)).toEqual(atRest)

      await page.keyboard.press('Escape')
      await expect(editor(page)).toHaveCount(0)
      await expect(toolbar(page)).toHaveCount(0)
      expect(await layout(page)).toEqual(atRest)
    })
  }

  test('the bar pins flush under the view header and stays mounted while the focus moves', async ({
    page,
  }) => {
    await seedPage(page, 'Moving page', TEXTS)
    await openPage(page, 'Moving page')
    await clickRow(page, 'alpha one')
    await expect(toolbar(page)).toBeVisible()
    expect((await toolbar(page).boundingBox())?.y).toBe(await scrollportTop(page))

    await watchBar(page)
    await clickRow(page, 'bravo two')
    await clickRow(page, 'charlie three')
    await clickRow(page, 'delta four')
    await caretAtEnd(page)
    await page.keyboard.press('ArrowDown')
    await expect(editor(page)).toContainText('echo five')
    await clickRow(page, 'alpha one')
    for (const next of ['bravo two', 'charlie three']) {
      await caretAtEnd(page)
      await page.keyboard.press('ArrowDown')
      await expect(editor(page)).toContainText(next)
    }
    expect(await barWatch(page)).toEqual({ missed: 0, same: true })
  })

  for (const width of [1280, 700]) {
    test(`at ${width} px the bar covers no content at scroll-top, on a page and in the week view`, async ({
      page,
    }) => {
      // The strip the bar sits in, its border included, against the first content under it.
      const barBottom = async (): Promise<number> => {
        const box = await toolbar(page).locator('xpath=..').boundingBox()
        return box ? box.y + box.height : Number.NaN
      }
      const top = async (locator: Locator): Promise<number> =>
        (await locator.boundingBox())?.y ?? Number.NaN

      await seedPage(page, 'Room page', TEXTS)
      await openPage(page, 'Room page')
      // Navigation goes through the sidebar, which collapses below `md`.
      await page.setViewportSize({ width, height: 800 })
      await clickRow(page, 'bravo two')
      expect(await barBottom()).toBeLessThanOrEqual(await top(rows(page).first()))

      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
      await page.setViewportSize({ width: 1280, height: 800 })
      // The shell swaps the drawer trigger for the sidebar a frame after the resize.
      await expect(page.getByTestId('mobile-sidebar-trigger')).toHaveCount(0)
      await navigateToView(page, 'Journal')
      await page.getByRole('tab', { name: 'Weekly view' }).click()
      await page.setViewportSize({ width, height: 800 })
      const day = page.locator('section[id^="journal-"]', { hasText: 'No blocks for' }).first()
      await day.getByRole('button', { name: 'Add block', exact: true }).click()
      await expect(editor(page)).toBeFocused()
      await page.evaluate(() => {
        const viewport = document.querySelector(
          '[data-slot="main-content"] [data-slot="scroll-area-viewport"]',
        ) as Element
        viewport.scrollTop = 0
      })
      await expect(toolbar(page)).toBeVisible()
      expect(await barBottom()).toBeLessThanOrEqual(
        // Below `md` the "Journal" title is screen-reader only; its header row stays.
        await top(page.locator('[data-slot="feature-page-header"]').first()),
      )
    })
  }

  test('with Tab moving focus, Shift+Tab reaches the bar, Tab goes back, and leaving the bar ends the edit', async ({
    page,
  }) => {
    await navigateToView(page, 'Settings')
    await openSettingsTab(page, 'Editor')
    await page.getByRole('switch', { name: 'Tab indents blocks' }).click()
    await seedPage(page, 'Keys page', TEXTS)
    await openPage(page, 'Keys page')
    await clickRow(page, 'bravo two')
    await caretAtEnd(page)
    await page.keyboard.insertText(' edited')

    await page.keyboard.press('Shift+Tab')
    await expect(toolbar(page).locator(':focus')).toHaveCount(1)
    await page.keyboard.press('Tab')
    await expect(editor(page)).toBeFocused()
    await expect(editor(page)).toHaveText('bravo two edited')

    await page.keyboard.press('Shift+Tab')
    await expect(toolbar(page).locator(':focus')).toHaveCount(1)
    const pane = await page.locator('[data-slot="main-content"]').boundingBox()
    await page.mouse.click((pane?.x ?? 0) + 40, (pane?.y ?? 0) + (pane?.height ?? 0) - 40)
    await expect(editor(page)).toHaveCount(0)
    await expect(toolbar(page)).toHaveCount(0)
    await expect(rows(page)).toHaveText([TEXTS[0] as string, 'bravo two edited', ...TEXTS.slice(2)])
  })

  test('a double-click on a word in an unfocused block selects it, writes nothing and opens no picker', async ({
    page,
  }) => {
    const line = 'the quick brown fox jumps over the lazy dog and runs far away'
    await seedPage(page, 'Double page', [...TEXTS, line])
    await openPage(page, 'Double page')
    await installIpcRecorder(page)

    // The second press of a double-click lands after the first one has mounted the editor.
    for (const word of ['quick', 'jumps', 'lazy', 'runs', 'away']) {
      const box = await page
        .locator('[data-testid="block-static"]')
        .filter({ hasText: line })
        .evaluate((el, w) => {
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
          let text = walker.nextNode() as Text
          while (!(text.textContent ?? '').includes(w)) text = walker.nextNode() as Text
          const at = (text.textContent ?? '').indexOf(w)
          const range = document.createRange()
          range.setStart(text, at)
          range.setEnd(text, at + w.length)
          const r = range.getBoundingClientRect()
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
        }, word)
      await page.mouse.move(box.x, box.y)
      await page.mouse.down()
      await page.mouse.up()
      await expect(editor(page)).toBeFocused()
      // A real second press comes 60 ms or more later: after ProseMirror puts its selection back
      // 20 ms after the focus, as `editBlock` in `helpers.ts` waits.
      await editor(page).evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 20))),
      )
      await page.mouse.down({ clickCount: 2 })
      await page.mouse.up({ clickCount: 2 })
      await expect(editor(page)).toHaveText(line)
      await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe(word)
      await expect(activeSuggestionPopup(page)).toHaveCount(0)
      await expect(activePopover(page)).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect(editor(page)).toHaveCount(0)
      await page.keyboard.press('Escape')
    }

    const writes = await page.evaluate(() =>
      ((window as unknown as { __ipcCalls__?: Array<{ cmd: string }> }).__ipcCalls__ ?? [])
        .map((c) => c.cmd)
        .filter((cmd) => /^(edit|create|delete|move|set|add|remove)_/.test(cmd)),
    )
    expect(writes).toEqual([])
    expect(await getInvokeCalls(page, 'edit_block')).toEqual([])
  })

  test('the journal week view shows one bar, acting on whichever day has the focus', async ({
    page,
  }) => {
    await navigateToView(page, 'Journal')
    await page.getByRole('tab', { name: 'Weekly view' }).click()
    const emptyDays = page.locator('section[id^="journal-"]', { hasText: 'No blocks for' })
    const [upperId, lowerId] = await Promise.all([
      emptyDays.nth(0).getAttribute('id'),
      emptyDays.nth(1).getAttribute('id'),
    ])
    const upper = page.locator(`section[id="${upperId}"]`)
    const lower = page.locator(`section[id="${lowerId}"]`)

    await lower.scrollIntoViewIfNeeded()
    await lower.getByRole('button', { name: 'Add block', exact: true }).click()
    await expect(lower.getByRole('textbox', { name: 'Block editor' })).toBeFocused()
    await page.keyboard.insertText('lower day')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await expect(toolbar(page)).toHaveCount(0)

    await upper.scrollIntoViewIfNeeded()
    await upper.getByRole('button', { name: 'Add block', exact: true }).click()
    await expect(upper.getByRole('textbox', { name: 'Block editor' })).toBeFocused()
    await page.keyboard.insertText('upper day')
    await expect(toolbar(page)).toHaveCount(1)
    await expect(upper.getByTestId('formatting-toolbar')).toHaveCount(0)

    await lower.locator('[data-testid="block-static"]').getByText('lower').click()
    await expect(lower.getByRole('textbox', { name: 'Block editor' })).toBeFocused()
    await expect(toolbar(page)).toHaveCount(1)
    await toolbar(page).getByRole('button', { name: 'Toggle TODO state', exact: true }).click()
    await expect(lower.getByTestId('task-checkbox-todo')).toHaveCount(1)
    await expect(upper.getByTestId('task-checkbox-todo')).toHaveCount(0)
  })

  test('the journal stream view shows one bar', async ({ page }) => {
    await navigateToView(page, 'Journal')
    await page.getByRole('tab', { name: 'Continuous stream view' }).click()
    const day = page.locator('section[id^="journal-"]').first()
    await day
      .getByRole('button', { name: /Add (your first )?block/ })
      .first()
      .click()
    await expect(editor(page)).toBeFocused()
    await page.keyboard.insertText('streamed')
    await expect(toolbar(page)).toHaveCount(1)
    await expect(day.getByTestId('formatting-toolbar')).toHaveCount(0)
  })

  test('at a narrow width the bar folds its overflow into More and stays on screen', async ({
    page,
  }) => {
    await seedPage(page, 'Narrow page', TEXTS)
    await openPage(page, 'Narrow page')
    await page.setViewportSize({ width: 480, height: 800 })
    await clickRow(page, 'alpha one')
    await expect(toolbar(page).getByRole('button', { name: 'More', exact: true })).toBeVisible()
    const bar = await toolbar(page).boundingBox()
    const lastButton = await toolbar(page)
      .getByRole('button', { name: 'More', exact: true })
      .boundingBox()
    expect(bar && lastButton && lastButton.x + lastButton.width <= bar.x + bar.width).toBe(true)
    expect(bar && bar.x + bar.width <= 480).toBe(true)
    expect(bar?.y).toBe(await scrollportTop(page))
  })

  test('page mode pins its bar flush under the view header too', async ({ page }) => {
    await seedPage(
      page,
      'Long page',
      Array.from({ length: 40 }, (_, i) => `line ${i}`),
    )
    await openPage(page, 'Long page')
    await page
      .getByRole('radiogroup', { name: 'Editing mode' })
      .getByRole('radio', { name: 'Page' })
      .click()
    await expect(toolbar(page)).toBeVisible()
    await page.evaluate(() => {
      const viewport = document.querySelector(
        '[data-slot="main-content"] [data-slot="scroll-area-viewport"]',
      ) as Element
      viewport.scrollTop = 600
    })
    await expect
      .poll(async () => (await toolbar(page).boundingBox())?.y)
      .toBe(await scrollportTop(page))
  })
})

test.describe('the formatting toolbar on a phone (#6562) @editor @mobile', () => {
  const phone = devices['Pixel 7']
  test.use({
    viewport: phone.viewport,
    hasTouch: phone.hasTouch,
    isMobile: phone.isMobile,
    deviceScaleFactor: phone.deviceScaleFactor,
    userAgent: phone.userAgent,
  })

  test('the bar is pinned above the keyboard and focusing a block moves no row', async ({
    page,
  }) => {
    await waitForBoot(page)
    const ids = await seedPage(page, 'Phone page', TEXTS)
    await openPageMobile(page, 'Phone page')
    await expect(page.locator('[data-testid="block-static"]')).toHaveText(TEXTS)
    const atRest = await layout(page)

    await focusBlockById(page, ids[1] as string)
    await expect(toolbar(page)).toHaveAttribute('data-pinned', 'true')
    await expect(toolbar(page)).toHaveCSS('position', 'fixed')
    const bar = await toolbar(page).boundingBox()
    expect(bar && Math.round(bar.y + bar.height)).toBe(phone.viewport.height)
    expect(await layout(page)).toEqual(atRest)
  })
})
