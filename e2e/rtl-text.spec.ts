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
  selectEditorRange,
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

const editorRoot = (page: Page) =>
  page.locator('[data-testid="block-editor"] [contenteditable="true"]')
const pageBlockContent = (page: Page, id: string) =>
  page.locator(`[data-testid="page-mode-editor"] [data-page-block-id="${id}"] .page-block-content`)

async function toPageMode(page: Page): Promise<void> {
  await page
    .getByRole('radiogroup', { name: 'Editing mode' })
    .getByRole('radio', { name: 'Page' })
    .click()
  await expect(
    page.locator('[data-testid="page-mode-editor"] [data-page-block]').first(),
  ).toBeVisible()
}

/**
 * Run `check` on each block's content as each mode draws it: the static
 * render, the block's own editor, and page mode's block.
 */
async function inEveryMode(
  page: Page,
  ids: string[],
  check: (content: Locator, where: string, id: string) => Promise<void>,
): Promise<void> {
  for (const id of ids) await check(staticBlock(page, id), `static ${id}`, id)
  for (const id of ids) {
    await focusBlockById(page, id)
    await check(editorRoot(page), `editor ${id}`, id)
    await page.keyboard.press('Escape')
  }
  await toPageMode(page)
  for (const id of ids) await check(pageBlockContent(page, id), `page mode ${id}`, id)
}

/**
 * The caret in the focused editor, read once ProseMirror has taken the
 * browser's selection, a frame after a key: the block it is in and its offset
 * in its textblock of `size`.
 */
function caretAt(page: Page): Promise<{ row: string | null; offset: number; size: number }> {
  return page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    interface Resolved {
      pos: number
      start: () => number
      parent: { content: { size: number } }
    }
    const root = document.activeElement?.closest('.ProseMirror') as
      | (Element & {
          editor: {
            state: { selection: { from: number; $from: Resolved } }
            view: { domAtPos: (pos: number) => { node: Node } }
          }
        })
      | null
    if (!root) return { row: null, offset: -1, size: -1 }
    const { from, $from } = root.editor.state.selection
    const dom = root.editor.view.domAtPos(from).node
    const holder = (
      dom.nodeType === Node.ELEMENT_NODE ? (dom as Element) : dom.parentElement
    )?.closest('[data-page-block-id], [data-block-id]')
    return {
      row:
        holder?.getAttribute('data-page-block-id') ?? holder?.getAttribute('data-block-id') ?? null,
      offset: from - $from.start(),
      size: $from.parent.content.size,
    }
  })
}

/** Press Home until the caret sits at its line's start: a click's caret can land after the key. */
async function caretHome(page: Page): Promise<void> {
  await expect
    .poll(async () => {
      await page.keyboard.press('Home')
      return (await caretAt(page)).offset
    })
    .toBe(0)
}

const direction = (el: Locator) => el.evaluate((node) => getComputedStyle(node).direction)

