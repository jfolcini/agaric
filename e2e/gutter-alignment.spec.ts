/**
 * A block's gutter controls (grip, chevron, task checkbox) centre on the first
 * line of its text, in page mode and in block mode, at every font-size setting,
 * on a task whose text is a page link (with the cursor in it, showing its
 * source, and without), a plain block with blocks under it, and a heading.
 *
 * Block mode's row with the cursor in it is left out: its toolbar sits above
 * the text, inside the block's box, and the controls centre on the box.
 */

import type { Locator, Page } from '@playwright/test'

import { expect, ipc, test, waitForBoot } from './helpers'

const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' }
const EDITOR = '[data-testid="page-mode-editor"]'

interface Rows {
  focused: string
  unfocused: string
  plain: string
  heading: string
}

async function seed(page: Page, title: string): Promise<Rows> {
  const create = async (parentId: string, content: string): Promise<string> =>
    (
      await ipc<{ id: string }>(page, 'create_block', {
        blockType: 'content',
        content,
        parentId,
        index: null,
        scope: SCOPE,
      })
    ).id
  const target = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: 'DX Instance runner',
    spaceId: SCOPE.space_id,
  })
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: title,
    spaceId: SCOPE.space_id,
  })
  const focused = await create(pageId, `[[${target}]]`)
  const unfocused = await create(pageId, `[[${target}]]`)
  const plain = await create(pageId, 'Plain parent')
  await create(plain, 'child')
  const heading = await create(pageId, '## Heading parent')
  await create(heading, 'child')
  for (const blockId of [focused, unfocused]) {
    await ipc(page, 'set_todo_state', { blockId, state: 'TODO' })
  }
  return { focused, unfocused, plain, heading }
}

async function open(page: Page, title: string): Promise<void> {
  await page.keyboard.press('Control+k')
  await page.locator('[cmdk-input]').first().fill(title)
  await page.locator('[cmdk-item]').filter({ hasText: title }).first().waitFor()
  await page.keyboard.press('Enter')
  await expect(page.locator('[aria-label="Page title"]')).toHaveText(title)
}

/**
 * Each control's vertical centre minus the centre of the first line of `row`'s
 * text, in px. Page mode's one grip sits outside the row.
 */
function offsets(row: Locator, mode: 'block' | 'page'): Promise<Record<string, number>> {
  return row.evaluate((el, editingMode) => {
    const middle = (box: DOMRect): number => box.top + box.height / 2
    const text = el.querySelector('.page-block-content, .ProseMirror, [data-testid="block-static"]')
    if (text === null) throw new Error('no text')
    const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
    })
    const first = walker.nextNode()
    if (first === null) throw new Error('no text node')
    const range = document.createRange()
    range.selectNodeContents(first)
    const line = range.getClientRects()[0]
    if (line === undefined) throw new Error('no line box')
    const own = (selector: string): Element | undefined =>
      [...el.querySelectorAll(selector)].find(
        (control) => control.closest('[data-page-block], [data-testid="sortable-block"]') === el,
      )
    const controls: Record<string, Element | null | undefined> = {
      grip:
        editingMode === 'page'
          ? document.querySelector('[data-page-grip] svg')
          : own('[data-testid="drag-handle"] svg'),
      chevron: own('[data-testid="collapse-toggle"] svg'),
      checkbox: own('.task-checkbox'),
    }
    const out: Record<string, number> = {}
    for (const [name, control] of Object.entries(controls)) {
      if (control) out[name] = middle(control.getBoundingClientRect()) - middle(line)
    }
    return out
  }, mode)
}

function expectCentred(found: Record<string, number>, expected: readonly string[]): void {
  expect(Object.keys(found).toSorted()).toEqual([...expected].toSorted())
  for (const [name, offset] of Object.entries(found)) {
    expect(Math.abs(offset), `${name} is ${offset}px off the first line`).toBeLessThanOrEqual(1)
  }
}

for (const size of ['small', 'medium', 'large'] as const) {
  test.describe(`gutter controls centre on the first line, ${size} text @editor @pages`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((s) => localStorage.setItem('agaric-font-size', s), size)
      await waitForBoot(page)
    })

    test('in block mode', async ({ page }) => {
      const rows = await seed(page, `Gutter ${size}`)
      await open(page, `Gutter ${size}`)
      const row = (id: string) =>
        page.locator(`[data-testid="sortable-block"][data-block-id="${id}"]`)
      await expect(page.locator('[data-testid="sortable-block"]')).toHaveCount(6)
      const cases = [
        [rows.unfocused, ['grip', 'checkbox']],
        [rows.plain, ['grip', 'chevron', 'checkbox']],
        [rows.heading, ['grip', 'chevron', 'checkbox']],
      ] as const
      for (const [id, controls] of cases) {
        await row(id).hover()
        expectCentred(await offsets(row(id), 'block'), controls)
      }
    })

    test('in page mode, with the cursor in a link showing its source', async ({ page }) => {
      const rows = await seed(page, `Gutter page ${size}`)
      await open(page, `Gutter page ${size}`)
      await page
        .getByRole('radiogroup', { name: 'Editing mode' })
        .getByRole('radio', { name: 'Page' })
        .click()
      const row = (id: string) => page.locator(`${EDITOR} [data-page-block-id="${id}"]`)
      await expect(page.locator(`${EDITOR} [data-page-block]`)).toHaveCount(6)
      // Into the first block's link, which shows its source.
      await page.evaluate((selector) => {
        const { editor } = document.querySelector(selector) as HTMLElement & {
          editor: { commands: { setTextSelection: (pos: number) => boolean; focus: () => boolean } }
        }
        editor.commands.setTextSelection(3)
        editor.commands.focus()
      }, EDITOR)
      await expect(row(rows.focused)).toContainText('[[')
      const cases = [
        [rows.focused, ['grip', 'checkbox']],
        [rows.unfocused, ['grip', 'checkbox']],
        [rows.plain, ['grip', 'chevron']],
        [rows.heading, ['grip', 'chevron']],
      ] as const
      for (const [id, controls] of cases) {
        await row(id).hover()
        await expect(row(id)).toHaveAttribute('data-page-grip-on', '')
        expectCentred(await offsets(row(id), 'page'), controls)
      }
    })
  })
}
