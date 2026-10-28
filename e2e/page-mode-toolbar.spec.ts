/**
 * Block mode's formatting toolbar in page mode (#5691) against the mock
 * backend: bold, a heading, a block turned from a list into a heading and
 * back, a bulleted and a numbered block across a selection, a task and a
 * table, each read back from the backend, then again after leaving the page
 * and coming back.
 */

import { createRequire } from 'node:module'

import type { Locator, Page } from '@playwright/test'

import { expect, ipc, test, waitForBoot } from './helpers'

const axePath = createRequire(import.meta.url).resolve('axe-core')
const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' }
const EDITOR = '[data-testid="page-mode-editor"]'
const TITLE = 'Toolbar page'

async function seed(
  page: Page,
  texts: readonly string[],
): Promise<{ pageId: string; ids: string[] }> {
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: TITLE,
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
  return { pageId, ids }
}

async function openViaPalette(page: Page, title: string): Promise<void> {
  await page.keyboard.press('Escape')
  // Escape leaves page mode's editor for the box around it; a Ctrl+K in the editor is its link's.
  await expect
    .poll(() => page.evaluate((sel) => document.activeElement?.matches(sel) ?? false, EDITOR))
    .toBe(false)
  await page.keyboard.press('Control+k')
  await page.locator('[cmdk-input]').first().fill(title)
  await page.locator('[cmdk-item]').filter({ hasText: title }).first().waitFor()
  await page.keyboard.press('Enter')
  await expect(page.locator('[aria-label="Page title"]')).toHaveText(title)
  await expect(page.getByTestId('view-transition-wrapper')).toHaveCSS('opacity', '1')
}

/** The live blocks' contents, in order, as the backend holds them. */
async function contents(page: Page, pageId: string): Promise<string[]> {
  const { blocks } = await ipc<{
    blocks: Array<{ parent_id: string; position: number; content: string | null }>
  }>(page, 'load_page_subtree', { rootBlockId: pageId, scope: SCOPE })
  return blocks
    .filter((b) => b.parent_id === pageId)
    .toSorted((x, y) => x.position - y.position)
    .map((b) => b.content ?? '')
}

async function listStyles(page: Page, ids: readonly string[]): Promise<Array<string | null>> {
  return Promise.all(
    ids.map(
      async (blockId) =>
        (
          await ipc<Array<{ key: string; value_text: string | null }>>(page, 'get_properties', {
            blockId,
          })
        ).find((row) => row.key === 'listStyle')?.value_text ?? null,
    ),
  )
}

const todo = async (page: Page, blockId: string): Promise<string | null> =>
  (await ipc<{ todo_state: string | null }>(page, 'get_block', { blockId })).todo_state

/** Select blocks `from` to `to` whole, or put the caret at the end of `from`, and focus the document. */
async function select(page: Page, from: number, to: number | null = null): Promise<void> {
  await page.evaluate(
    ({ selector, from: f, to: t }) => {
      const { editor } = document.querySelector(selector) as HTMLElement & {
        editor: {
          state: { doc: { child: (n: number) => { nodeSize: number; textContent: string } } }
          commands: { setTextSelection: (range: number | { from: number; to: number }) => boolean }
          view: { focus: () => void }
        }
      }
      const start = (i: number) => {
        let pos = 0
        for (let k = 0; k < i; k += 1) pos += editor.state.doc.child(k).nodeSize
        return pos + 2
      }
      const end = (i: number) => start(i) + editor.state.doc.child(i).textContent.length
      editor.commands.setTextSelection(t === null ? end(f) : { from: start(f), to: end(t) })
      editor.view.focus()
    },
    { selector: EDITOR, from, to },
  )
  await expect(page.locator(EDITOR)).toBeFocused()
}

const toolbar = (page: Page): Locator => page.getByTestId('formatting-toolbar')

/** Press a toolbar button, from the bar or, when the bar is narrow, its More menu. */
async function pressButton(page: Page, name: string): Promise<void> {
  const inline = toolbar(page).getByRole('button', { name, exact: true })
  if (await inline.isVisible()) {
    await inline.click()
    return
  }
  await toolbar(page).getByRole('button', { name: 'More', exact: true }).click()
  await page.getByTestId('toolbar-overflow-menu').getByRole('button', { name, exact: true }).click()
}

