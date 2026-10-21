/**
 * Page mode's gutter (#5691) against the mock backend: each block's grip and
 * chevron where block mode's are, revealed as block mode's (and kept while the
 * pointer walks to them), with no axe violations; a drag by the grip moving
 * the block with the blocks under it, read back from the backend and again
 * after leaving the page and coming back; Escape, or the window losing focus,
 * cancelling a drag; the chevron's collapse, which block mode shows too; Enter
 * and Backspace around a collapsed block; and the grip's block menu, from a
 * click or the keyboard, with the keys on a focused grip left to it.
 */

import { createRequire } from 'node:module'

import type { Locator, Page } from '@playwright/test'

import { expect, ipc, readClipboard, test, waitForBoot } from './helpers'

const axePath = createRequire(import.meta.url).resolve('axe-core')
const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' }
const EDITOR = '[data-testid="page-mode-editor"]'

type Row = [depth: number, text: string]

async function seedRows(page: Page, title: string, rows: readonly Row[]) {
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: title,
    spaceId: SCOPE.space_id,
  })
  const ids: string[] = []
  const atDepth: string[] = [pageId]
  for (const [depth, content] of rows) {
    const row = await ipc<{ id: string }>(page, 'create_block', {
      blockType: 'content',
      content,
      parentId: atDepth[depth],
      index: null,
      scope: SCOPE,
    })
    atDepth[depth + 1] = row.id
    ids.push(row.id)
  }
  return { pageId, ids }
}

async function openViaPalette(page: Page, title: string): Promise<void> {
  await page.keyboard.press('Escape')
  // Escape leaves page mode's editor for the box around it; a Ctrl+K in the editor is its link's.
  await expect
    .poll(() => page.evaluate((sel) => document.activeElement?.matches(sel) ?? false, EDITOR))
    .toBe(false)
  await page.keyboard.press('Control+k')
  const input = page.locator('[cmdk-input]').first()
  await input.fill(title)
  await page.locator('[cmdk-item]').filter({ hasText: title }).first().waitFor()
  await page.keyboard.press('Enter')
  await expect(page.locator('[aria-label="Page title"]')).toHaveText(title)
  await expect(page.getByTestId('view-transition-wrapper')).toHaveCSS('opacity', '1')
}

function modeSwitch(page: Page, name: 'Blocks' | 'Page'): Locator {
  return page.getByRole('radiogroup', { name: 'Editing mode' }).getByRole('radio', { name })
}

async function openInPageMode(page: Page, title: string, count: number): Promise<void> {
  await openViaPalette(page, title)
  await modeSwitch(page, 'Page').click()
  await expect(page.locator(`${EDITOR} [data-page-block]`)).toHaveCount(count)
}

/** Leave the page and come back to it, which reads it from the backend again. */
async function reopen(page: Page, title: string, count: number): Promise<void> {
  await openViaPalette(page, 'Getting Started')
  await openInPageMode(page, title, count)
}

const block = (page: Page, id: string | undefined): Locator =>
  page.locator(`${EDITOR} [data-page-block-id="${id}"]`)
const grip = (page: Page, id: string | undefined): Locator =>
  block(page, id).locator(':scope > .page-block-gutter > [data-testid="drag-handle"]')
const chevron = (page: Page, id: string | undefined): Locator =>
  block(page, id).locator(':scope > .page-block-gutter > [data-testid="collapse-toggle"]')
const menu = (page: Page) => page.getByRole('menu', { name: 'Block actions' })

/** The page as the backend holds it: live blocks in document order, as `[text, depth]`. */
async function backend(page: Page, pageId: string): Promise<Array<[string, number]>> {
  const { blocks } = await ipc<{
    blocks: Array<{ id: string; parent_id: string; position: number; content: string | null }>
  }>(page, 'load_page_subtree', { rootBlockId: pageId, scope: SCOPE })
  const out: Array<[string, number]> = []
  const walk = (parent: string, depth: number): void => {
    for (const b of blocks
      .filter((x) => x.parent_id === parent)
      .toSorted((x, y) => x.position - y.position)) {
      out.push([b.content ?? '', depth])
      walk(b.id, depth + 1)
    }
  }
  walk(pageId, 0)
  return out
}

/** The document as shown: each block's text and depth, hidden ones included. */
const shown = (page: Page) =>
  page
    .locator(`${EDITOR} [data-page-block]`)
    .evaluateAll((els) =>
      els.map((el) => [
        el.querySelector('.page-block-content')?.textContent ?? '',
        Number(el.getAttribute('data-depth')),
      ]),
    )

