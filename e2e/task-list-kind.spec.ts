import type { Locator, Page } from '@playwright/test'

import { blockRow, runSlashCommand } from './domain'
import { activeMenu, expect, focusBlockById, ipc, saveBlock, test, waitForBoot } from './helpers'

/**
 * A task is a third list kind beside bulleted and numbered (#5691 D3), in
 * block mode and in page mode. A block holding a task state shows its
 * checkbox and no bullet, whatever list style it stores; making a bulleted
 * block a task clears its list style, and making a task bulleted clears its
 * task state. Each mode is checked after navigating away and back, against
 * what the backend holds.
 */

const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' }
const EDITOR = '[data-testid="page-mode-editor"]'
const BULLET = {
  value_text: 'bullet',
  value_num: null,
  value_date: null,
  value_ref: null,
  value_bool: null,
}
const BULLET_LIST = 'BULLET LIST — Insert unordered list'

/**
 * A page of six blocks: two bulleted, one bulleted that is also a task (as an
 * older version or another device can leave one), and three tasks.
 */
async function seed(page: Page, title: string): Promise<string[]> {
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: title,
    spaceId: SCOPE.space_id,
  })
  const ids: string[] = []
  for (const content of ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']) {
    const row = await ipc<{ id: string }>(page, 'create_block', {
      blockType: 'content',
      content,
      parentId: pageId,
      index: null,
      scope: SCOPE,
    })
    ids.push(row.id)
  }
  for (const id of ids.slice(0, 3)) {
    await ipc(page, 'set_property', { blockId: id, key: 'listStyle', value: BULLET })
  }
  for (const id of ids.slice(2)) await ipc(page, 'set_todo_state', { blockId: id, state: 'TODO' })
  return ids
}