async function turnInto(page: Page, name: string): Promise<void> {
  await pressButton(page, 'Turn into')
  const menu = page.getByRole('menu', { name: 'Turn into' })
  await menu.getByRole('menuitemradio', { name, exact: true }).click()
  await expect(menu).toBeHidden()
}

async function reopen(page: Page): Promise<void> {
  await openViaPalette(page, 'Getting Started')
  await openViaPalette(page, TITLE)
  await expect(page.locator(`${EDITOR} [data-page-block]`)).toHaveCount(5)
}

test.describe('page mode toolbar (#5691) @editor @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('the formatting toolbar bolds, makes headings, lists, a task and a table that stay, with no axe violations', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const seeded = await seed(page, ['alpha', 'beta', 'gamma', 'delta', 'table'])
    const { pageId } = seeded
    const ids = seeded.ids as [string, string, string, string, string]
    await openViaPalette(page, TITLE)
    await page
      .getByRole('radiogroup', { name: 'Editing mode' })
      .getByRole('radio', { name: 'Page' })
      .click()
    await expect(page.locator(`${EDITOR} [data-page-block]`)).toHaveCount(5)
    await expect(toolbar(page)).toBeVisible()

    await page.addScriptTag({ path: axePath })
    const violations = await page.evaluate(async () => {
      const { axe } = window as unknown as {
        axe: { run: (el: Element) => Promise<{ violations: Array<{ id: string }> }> }
      }
      const found = await axe.run(
        document.querySelector('[data-testid="formatting-toolbar"]') as Element,
      )
      return found.violations.map((v) => v.id)
    })
    expect(violations).toEqual([])
    await expect(toolbar(page).getByRole('button', { name: 'Discard' })).toHaveCount(0)

    // Bold, from the Format menu, on a selected word.
    await select(page, 0, 0)
    await pressButton(page, 'Format')
    await page
      .getByRole('toolbar', { name: 'Format' })
      .getByRole('button', { name: 'Bold' })
      .click()
    await expect.poll(async () => (await contents(page, pageId))[0]).toBe('**alpha**')

    // A heading.
    await select(page, 1)
    await turnInto(page, 'Heading 2')
    await expect.poll(async () => (await contents(page, pageId))[1]).toBe('## beta')

    // A bulleted list on two blocks at once, then the first a heading, then a list again.
    await select(page, 2, 3)
    await turnInto(page, 'Bullet list')
    await expect.poll(() => listStyles(page, [ids[2], ids[3]])).toEqual(['bullet', 'bullet'])
    await select(page, 2)
    await turnInto(page, 'Heading 1')
    await expect.poll(async () => (await contents(page, pageId))[2]).toBe('# gamma')
    await expect.poll(() => listStyles(page, [ids[2]])).toEqual([null])
    await turnInto(page, 'Bullet list')
    await expect.poll(async () => (await contents(page, pageId))[2]).toBe('gamma')
    await expect.poll(() => listStyles(page, [ids[2]])).toEqual(['bullet'])

    // A numbered block.
    await select(page, 3)
    await turnInto(page, 'Ordered list')
    await expect.poll(() => listStyles(page, [ids[3]])).toEqual(['ordered'])

    // A task.
    await select(page, 0)
    await pressButton(page, 'Toggle TODO state')
    await expect.poll(() => todo(page, ids[0])).toBe('TODO')

    // A table.
    await select(page, 4)
    await pressButton(page, 'Insert table')
    await page.getByRole('gridcell', { name: '2 by 2 table' }).click()
    await expect.poll(async () => (await contents(page, pageId))[4]).toContain('|')

    await reopen(page)
    expect(await contents(page, pageId)).toEqual([
      '**alpha**',
      '## beta',
      'gamma',
      'delta',
      'table\n|  |  |\n| --- | --- |\n|  |  |',
    ])
    expect(await listStyles(page, ids)).toEqual([null, null, 'bullet', 'ordered', null])
    expect(await todo(page, ids[0])).toBe('TODO')
    await expect(page.locator(`${EDITOR} [data-page-block-id="${ids[1]}"] h2`)).toHaveText('beta')
    await expect(page.locator(`${EDITOR} [data-page-block-id="${ids[4]}"] table`)).toHaveCount(1)
    await page.screenshot({ path: 'test-results/page-mode-toolbar.png' })
  })
})
