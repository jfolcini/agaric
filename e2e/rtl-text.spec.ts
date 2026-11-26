/**
 * Right-to-left text in a block (#6558): each paragraph takes its direction
 * from its first strong character (`unicode-bidi: plaintext`), so an Arabic
 * paragraph sits against the right edge of its box while an English block, the
 * app chrome and every gutter control keep their place. Block mode's static
 * render and editor and page mode alike, in a plain block, a mixed one, a list
 * item and a table cell. The arrows walk an Arabic block in the direction they
 * point, and block text shown elsewhere (search, the palette, the references,
 * the agenda, *Edit as Markdown*) runs in its own direction too (#7040).
 */

import type { Locator, Page } from '@playwright/test'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import {
  expect,
  focusBlockById,
  ipc,
  seedSearchBlocks,
  submitSearch,
  test,
  waitForBoot,
} from './helpers'

const SCOPE = { kind: 'active', space_id: SEED_IDS.SPACE_PERSONAL }
const ARABIC = 'مرحبا بالعالم، هذه فقرة.'
const CONTENT = {
  arabic: ARABIC,
  english: 'Hello world, a paragraph.',
  mixed: 'مرحبا Agaric عالم',
  list: `- ${ARABIC}`,
  table: `| A column heading wider than its cells | Another heading wider than its cells |\n| --- | --- |\n| ${ARABIC} | Plain text |`,
} as const

async function seedBlocks<K extends string>(
  page: Page,
  title: string,
  content: Record<K, string>,
): Promise<Record<K, string>> {
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: title,
    spaceId: SCOPE.space_id,
  })
  const ids = {} as Record<K, string>
  for (const key of Object.keys(content) as K[]) {
    const { id } = await ipc<{ id: string }>(page, 'create_block', {
      blockType: 'content',
      content: content[key],
      parentId: pageId,
      index: null,
      scope: SCOPE,
    })
    ids[key] = id
  }
  return ids
}

const seed = (page: Page, title: string) => seedBlocks(page, title, CONTENT)

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

/** The viewport x of the left edge of `needle`, a run inside one text node under `scope`. */
function xOf(scope: Locator, needle: string): Promise<number> {
  return scope.evaluate((root, text) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node !== null && !node.textContent?.includes(text)) node = walker.nextNode()
    if (node === null) throw new Error(`no text node with ${text}`)
    const start = (node.textContent as string).indexOf(text)
    const range = document.createRange()
    range.setStart(node, start)
    range.setEnd(node, start + text.length)
    return range.getBoundingClientRect().left
  }, needle)
}

/** `مرحبا Agaric عالم` reads right to left: its first word is right of the English one. */
async function expectReadsRightToLeft(scope: Locator, what: string): Promise<void> {
  await expect(scope).toContainText('Agaric')
  expect(await xOf(scope, 'مرحبا'), what).toBeGreaterThan(await xOf(scope, 'Agaric'))
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

test.describe('right-to-left text: arrows and the Markdown source @editor @pages @markdown', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('the arrows walk an Arabic block the way they point and leave it at that edge', async ({
    page,
  }) => {
    const ids = await seedBlocks(page, 'RTL arrows', {
      before: 'Before',
      arabic: ARABIC,
      after: 'After',
    })
    await open(page, 'RTL arrows')
    const editing = () =>
      page
        .locator('[data-testid="sortable-block"]:has([data-testid="block-editor"])')
        .getAttribute('data-block-id')
    const caret = () =>
      page
        .locator('[data-testid="block-editor"] [contenteditable="true"]')
        .evaluate(
          (el) =>
            (el as HTMLElement & { editor: { state: { selection: { from: number } } } }).editor
              .state.selection.from,
        )

    // A block the arrow lands in focuses a frame later and ProseMirror puts its selection back
    // 20 ms after that, undoing keys sent meanwhile (`editBlock` in helpers.ts).
    const settle = () =>
      page
        .locator('[data-testid="block-editor"] [contenteditable="true"]')
        .evaluate(
          () =>
            new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 20))),
        )

    await focusBlockById(page, ids.arabic)
    // Home is the line's start, its right end: ArrowLeft goes into the text.
    await page.keyboard.press('Home')
    await page.keyboard.press('ArrowLeft')
    await expect.poll(editing).toBe(ids.arabic)
    await expect.poll(caret).toBe(2)
    // Past the left end, the end of the text, is the next block.
    await page.keyboard.press('End')
    await page.keyboard.press('ArrowLeft')
    await expect.poll(editing).toBe(ids.after)
    await settle()
    // ArrowLeft from the English start comes back to the Arabic block, and
    // ArrowRight past the Arabic start goes on to the block before.
    await page.keyboard.press('Home')
    await page.keyboard.press('ArrowLeft')
    await expect.poll(editing).toBe(ids.arabic)
    await settle()
    await page.keyboard.press('Home')
    await page.keyboard.press('ArrowRight')
    await expect.poll(editing).toBe(ids.before)
  })

  test('a callout keeps its Arabic title on the right while its marker shows', async ({ page }) => {
    const ids = await seedBlocks(page, 'RTL callout', { callout: `> [!NOTE] عنوان\n> ${ARABIC}` })
    await open(page, 'RTL callout')
    const editor = await focusBlockById(page, ids.callout)
    await page.keyboard.press('Control+Home')
    await expect(editor.getByTestId('md-reveal-syntax-marker')).toBeVisible()
    // The marker sits between the title and the right edge.
    await expectRight(editor, 'عنوان', 120)
  })

  test('Edit as Markdown runs each line in its own direction', async ({ page }) => {
    await seed(page, 'RTL source')
    await open(page, 'RTL source')
    await page.getByRole('button', { name: 'Page actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Edit as Markdown', exact: true }).click()
    const source = page.getByRole('textbox', { name: 'Markdown source', exact: true })
    const line = (text: string) => source.locator('[data-source-line]').filter({ hasText: text })
    await expectRight(line(ARABIC).first(), ARABIC)
    await expectLeft(line(CONTENT.english), CONTENT.english)
    await expectReadsRightToLeft(line(CONTENT.mixed), 'the mixed line')
  })
})

test.describe('right-to-left block text in lists of blocks @search @journal @pages', () => {
  test('search, the palette, the references and the agenda read it right to left', async ({
    page,
  }) => {
    await waitForBoot(page)
    const [id] = await seedSearchBlocks(page, [
      { content: `${CONTENT.mixed} [[${SEED_IDS.PAGE_QUICK_NOTES}]]`, todo: 'TODO', due: 0 },
    ])

    await open(page, 'Quick Notes')
    await expectReadsRightToLeft(
      page.locator(`[data-backlink-item="${id}"] .linked-reference-item-text`),
      'references',
    )

    await page
      .locator('[data-slot="sidebar"]')
      .getByRole('button', { name: 'Search', exact: true })
      .click()
    await submitSearch(page, 'Agaric')
    await expectReadsRightToLeft(page.getByTestId(`search-result-row-${id}`), 'search')

    await page.keyboard.press('Control+k')
    await page.getByTestId('command-palette-input').fill('Agaric')
    await expectReadsRightToLeft(page.getByTestId(`palette-block-${id}`), 'palette')
    await page.keyboard.press('Escape')

    await page
      .locator('[data-slot="sidebar"]')
      .getByRole('button', { name: 'Agenda', exact: true })
      .click()
    await expectReadsRightToLeft(
      page.getByTestId('agenda-results-item').filter({ hasText: 'Agaric' }),
      'agenda',
    )
  })
})