/** Put the cursor at the end (or the `start`) of block `index`'s text, and focus the document. */
async function caretAtEnd(page: Page, index: number, start = false): Promise<void> {
  await page.evaluate(
    ({ selector, index: i, start: atStart }) => {
      const { editor } = document.querySelector(selector) as HTMLElement & {
        editor: {
          state: {
            doc: {
              child: (n: number) => { nodeSize: number; firstChild: { content: { size: number } } }
            }
          }
          commands: { setTextSelection: (pos: number) => boolean }
          view: { focus: () => void }
        }
      }
      let pos = 0
      for (let k = 0; k < i; k += 1) pos += editor.state.doc.child(k).nodeSize
      const length = atStart ? 0 : editor.state.doc.child(i).firstChild.content.size
      editor.commands.setTextSelection(pos + 2 + length)
      editor.view.focus()
    },
    { selector: EDITOR, index, start },
  )
  await expect(page.locator(EDITOR)).toBeFocused()
}

async function center(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox()
  if (box === null) throw new Error('no box')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/**
 * Press block `id`'s grip and move the pointer down or up to `y`, `dx` right
 * of where it pressed, in steps past the drag's start distance, as a hand
 * does; released unless `hold`.
 */
async function drag(
  page: Page,
  id: string | undefined,
  y: number,
  { dx = 0, hold = false } = {},
): Promise<void> {
  await block(page, id).hover()
  const from = await center(grip(page, id))
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x, from.y + 12, { steps: 3 })
  await page.mouse.move(from.x + dx, y, { steps: 8 })
  if (!hold) await page.mouse.up()
}

/** How far down the page the lower half of block `id` is. */
async function lowerHalf(page: Page, id: string | undefined): Promise<number> {
  const box = await block(page, id).boundingBox()
  if (box === null) throw new Error('no box')
  return box.y + box.height * 0.75
}