test.describe('a right-to-left block content follows its direction (#7040) @editor @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('the block, a list, a quote, a callout and a table mirror; code stays left to right', async ({
    page,
  }) => {
    const ids = await seedBlocks(page, 'RTL chrome', {
      chipFirst: `[[${SEED_IDS.PAGE_QUICK_NOTES}]] ${ARABIC}`,
      list: `1. ${ARABIC}\n2. ${ARABIC}`,
      quote: `> ${ARABIC}`,
      callout: `> [!NOTE] عنوان\n> ${ARABIC}`,
      table: `| عمود | قيمة |\n| --- | --- |\n| واحد | اثنان |`,
      code: `${ARABIC}\n\n\`\`\`js\nconst x = 1\n\`\`\``,
      numbered: ARABIC,
      task: ARABIC,
    })
    await ipc(page, 'set_todo_state', { blockId: ids.task, state: 'TODO' })
    await ipc(page, 'set_priority', { blockId: ids.task, level: '1' })
    await ipc(page, 'set_property', {
      blockId: ids.numbered,
      key: 'listStyle',
      value: { value_text: 'ordered' },
    })
    await open(page, 'RTL chrome')
    await inEveryMode(page, Object.values(ids), async (content, where, id) => {
      // An English chip first does not make an Arabic block left to right.
      expect(await direction(content), where).toBe('rtl')
      if (id === ids.list) {
        const li = content.locator('li').first()
        expect(await direction(li), `${where}: the item, so its marker reads 1. on the right`).toBe(
          'rtl',
        )
        // The marker takes the room right of the text.
        const room = await content
          .locator(':is(ol, ul)')
          .first()
          .evaluate((list, text) => {
            const walker = document.createTreeWalker(list, NodeFilter.SHOW_TEXT)
            let node = walker.nextNode()
            while (node !== null && !node.textContent?.includes(text)) node = walker.nextNode()
            if (node === null) throw new Error('no item text')
            const range = document.createRange()
            range.selectNodeContents(node)
            return list.getBoundingClientRect().right - range.getBoundingClientRect().right
          }, ARABIC)
        expect(room, `${where}: the marker's room`).toBeGreaterThan(8)
      }
      if (id === ids.quote || id === ids.callout) {
        const bar = await content
          .locator('blockquote')
          .first()
          .evaluate((q) => {
            const style = getComputedStyle(q)
            return [style.borderRightWidth, style.borderLeftWidth]
          })
        expect(bar, `${where}: the bar on the right`).toEqual(['3px', '0px'])
      }
      if (id === ids.callout) {
        const icon = await content.evaluate((root) => {
          const static_ = root.querySelector('[data-testid="callout-block"] svg')
          if (static_ !== null) {
            const label = static_.nextElementSibling as Element
            return static_.getBoundingClientRect().left > label.getBoundingClientRect().left
          }
          return (
            getComputedStyle(root.querySelector('blockquote') as Element, '::after').right ===
            '16px'
          )
        })
        expect(icon, `${where}: the icon right of the label`).toBe(true)
      }
      if (id === ids.table) {
        const [first, second] = await content
          .locator('th')
          .evaluateAll((cells) => cells.map((cell) => cell.getBoundingClientRect().left))
        expect(first, `${where}: the first column on the right`).toBeGreaterThan(second as number)
      }
      if (id === ids.code)
        expect(await direction(content.locator('pre').first()), where).toBe('ltr')
      if (id === ids.task) {
        // The checkbox and the chips under the text stay left to right, on the left.
        const block = content
          .page()
          .locator(
            `[data-testid="sortable-block"][data-block-id="${id}"], [data-page-block-id="${id}"]`,
          )
        const badge = await block.locator('[data-testid="priority-badge"]').first().boundingBox()
        if (badge === null) throw new Error(`${where}: no priority badge`)
        expect(badge.x, `${where}: the priority badge on the left`).toBeLessThan(
          await xOf(content, ARABIC),
        )
      }
      if (id === ids.numbered) {
        // A numbered block's marker leads its text from the right; page mode draws it beside the text.
        const block = content.locator(
          'xpath=ancestor-or-self::*[@data-block-id or @data-page-block-id][1]',
        )
        const marker = await block.locator('.list-marker').first().boundingBox()
        if (marker === null) throw new Error(`${where}: no marker`)
        expect(marker.x, `${where}: the marker right of the text`).toBeGreaterThan(
          await xOf(content, ARABIC),
        )
      }
    })
  })

  test('an English block keeps every one of them left to right', async ({ page }) => {
    const ids = await seedBlocks(page, 'LTR chrome', {
      list: '1. first\n2. second',
      quote: '> A quoted line',
      table: '| One | Two |\n| --- | --- |\n| a | b |',
    })
    await open(page, 'LTR chrome')
    await inEveryMode(page, Object.values(ids), async (content, where, id) => {
      expect(await direction(content), where).toBe('ltr')
      if (id === ids.list) expect(await direction(content.locator('li').first()), where).toBe('ltr')
      if (id === ids.quote) {
        const bar = await content
          .locator('blockquote')
          .first()
          .evaluate((q) => {
            const style = getComputedStyle(q)
            return [style.borderLeftWidth, style.borderRightWidth]
          })
        expect(bar, where).toEqual(['3px', '0px'])
      }
      if (id === ids.table) {
        const [first, second] = await content
          .locator('th')
          .evaluateAll((cells) => cells.map((cell) => cell.getBoundingClientRect().left))
        expect(first, where).toBeLessThan(second as number)
      }
    })
  })

  test("an Arabic table's handles sit at its start and end, and Alt+Shift+ArrowLeft moves a column left", async ({
    page,
  }) => {
    const ids = await seedBlocks(page, 'RTL table handles', {
      table: '| عمود | قيمة |\n| --- | --- |\n| واحد | اثنان |',
    })
    await open(page, 'RTL table handles')
    const editor = await focusBlockById(page, ids.table)
    await editor.locator('td').filter({ hasText: 'واحد' }).click()
    const table = await editor.locator('table').boundingBox()
    if (table === null) throw new Error('no table box')
    const centre = async (testId: string) => {
      const box = await page.getByTestId(testId).boundingBox()
      if (box === null) throw new Error(`no ${testId}`)
      return box.x + box.width / 2
    }
    const middle = table.x + table.width / 2
    expect(
      await centre('table-row-handle'),
      'the row handle at the start, on the right',
    ).toBeGreaterThan(middle)
    expect(await centre('table-add-column'), 'Add column after the last, on the left').toBeLessThan(
      middle,
    )
    await page.keyboard.press('Alt+Shift+ArrowLeft')
    await expect(editor.locator('th').first(), 'the column moved left, to the end').toHaveText(
      'قيمة',
    )
    await page.keyboard.press('Alt+Shift+ArrowRight')
    await expect(editor.locator('th').first(), 'and back right, to the start').toHaveText('عمود')

    // Dragged onto the column after it, it lands past that one: on its left.
    const handle = await page.getByTestId('table-column-handle').boundingBox()
    const target = await editor.locator('th').nth(1).boundingBox()
    if (handle === null || target === null) throw new Error('no layout box')
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
    await page.mouse.down()
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 })
    const line = await page.getByTestId('table-drop-line').boundingBox()
    if (line === null) throw new Error('no drop line')
    expect(Math.abs(line.x - target.x), 'the drop line on its left edge').toBeLessThanOrEqual(3)
    await page.mouse.up()
    await expect(editor.locator('th').first()).toHaveText('قيمة')
  })

  test('a click left of a closing marker in Hebrew types outside the bold, on its right half inside', async ({
    page,
  }) => {
    const ids = await seedBlocks(page, 'RTL marker click', { text: 'כתוב **מודגש** סוף' })
    await open(page, 'RTL marker click')
    const editor = await focusBlockById(page, ids.text)
    const closing = page.getByTestId('md-reveal-marker').nth(1)
    // Past the closing marker is its left side in right-to-left text.
    await selectEditorRange(page, 7, 7)
    await expect(page.getByTestId('md-reveal-marker')).toHaveCount(2)
    let box = await closing.boundingBox()
    if (!box) throw new Error('the closing marker has no layout box')
    await page.mouse.click(box.x - 1, box.y + box.height / 2)
    await page.keyboard.type('X')
    await expect(editor.locator('strong')).toHaveText('מודגש')

    await selectEditorRange(page, 7, 7)
    await expect(page.getByTestId('md-reveal-marker')).toHaveCount(2)
    box = await closing.boundingBox()
    if (!box) throw new Error('the closing marker has no layout box')
    await page.mouse.click(box.x + box.width - 1, box.y + box.height / 2)
    await page.keyboard.type('Y')
    await expect(editor.locator('strong')).toHaveText('מודגשY')
  })

  test('in page mode ArrowRight from a Hebrew block into the bold end of the one above lands outside the bold', async ({
    page,
  }) => {
    const ids = await seedBlocks(page, 'RTL into bold', { above: 'טקסט **מודגש**', below: 'שלום' })
    await open(page, 'RTL into bold')
    await toPageMode(page)
    await pageBlockContent(page, ids.below).locator('p').click()
    await caretHome(page)
    await page.keyboard.press('ArrowRight')
    await page.keyboard.type('X')
    await expect(pageBlockContent(page, ids.above).locator('strong')).toHaveText('מודגש')
    await expect(pageBlockContent(page, ids.above)).toContainText('X')
  })

  for (const [what, text, mode] of [
    ['bold', 'טקסט **מודגש** כאן', 'blocks'],
    ['a page link', `שלום [[${SEED_IDS.PAGE_QUICK_NOTES}]] עולם`, 'blocks'],
    ['bold', 'טקסט **מודגש** כאן', 'page'],
    ['a page link', `שלום [[${SEED_IDS.PAGE_QUICK_NOTES}]] עולם`, 'page'],
    ['English bold, with ArrowRight', 'text **bold** here', 'blocks'],
    ['English bold, with ArrowRight', 'text **bold** here', 'page'],
  ] as const) {
    test(`the arrows walk through ${what} and out of the block, in ${mode} mode`, async ({
      page,
    }) => {
      const rtl = !what.startsWith('English')
      const key = rtl ? 'ArrowLeft' : 'ArrowRight'
      const ids = await seedBlocks(page, `Walk ${what} ${mode}`, { text, after: 'After' })
      await open(page, `Walk ${what} ${mode}`)
      const enter = async () => {
        if (mode === 'blocks') await focusBlockById(page, ids.text)
        else await pageBlockContent(page, ids.text).locator('p').click()
      }
      if (mode === 'page') await toPageMode(page)
      await enter()
      const at = () => caretAt(page)
      await caretHome(page)
      const seen: number[] = []
      let last = await at()
      const { size } = last
      for (let i = 0; i < 40 && last.row === ids.text; i++) {
        // Past the end, the next block.
        await page.keyboard.press(key)
        const next = await at()
        if (next.row === ids.text) {
          // In a one-direction line the way the arrow points is forward in the text.
          expect(next.offset, `press ${i}`).toBeGreaterThanOrEqual(last.offset)
          seen.push(next.offset)
        }
        last = next
      }
      expect(Math.max(...seen), 'the caret reached the end of the text').toBe(size)
      expect(last.row, 'past the end, the next block').toBe(ids.after)
    })
  }
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
    // ArrowLeft from the English start comes back to the Arabic block, and
    // ArrowRight past the Arabic start goes on to the block before.
    await page.keyboard.press('Home')
    await page.keyboard.press('ArrowLeft')
    await expect.poll(editing).toBe(ids.arabic)
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
