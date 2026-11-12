import type { Page } from '@playwright/test'

import {
  createPageFromPagesView,
  expect,
  navigateToView,
  reopenPage,
  selectEditorRange,
  test,
  waitForBoot,
} from './helpers'

/**
 * Keys typed while Enter or a Backspace merge is saving land where they would
 * with an instant backend (#6559). The mock answers every command 50 ms late
 * here (`__setMockLatency`); with no delay these keys never raced the saves.
 * Each test types with no pause, then reads the rows, and again after leaving
 * the surface and coming back. The journal day and the page editor each mount
 * their own block tree.
 */

const rows = (page: Page) => page.locator('[data-testid="sortable-block"]')
const editor = (page: Page) => page.getByRole('textbox', { name: 'Block editor' })

function setMockLatency(page: Page, ms: number): Promise<void> {
  return page.evaluate((delay) => {
    ;(window as unknown as { __setMockLatency: (ms: number) => void }).__setMockLatency(delay)
  }, ms)
}

interface Surface {
  /** Open the surface with one empty block, its editor focused. */
  open: (page: Page) => Promise<void>
  /** Leave the surface and come back, so its rows are read again. */
  reopen: (page: Page) => Promise<void>
}

const journalDay: Surface = {
  open: async (page) => {
    await waitForBoot(page)
    await navigateToView(page, 'Journal')
    await page.getByRole('button', { name: 'Next day' }).click()
    await page.getByRole('button', { name: 'Add your first block' }).click()
    await expect(editor(page)).toBeFocused()
  },
  reopen: async (page) => {
    await navigateToView(page, 'Pages')
    await navigateToView(page, 'Journal')
  },
}

const PAGE_TITLE = 'Typed under latency'

const newPage: Surface = {
  open: async (page) => {
    await waitForBoot(page)
    await navigateToView(page, 'Pages')
    await createPageFromPagesView(page, PAGE_TITLE)
  },
  reopen: (page) => reopenPage(page, PAGE_TITLE),
}

async function expectRows(
  page: Page,
  surface: Surface,
  texts: Array<string | RegExp>,
): Promise<void> {
  await expect(rows(page)).toHaveText(texts)
  await surface.reopen(page)
  await expect(rows(page)).toHaveText(texts)
}

async function typeAcrossEnters(page: Page, surface: Surface): Promise<void> {
  await surface.open(page)
  await setMockLatency(page, 50)
  await page.keyboard.type('a')
  await page.keyboard.press('Enter')
  await page.keyboard.type('b')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('c')
  // The blank block the second Enter made is dropped when the caret leaves it.
  await expectRows(page, surface, ['a', 'b', 'c'])
}

async function typeAcrossSplit(page: Page, surface: Surface): Promise<void> {
  await surface.open(page)
  await page.keyboard.type('abcd')
  await expect(editor(page)).toHaveText('abcd')
  await selectEditorRange(page, 2, 2)
  await setMockLatency(page, 50)
  await page.keyboard.press('Enter')
  await page.keyboard.type('x')
  // Where in the block: a mount puts the caret at the end today, latency or not.
  await expectRows(page, surface, ['ab', /^(xcd|cdx)$/])
}

async function typeAcrossMerge(page: Page, surface: Surface): Promise<void> {
  await surface.open(page)
  await page.keyboard.type('one')
  await page.keyboard.press('Enter')
  await page.keyboard.type('two')
  await expect(rows(page)).toHaveText(['one', 'two'])
  await selectEditorRange(page, 0, 0)
  await setMockLatency(page, 50)
  await page.keyboard.press('Backspace')
  await page.keyboard.type('xyz')
  await expectRows(page, surface, ['onexyztwo'])
}

/**
 * Press `key` in the block editor from inside the page and report whether the
 * editor still has the focus once the handler returns. A key the user types
 * next is dispatched as its own task, which can run before the next frame.
 */
function editorFocusedRightAfter(page: Page, key: string): Promise<boolean> {
  return page.evaluate((k) => {
    const selector = '[data-testid="block-editor"] [contenteditable="true"]'
    document
      .querySelector(selector)
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
    return document.activeElement?.matches(selector) ?? false
  }, key)
}

async function focusKeptAcrossEnterAndMerge(page: Page, surface: Surface): Promise<void> {
  await surface.open(page)
  await page.keyboard.type('one')
  await expect(editor(page)).toHaveText('one')
  expect(await editorFocusedRightAfter(page, 'Enter')).toBe(true)
  await page.keyboard.type('two')
  await expect(rows(page)).toHaveText(['one', 'two'])
  await selectEditorRange(page, 0, 0)
  expect(await editorFocusedRightAfter(page, 'Backspace')).toBe(true)
  await expectRows(page, surface, ['onetwo'])
}

test.describe('keys typed while a journal day saves Enter or a merge @editor @journal', () => {
  test('a second Enter is kept and the keys around both land in their blocks', ({ page }) =>
    typeAcrossEnters(page, journalDay))
  test('keys typed after Enter mid-line go to the split-off block', ({ page }) =>
    typeAcrossSplit(page, journalDay))
  test('keys typed after a Backspace merge go to the join', ({ page }) =>
    typeAcrossMerge(page, journalDay))
  test('the editor keeps the focus straight through Enter and a merge', ({ page }) =>
    focusKeptAcrossEnterAndMerge(page, journalDay))
})

test.describe('keys typed while a page saves Enter or a merge @editor @pages', () => {
  test('a second Enter is kept and the keys around both land in their blocks', ({ page }) =>
    typeAcrossEnters(page, newPage))
  test('keys typed after Enter mid-line go to the split-off block', ({ page }) =>
    typeAcrossSplit(page, newPage))
  test('keys typed after a Backspace merge go to the join', ({ page }) =>
    typeAcrossMerge(page, newPage))
})