test.describe('page mode gutter (#5691) @editor @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    // A drag's edge scroll, and the fades axe would read colours through.
    await page.emulateMedia({ reducedMotion: 'reduce' })
  })

  test('the grip and chevron sit where block mode’s do, show on hovering their block, and pass axe', async ({
    page,
  }) => {
    const { ids } = await seedRows(page, 'Gutter place', [
      [0, 'parent'],
      [1, 'child'],
    ])
    await openViaPalette(page, 'Gutter place')
    const row = page.locator('[data-testid="sortable-block"]').first()
    await row.hover()
    const blockGrip = await row.getByTestId('drag-handle').boundingBox()
    const blockChevron = await row.getByTestId('collapse-toggle').boundingBox()
    await modeSwitch(page, 'Page').click()
    await expect(page.locator(`${EDITOR} [data-page-block]`)).toHaveCount(2)

    await page.mouse.move(0, 0)
    await expect(grip(page, ids[1])).toHaveCSS('opacity', '0')
    await block(page, ids[0]).hover()
    await expect(grip(page, ids[0])).toHaveCSS('opacity', '1')
    await expect(chevron(page, ids[0])).toHaveCSS('opacity', '1')
    await expect(grip(page, ids[1])).toHaveCSS('opacity', '0')
    await expect(chevron(page, ids[1])).toHaveCount(0)
    expect(await grip(page, ids[0]).boundingBox()).toEqual(blockGrip)
    expect(await chevron(page, ids[0]).boundingBox()).toEqual(blockChevron)

    await page.addScriptTag({ path: axePath })
    const violations = await page.evaluate(async () => {
      const { axe } = window as unknown as {
        axe: { run: (el: Element) => Promise<{ violations: Array<{ id: string }> }> }
      }
      const { violations: found } = await axe.run(document.querySelector('.page-editor') as Element)
      return found.map((v) => v.id)
    })
    expect(violations).toEqual([])
  })

  test('a drag by the grip moves the block with the blocks under it, sideways nests it, and the moves stay', async ({
    page,
  }) => {
    const { pageId, ids } = await seedRows(page, 'Gutter drag', [
      [0, 'alpha'],
      [0, 'beta'],
      [1, 'beta child'],
      [0, 'gamma'],
    ])
    await openInPageMode(page, 'Gutter drag', 4)

    await drag(page, ids[1], await lowerHalf(page, ids[3]), { hold: true })
    await expect(page.getByTestId('page-drop-indicator')).toBeVisible()
    await expect(block(page, ids[2])).toHaveClass(/page-block-dragging/)
    await page.mouse.up()

    await expect(page.getByTestId('page-drop-indicator')).toHaveCount(0)
    // The release's click is the drag's: no block menu opens.
    await expect(menu(page)).toHaveCount(0)
    await expect
      .poll(() => backend(page, pageId))
      .toEqual([
        ['alpha', 0],
        ['gamma', 0],
        ['beta', 0],
        ['beta child', 1],
      ])

    // Two indents right of where it was pressed, where it is: as deep as the block before allows.
    await drag(page, ids[3], await lowerHalf(page, ids[0]), { dx: 72 })
    await expect
      .poll(() => backend(page, pageId))
      .toEqual([
        ['alpha', 0],
        ['gamma', 1],
        ['beta', 0],
        ['beta child', 1],
      ])

    await reopen(page, 'Gutter drag', 4)
    expect(await shown(page)).toEqual([
      ['alpha', 0],
      ['gamma', 1],
      ['beta', 0],
      ['beta child', 1],
    ])
  })

  test('Escape, or the window losing focus, cancels a drag, and the release then moves nothing', async ({
    page,
  }) => {
    const { pageId, ids } = await seedRows(page, 'Gutter cancel', [
      [0, 'one'],
      [0, 'two'],
    ])
    await openInPageMode(page, 'Gutter cancel', 2)

    await drag(page, ids[0], await lowerHalf(page, ids[1]), { hold: true })
    await expect(page.getByTestId('page-drop-indicator')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('page-drop-indicator')).toHaveCount(0)
    await page.mouse.up()

    // Alt+Tab with the button down: the window blurs and no release reaches the page.
    await drag(page, ids[0], await lowerHalf(page, ids[1]), { hold: true })
    await expect(page.getByTestId('page-drop-indicator')).toBeVisible()
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await expect(page.getByTestId('page-drop-indicator')).toHaveCount(0)
    await page.mouse.up()

    await expect(block(page, ids[0])).not.toHaveClass(/page-block-dragging/)
    expect(await shown(page)).toEqual([
      ['one', 0],
      ['two', 0],
    ])
    await reopen(page, 'Gutter cancel', 2)
    expect(await backend(page, pageId)).toEqual([
      ['one', 0],
      ['two', 0],
    ])
  })

  test('the grip and chevron stay shown while the pointer walks to them from the text', async ({
    page,
  }) => {
    const { ids } = await seedRows(page, 'Gutter walk', [
      [0, 'parent'],
      [1, 'child'],
    ])
    await openInPageMode(page, 'Gutter walk', 2)
    await page.mouse.move(0, 0)
    const text = await block(page, ids[0]).locator('.page-block-content').boundingBox()
    const handle = await grip(page, ids[0]).boundingBox()
    if (text === null || handle === null) throw new Error('no box')
    const y = handle.y + handle.height / 2
    await page.mouse.move(text.x + 20, y)
    await expect(grip(page, ids[0])).toHaveCSS('opacity', '1')

    // A few pixels at a time, across the gap between the text and the gutter.
    for (let x = text.x + 20; x >= handle.x + handle.width / 2; x -= 3) {
      await page.mouse.move(x, y)
      await expect(grip(page, ids[0])).toHaveCSS('opacity', '1')
      await expect(chevron(page, ids[0])).toHaveCSS('opacity', '1')
    }
  })

  test('the chevron collapses a block, which block mode then shows collapsed, and the other way round', async ({
    page,
  }) => {
    const { ids } = await seedRows(page, 'Gutter fold', [
      [0, 'parent'],
      [1, 'child'],
      [0, 'after'],
    ])
    await openInPageMode(page, 'Gutter fold', 3)
    await expect(block(page, ids[1])).toBeVisible()

    await block(page, ids[0]).hover()
    await chevron(page, ids[0]).click()

    await expect(block(page, ids[1])).toBeHidden()
    await expect(block(page, ids[2])).toBeVisible()
    await expect(chevron(page, ids[0])).toHaveAttribute('aria-expanded', 'false')
    await reopen(page, 'Gutter fold', 3)
    await expect(block(page, ids[1])).toBeHidden()

    await modeSwitch(page, 'Blocks').click()
    const rows = page.locator('[data-testid="sortable-block"]')
    await expect(rows).toHaveCount(2)
    await rows.first().getByTestId('collapse-toggle').click()
    await expect(rows).toHaveCount(3)

    await modeSwitch(page, 'Page').click()
    await expect(block(page, ids[1])).toBeVisible()
    await expect(chevron(page, ids[0])).toHaveAttribute('aria-expanded', 'true')
  })

  test('Enter at the end of a collapsed block adds the block after what it hides, which stays under it', async ({
    page,
  }) => {
    const { pageId, ids } = await seedRows(page, 'Gutter enter', [
      [0, 'parent'],
      [1, 'child'],
    ])
    await openInPageMode(page, 'Gutter enter', 2)
    await block(page, ids[0]).hover()
    await chevron(page, ids[0]).click()
    await expect(block(page, ids[1])).toBeHidden()

    await caretAtEnd(page, 0)
    await page.keyboard.press('Enter')
    await page.keyboard.type('next')

    await expect
      .poll(() => backend(page, pageId))
      .toEqual([
        ['parent', 0],
        ['child', 1],
        ['next', 0],
      ])
    await expect(block(page, ids[1])).toBeHidden()
  })

  test('Backspace at the start of the block after a collapsed block joins that block, which keeps what it hides', async ({
    page,
  }) => {
    const { pageId, ids } = await seedRows(page, 'Gutter backspace', [
      [0, 'parent'],
      [1, 'child'],
      [0, 'next'],
    ])
    await openInPageMode(page, 'Gutter backspace', 3)
    await block(page, ids[0]).hover()
    await chevron(page, ids[0]).click()
    await expect(block(page, ids[1])).toBeHidden()

    await caretAtEnd(page, 2, true)
    await page.keyboard.press('Backspace')
    // The cursor is where the two texts met.
    await page.keyboard.type('!')

    await expect
      .poll(() => backend(page, pageId))
      .toEqual([
        ['parent!next', 0],
        ['child', 1],
      ])
    await expect(block(page, ids[1])).toBeHidden()
    await expect(chevron(page, ids[0])).toHaveAttribute('aria-expanded', 'false')
  })

  test('a click on the grip opens its block’s menu; on a focused grip Enter does, keys type nothing, and Escape gives it the focus back', async ({
    page,
  }) => {
    const { ids } = await seedRows(page, 'Gutter menu', [
      [0, 'first'],
      [0, 'second'],
    ])
    await openInPageMode(page, 'Gutter menu', 2)

    await block(page, ids[1]).hover()
    await grip(page, ids[1]).click()
    await expect(menu(page)).toBeVisible()
    await menu(page)
      .getByRole('menuitem', { name: /^Copy block reference/ })
      .click()
    await expect.poll(() => readClipboard(page)).toBe(`((${ids[1]}))`)
    await expect(menu(page)).toHaveCount(0)

    await grip(page, ids[1]).focus()
    await expect(grip(page, ids[1])).toBeFocused()
    await page.keyboard.type('x')
    await expect(block(page, ids[1]).locator('.page-block-content')).toHaveText('second')
    await page.keyboard.press('Enter')
    await expect(menu(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(menu(page)).toHaveCount(0)
    await expect(grip(page, ids[1])).toBeFocused()

    // Tab moves on from it, as from any button; the block keeps its depth.
    await page.keyboard.press('Tab')
    await expect(grip(page, ids[1])).not.toBeFocused()
    expect(await shown(page)).toEqual([
      ['first', 0],
      ['second', 0],
    ])
  })

  test('a focused chevron folds on Enter and Space and keeps the focus; Tab and Shift+Tab on it or a grip move the focus, not the cursor’s block', async ({
    page,
  }) => {
    const { ids } = await seedRows(page, 'Gutter keys', [
      [0, 'one'],
      [0, 'two'],
      [1, 'child'],
    ])
    await openInPageMode(page, 'Gutter keys', 3)
    const layout = [
      ['one', 0],
      ['two', 0],
      ['child', 1],
    ]

    await chevron(page, ids[1]).focus()
    await page.keyboard.press('Enter')
    await expect(block(page, ids[2])).toBeHidden()
    await expect(chevron(page, ids[1])).toBeFocused()
    await page.keyboard.press('Space')
    await expect(block(page, ids[2])).toBeVisible()
    await expect(chevron(page, ids[1])).toBeFocused()

    // With the cursor in "two", the editor's Tab would indent it under "one"; with it in
    // "child", Shift+Tab would outdent that.
    await caretAtEnd(page, 1)
    await chevron(page, ids[1]).focus()
    await page.keyboard.press('Tab')
    await expect(grip(page, ids[2])).toBeFocused()
    await caretAtEnd(page, 2)
    await grip(page, ids[2]).focus()
    await page.keyboard.press('Shift+Tab')
    await expect(chevron(page, ids[1])).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(grip(page, ids[1])).toBeFocused()
    await caretAtEnd(page, 1)
    await grip(page, ids[1]).focus()
    await page.keyboard.press('Tab')
    await expect(chevron(page, ids[1])).toBeFocused()
    expect(await shown(page)).toEqual(layout)
  })
})