async function openViaPalette(page: Page, title: string): Promise<void> {
  await page.keyboard.press('Escape')
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

/** Press a toolbar button, from the bar or, when the bar is narrow, its More menu. */
async function pressButton(page: Page, name: string): Promise<void> {
  const toolbar = page.getByTestId('formatting-toolbar')
  const inline = toolbar.getByRole('button', { name, exact: true })
  if (await inline.isVisible()) {
    await inline.click()
    return
  }
  await toolbar.getByRole('button', { name: 'More', exact: true }).click()
  await page.getByTestId('toolbar-overflow-menu').getByRole('button', { name, exact: true }).click()
}

const listStyles = (page: Page, ids: readonly string[]) =>
  Promise.all(
    ids.map(
      async (blockId) =>
        (
          await ipc<Array<{ key: string; value_text: string | null }>>(page, 'get_properties', {
            blockId,
          })
        ).find((row) => row.key === 'listStyle')?.value_text ?? null,
    ),
  )

const todos = (page: Page, ids: readonly string[]) =>
  Promise.all(
    ids.map(
      async (blockId) =>
        (await ipc<{ todo_state: string | null }>(page, 'get_block', { blockId })).todo_state,
    ),
  )

// A task's checkbox; block mode also draws an empty one on a plain block, named "Set as TODO".
const CHECKBOX = '[data-testid="task-marker"][aria-label^="Task:"]'

/** What each block shows before its text: `☐` for a task's checkbox, its list marker, or nothing. */
async function shown(blocks: Locator[]): Promise<string[]> {
  return Promise.all(
    blocks.map(async (block) => {
      if ((await block.locator(CHECKBOX).count()) > 0) {
        return (await block.locator('.list-marker').count()) > 0 ? '☐•' : '☐'
      }
      const marker = block.locator('.list-marker')
      return (await marker.count()) > 0 ? ((await marker.textContent()) ?? '') : ''
    }),
  )
}

test.describe('a task is a list kind, exclusive with bulleted and numbered @editor @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('block mode: a bullet given a task shows only its checkbox and loses its style; a task made bulleted or numbered loses its state', async ({
    page,
  }) => {
    const title = 'Block task kinds'
    const ids = await seed(page, title)
    const [alpha, , , delta, epsilon, zeta] = ids as [
      string,
      string,
      string,
      string,
      string,
      string,
    ]
    const rows = () => ids.map((id) => blockRow(page, id))
    await openViaPalette(page, title)
    await expect(blockRow(page, zeta)).toBeVisible()
    // The block seeded with both shows only its checkbox.
    await expect.poll(() => shown(rows())).toEqual(['•', '•', '☐', '☐', '☐', '☐'])

    // A bulleted block given a task, with the task key.
    await focusBlockById(page, alpha)
    await page.keyboard.press('Control+Enter')
    await expect.poll(() => shown(rows())).toEqual(['☐', '•', '☐', '☐', '☐', '☐'])
    await saveBlock(page, 'Escape')
    await expect
      .poll(() => listStyles(page, ids))
      .toEqual([null, 'bullet', 'bullet', null, null, null])

    // Tasks made bulleted or numbered: from the slash menu, the toolbar's Turn into and the block menu.
    await focusBlockById(page, delta)
    await runSlashCommand(page, 'bullet', BULLET_LIST)
    await expect(blockRow(page, delta).locator(CHECKBOX)).toHaveCount(0)
    await saveBlock(page, 'Escape')
    await focusBlockById(page, epsilon)
    await pressButton(page, 'Turn into')
    const turnInto = page.getByRole('menu', { name: 'Turn into' })
    await turnInto.getByRole('menuitemradio', { name: 'Ordered list', exact: true }).click()
    await expect(blockRow(page, epsilon).locator(CHECKBOX)).toHaveCount(0)
    await saveBlock(page, 'Escape')
    await page
      .locator(`[data-testid="block-static"][data-block-id="${zeta}"]`)
      .click({ button: 'right' })
    const menu = activeMenu(page)
    await menu.getByRole('menuitem', { name: /Turn into/ }).click()
    await menu.getByRole('menuitem', { name: 'Bullet list', exact: true }).click()
    await expect.poll(() => todos(page, ids)).toEqual(['TODO', null, 'TODO', null, null, null])

    await openViaPalette(page, 'Getting Started')
    await openViaPalette(page, title)
    await expect(blockRow(page, zeta)).toBeVisible()
    await expect.poll(() => shown(rows())).toEqual(['☐', '•', '☐', '•', '1.', '•'])
    expect(await listStyles(page, ids)).toEqual([
      null,
      'bullet',
      'bullet',
      'bullet',
      'ordered',
      'bullet',
    ])
    expect(await todos(page, ids)).toEqual(['TODO', null, 'TODO', null, null, null])
    await page.screenshot({ path: 'test-results/task-list-kind-blocks.png' })
  })

  test('page mode: a bullet given a task shows only its checkbox and loses its style; a task made bulleted or numbered loses its state', async ({
    page,
  }) => {
    const title = 'Page task kinds'
    const ids = await seed(page, title)
    const blocks = () => ids.map((id) => page.locator(`${EDITOR} [data-page-block-id="${id}"]`))
    /** Put the caret at the end of block `index`'s text. */
    const caretAtEnd = (index: number) =>
      page.evaluate(
        ({ selector, i }) => {
          const { editor } = document.querySelector(selector) as HTMLElement & {
            editor: {
              state: { doc: { child: (n: number) => { nodeSize: number } } }
              commands: { setTextSelection: (pos: number) => boolean }
              view: { focus: () => void }
            }
          }
          let pos = 0
          for (let k = 0; k <= i; k += 1) pos += editor.state.doc.child(k).nodeSize
          editor.commands.setTextSelection(pos - 2)
          editor.view.focus()
          return new Promise((resolve) => setTimeout(resolve, 20))
        },
        { selector: EDITOR, i: index },
      )
    const inPageMode = async () => {
      await openViaPalette(page, title)
      await page
        .getByRole('radiogroup', { name: 'Editing mode' })
        .getByRole('radio', { name: 'Page' })
        .click()
      await expect(page.locator(`${EDITOR} [data-page-block]`)).toHaveCount(6)
    }

    await inPageMode()
    // The block seeded with both shows only its checkbox.
    await expect.poll(() => shown(blocks())).toEqual(['•', '•', '☐', '☐', '☐', '☐'])

    // A bulleted block given a task, with the task key.
    await caretAtEnd(0)
    await page.keyboard.press('Control+Enter')
    await expect.poll(() => shown(blocks())).toEqual(['☐', '•', '☐', '☐', '☐', '☐'])
    await expect
      .poll(() => listStyles(page, ids))
      .toEqual([null, 'bullet', 'bullet', null, null, null])
    // And with the toolbar's task button.
    await caretAtEnd(1)
    await pressButton(page, 'Toggle TODO state')
    await expect.poll(() => shown(blocks())).toEqual(['☐', '☐', '☐', '☐', '☐', '☐'])
    await expect.poll(() => listStyles(page, ids)).toEqual([null, null, 'bullet', null, null, null])

    // Tasks made bulleted or numbered: from the toolbar's Turn into and the slash menu.
    await caretAtEnd(3)
    await pressButton(page, 'Turn into')
    const menu = page.getByRole('menu', { name: 'Turn into' })
    await menu.getByRole('menuitemradio', { name: 'Bullet list', exact: true }).click()
    await expect(menu).toBeHidden()
    await caretAtEnd(4)
    await page.keyboard.type(' /numbered', { delay: 30 })
    await page.locator('[data-testid="suggestion-list"] #suggestion-numbered-list').click()
    await expect.poll(() => todos(page, ids)).toEqual(['TODO', 'TODO', 'TODO', null, null, 'TODO'])
    await expect.poll(() => shown(blocks())).toEqual(['☐', '☐', '☐', '•', '1.', '☐'])

    await openViaPalette(page, 'Getting Started')
    await inPageMode()
    await expect.poll(() => shown(blocks())).toEqual(['☐', '☐', '☐', '•', '1.', '☐'])
    expect(await listStyles(page, ids)).toEqual([null, null, 'bullet', 'bullet', 'ordered', null])
    expect(await todos(page, ids)).toEqual(['TODO', 'TODO', 'TODO', null, null, 'TODO'])
    await page.screenshot({ path: 'test-results/task-list-kind-page.png' })
  })
})
