/**
 * Right-to-left text in a block (#6558): each paragraph takes its direction
 * from its first strong character (`unicode-bidi: plaintext`), so an Arabic
 * paragraph sits against the right edge of its box while an English block, the
 * app chrome and every gutter control keep their place. Block mode's static
 * render and editor and page mode alike, in a plain block, a mixed one, a list
 * item and a table cell.
 */

import type { Locator, Page } from '@playwright/test'

import { expect, focusBlockById, ipc, test, waitForBoot } from './helpers'

const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' }
const ARABIC = 'مرحبا بالعالم، هذه فقرة.'
const CONTENT = {
  arabic: ARABIC,
  english: 'Hello world, a paragraph.',
  mixed: 'مرحبا Agaric عالم',
  list: `- ${ARABIC}`,
  table: `| A column heading wider than its cells | Another heading wider than its cells |\n| --- | --- |\n| ${ARABIC} | Plain text |`,
} as const
type Key = keyof typeof CONTENT

async function seed(page: Page, title: string): Promise<Record<Key, string>> {
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: title,
    spaceId: SCOPE.space_id,
  })
  const ids = {} as Record<Key, string>
  for (const key of Object.keys(CONTENT) as Key[]) {
    const { id } = await ipc<{ id: string }>(page, 'create_block', {
      blockType: 'content',
      content: CONTENT[key],
      parentId: pageId,
      index: null,
      scope: SCOPE,
    })
    ids[key] = id
  }
  return ids
}

async function open(page: Page, title: string): Promise<void> {
  await page.keyboard.press('Control+k')
  await page.locator('[cmdk-input]').first().fill(title)
  await page.locator('[cmdk-item]').filter({ hasText: title }).first().waitFor()
  await page.keyboard.press('Enter')
  await expect(page.locator('[aria-label="Page title"]')).toHaveText(title)
}

/**
 * The space, in px, between the first line of the text holding `text` and the
 * left and right edges of the content box of the block element around it.
 */
function gaps(scope: Locator, text: string): Promise<{ left: number; right: number }> {
  return scope.evaluate((root, needle) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node !== null && !node.textContent?.includes(needle)) node = walker.nextNode()
    if (node === null) throw new Error(`no text node with ${needle}`)
    let box = node.parentElement as HTMLElement
    while (getComputedStyle(box).display.startsWith('inline'))
      box = box.parentElement as HTMLElement
    const range = document.createRange()
    range.selectNodeContents(node)
    // A one-line text: the union of its bidi runs.
    const line = range.getBoundingClientRect()
    const style = getComputedStyle(box)
    const outer = box.getBoundingClientRect()
    return {
      left: line.left - (outer.left + Number.parseFloat(style.paddingLeft)),
      right: outer.right - Number.parseFloat(style.paddingRight) - line.right,
    }
  }, text)
}

/** `inset`: what may sit between the text and the right edge, as a list item's bullet. */
async function expectRight(scope: Locator, text: string, inset = 1): Promise<void> {
  const { left, right } = await gaps(scope, text)
  expect(Math.abs(right), `${text}: right gap`).toBeLessThanOrEqual(inset)
  expect(left, `${text}: left gap`).toBeGreaterThan(10)
}

async function expectLeft(scope: Locator, text: string): Promise<void> {
  const { left, right } = await gaps(scope, text)
  expect(Math.abs(left), `${text}: left gap`).toBeLessThanOrEqual(1)
  expect(right, `${text}: right gap`).toBeGreaterThan(10)
}

const staticBlock = (page: Page, id: string) =>
  page.locator(`[data-testid="block-static"][data-block-id="${id}"]`)
const row = (page: Page, id: string) =>
  page.locator(`[data-testid="sortable-block"][data-block-id="${id}"]`)

test.describe('right-to-left text in a block @editor @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('static render: Arabic right, English left, gutter controls in place', async ({ page }) => {
    const ids = await seed(page, 'RTL static')
    await open(page, 'RTL static')
    await expectRight(staticBlock(page, ids.arabic), ARABIC)
    await expectLeft(staticBlock(page, ids.english), CONTENT.english)
    await expectRight(staticBlock(page, ids.mixed), 'Agaric')
    await expectRight(staticBlock(page, ids.list), ARABIC, 30)
    await expectRight(staticBlock(page, ids.table), ARABIC)
    await expectLeft(staticBlock(page, ids.table), 'Plain text')

    const gripX = async (id: string) => {
      await row(page, id).hover()
      return (await row(page, id).getByTestId('drag-handle').boundingBox())?.x
    }
    expect(await gripX(ids.arabic)).toBe(await gripX(ids.english))
    await expect(page.locator('html')).not.toHaveAttribute('dir', 'rtl')
  })

  test('editor: Arabic right-aligned and a click places the caret', async ({ page }) => {
    const ids = await seed(page, 'RTL editor')
    await open(page, 'RTL editor')
    const caret = () => page.evaluate(() => window.getSelection()?.anchorOffset)
    const editable = page.locator('[data-testid="block-editor"] [contenteditable="true"]')

    // A click on the static render mounts the editor with the caret where it
    // landed (#6562): the right end is the logical start, the left end the end.
    for (const [side, offset] of [
      ['right', 0],
      ['left', ARABIC.length],
    ] as const) {
      const line = await staticBlock(page, ids.arabic).evaluate((root, needle) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        let node = walker.nextNode()
        while (node !== null && !node.textContent?.includes(needle)) node = walker.nextNode()
        if (node === null) throw new Error(`no text node with ${needle}`)
        const range = document.createRange()
        range.selectNodeContents(node)
        const { left, right, top, height } = range.getBoundingClientRect()
        return { left, right, y: top + height / 2 }
      }, ARABIC)
      await page.mouse.click(side === 'right' ? line.right - 2 : line.left + 2, line.y)
      await expect(editable).toBeVisible()
      await expect.poll(caret).toBe(offset)
      await page.keyboard.press('Escape')
      await expect(editable).toBeHidden()
    }

    const editor = await focusBlockById(page, ids.arabic)
    await expectRight(editor, ARABIC)

    // The logical start of the Arabic line is its right end.
    const paragraph = editor.locator('p').first()
    const box = await paragraph.boundingBox()
    if (box === null) throw new Error('no paragraph box')
    const { left, right } = await gaps(editor, ARABIC)
    await page.mouse.click(box.x + box.width - right - 2, box.y + box.height / 2)
    await expect.poll(caret).toBe(0)
    await page.mouse.click(box.x + left + 2, box.y + box.height / 2)
    await expect.poll(caret).toBe(ARABIC.length)
  })

  test('page mode: Arabic right, English left', async ({ page }) => {
    const ids = await seed(page, 'RTL page')
    await open(page, 'RTL page')
    await page
      .getByRole('radiogroup', { name: 'Editing mode' })
      .getByRole('radio', { name: 'Page' })
      .click()
    const editor = page.locator('[data-testid="page-mode-editor"]')
    const block = (id: string) => editor.locator(`[data-page-block-id="${id}"]`)
    await expect(editor.locator('[data-page-block]')).toHaveCount(5)
    await expectRight(block(ids.arabic), ARABIC)
    await expectLeft(block(ids.english), CONTENT.english)
    await expectRight(block(ids.list), ARABIC)
    await expectRight(block(ids.table), ARABIC)
  })
})
